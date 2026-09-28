import { withoutSessionStartBlock } from '../../../core/first-turn.ts';
import type { Question, SessionEvent } from '../../../core/api.ts';
import type {
  AssistantPayload,
  RemotePayload,
  RequestPayload,
  ResultPayload,
  ToolPayload,
  UserPayload,
} from '../../../core/event-payload.ts';

/**
 * The chat tab's content from the session's events and questions (SPEC → Session →
 * Chat; prototype `vSession` chat markup + `msgs` / `card()` / `ssAnswered` /
 * `quick` / `sendDraft`), kept free of React so it can be unit-tested. The rules
 * are in `docs/chat.md`.
 */

/** A message of the main conversation (M4.1; the tab now renders {@link chatItems}). */
export interface ChatMessage {
  /** The event id. */
  readonly id: number;
  readonly role: 'user' | 'agent';
  readonly text: string;
  /** For user messages: where it came from (`task`, `user`, `resume`, `service`, `terminal`). */
  readonly origin: string | null;
  readonly ts: string;
}

function payloadOf(event: SessionEvent): { type?: unknown } | null {
  return event.payload && typeof event.payload === 'object' ? (event.payload as { type?: unknown }) : null;
}

/** Events in time order: `ts`, then id (imported terminal turns carry the transcript's older timestamps, M4.1). */
function byTime(a: SessionEvent, b: SessionEvent): number {
  return a.ts === b.ts ? a.id - b.id : a.ts < b.ts ? -1 : 1;
}

/** Messages of the main conversation (subagent prompts and other events are not messages). */
export function chatMessages(events: readonly SessionEvent[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const event of events) {
    const payload = payloadOf(event);
    if (payload?.type === 'user') {
      const user = payload as UserPayload;
      out.push({ id: event.id, role: 'user', text: withoutSessionStartBlock(user.text), origin: user.origin, ts: event.ts });
    } else if (payload?.type === 'assistant') {
      out.push({ id: event.id, role: 'agent', text: (payload as AssistantPayload).text, origin: null, ts: event.ts });
    }
  }
  return out.sort((a, b) => (a.ts === b.ts ? a.id - b.id : a.ts < b.ts ? -1 : 1));
}

/** `events` with `event` added, or replaced when an event with its id is already there (merged text, closed tool). */
export function upsertEvent(events: readonly SessionEvent[], event: SessionEvent): SessionEvent[] {
  const at = events.findIndex((e) => e.id === event.id);
  if (at < 0) return [...events, event];
  const next = [...events];
  next[at] = event;
  return next;
}

/**
 * The mark in front of a step line (the prototype's tool lines): `✓` finished,
 * `●` still running, `✕` failed / denied, `⏸` waiting on the developer.
 */
export type StepMark = '✓' | '●' | '✕' | '⏸' | '⚠';

/** One mono step line under an agent message. */
export interface ChatStep {
  /** The event id. */
  readonly id: number;
  readonly mark: StepMark;
  /** The event's one-line label (`Write · out.txt`, `Bash · npm test`, `Permission · …`). */
  readonly label: string;
}

/** What the chat shows, top to bottom. */
export type ChatItem =
  /** A user bubble (right): typed here, the task, "Continue.", a service note or a terminal prompt. */
  | {
      readonly kind: 'user';
      readonly key: string;
      readonly id: number;
      readonly text: string;
      readonly origin: string;
      /** `false` until the CLI echoed the line (`isReplay`). */
      readonly delivered: boolean;
    }
  /** Agent text (left) with the step lines that followed it; `text` is empty when the turn started with a tool. */
  | { readonly kind: 'agent'; readonly key: string; readonly id: number; readonly text: string; readonly steps: readonly ChatStep[] }
  /** A question batch: the inline card while it waits, else the answers bubble. */
  | { readonly kind: 'questions'; readonly key: string; readonly batchId: string; readonly questions: readonly Question[]; readonly waiting: boolean };

/** The mark of a step event, `null` for an event that is not a step line. */
export function stepMark(event: SessionEvent): StepMark | null {
  const payload = payloadOf(event);
  switch (payload?.type) {
    case 'tool': {
      const tool = payload as ToolPayload;
      if (tool.isError) return '✕';
      if (tool.result !== undefined || event.endTs !== null) return '✓';
      if (tool.requestState === 'open') return '⏸';
      return '●';
    }
    case 'request': {
      const request = payload as RequestPayload;
      if (request.state === 'open') return '⏸';
      // D24: the phone answered it first (Remote Control).
      if (request.answeredOn) return '✓';
      return request.state === 'responded' && request.behavior === 'allow' ? '✓' : '✕';
    }
    case 'remote':
      // D24: Remote Control turned on / off, or a remote_control request failed.
      return (payload as RemotePayload).action === 'failed' ? '✕' : '✓';
    case 'denied':
      return '✕';
    case 'mode-mismatch':
      // D6: Switchboard's own switch to the fallback mode is a notice (⚠, like the terminal tail); a real mismatch is ✕.
      return (payload as { fallback?: string }).fallback ? '⚠' : '✕';
    case 'result':
      return (payload as ResultPayload).isError ? '✕' : null;
    default:
      return null;
  }
}

/**
 * `true` while a batch waits for the developer: some question has no answer yet
 * (open or stale; M3.1). D24: a batch answered on claude.ai (`answeredOn`) waits no more.
 */
export function batchWaiting(questions: readonly Pick<Question, 'answeredAt' | 'answeredOn'>[]): boolean {
  if (questions.some((question) => question.answeredOn)) return false;
  return questions.some((question) => question.answeredAt === null);
}

/** D24: what the answers bubble says for a batch the phone answered first (Remote Control). */
export function answeredOnText(answeredOn: string): string {
  return `Answered on ${answeredOn}`;
}

/**
 * A step line's label: the event's, plus ` · answered on claude.ai` for a
 * permission request the phone answered first (D24).
 */
export function stepLabel(event: SessionEvent): string {
  const payload = payloadOf(event) as Partial<RequestPayload> | null;
  return payload?.type === 'request' && payload.answeredOn ? `${event.label} · answered on ${payload.answeredOn}` : event.label;
}

/** Questions grouped by batch, in the order the batches first appear. */
function batches(questions: readonly Question[]): Map<string, Question[]> {
  const out = new Map<string, Question[]>();
  for (const question of questions) {
    const list = out.get(question.batchId);
    if (list) list.push(question);
    else out.set(question.batchId, [question]);
  }
  return out;
}

/**
 * The chat's items (`docs/chat.md`):
 * - only the main conversation: events of the main agent (or of no agent); a
 *   subagent's own lines belong to its agent card and the timeline;
 * - in time order (`ts`, then id);
 * - user messages → user bubbles; assistant text → an agent block; tool calls,
 *   permission requests, automatic denials, failed turns and a permission-mode
 *   mismatch → step lines under the agent block before them (a block without
 *   text when the turn started with a tool);
 * - an AskUserQuestion call → its question batch (by `requestId` = batch id) at
 *   that place: the card while it waits, else the answers bubble; batches without
 *   a matching event in `events` go at the end, in batch order.
 */
export function chatItems(events: readonly SessionEvent[], questions: readonly Question[], mainAgentId: string | null): ChatItem[] {
  const grouped = batches(questions);
  const placed = new Set<string>();
  const out: ChatItem[] = [];
  let block: { kind: 'agent'; key: string; id: number; text: string; steps: ChatStep[] } | null = null;

  const pushBatch = (batchId: string, list: readonly Question[]): void => {
    placed.add(batchId);
    out.push({ kind: 'questions', key: `q:${batchId}`, batchId, questions: list, waiting: batchWaiting(list) });
    block = null;
  };
  const pushStep = (event: SessionEvent, mark: StepMark): void => {
    if (!block) {
      block = { kind: 'agent', key: `a:${event.id}`, id: event.id, text: '', steps: [] };
      out.push(block);
    }
    block.steps.push({ id: event.id, mark, label: stepLabel(event) });
  };

  const main = [...events].filter((event) => mainAgentId === null || event.agentId === null || event.agentId === mainAgentId).sort(byTime);
  for (const event of main) {
    const payload = payloadOf(event);
    const type = payload?.type;
    if (type === 'user') {
      const user = payload as UserPayload;
      out.push({ kind: 'user', key: `u:${event.id}`, id: event.id, text: withoutSessionStartBlock(user.text), origin: user.origin, delivered: user.delivered });
      block = null;
    } else if (type === 'assistant') {
      block = { kind: 'agent', key: `a:${event.id}`, id: event.id, text: (payload as AssistantPayload).text, steps: [] };
      out.push(block);
    } else if (type === 'tool' && (payload as ToolPayload).name === 'AskUserQuestion') {
      const requestId = (payload as ToolPayload).requestId;
      const list = requestId === undefined ? undefined : grouped.get(requestId);
      if (requestId !== undefined && list && !placed.has(requestId)) pushBatch(requestId, list);
      else if (!list) {
        // No batch behind it (not asked yet, or an input the pipeline could not read, M3.1): a plain step line.
        const mark = stepMark(event);
        if (mark) pushStep(event, mark);
      }
    } else if (type === 'lifecycle') {
      block = null;
    } else {
      const mark = stepMark(event);
      if (mark) pushStep(event, mark);
      if (type === 'result') block = null;
    }
  }
  for (const [batchId, list] of grouped) if (!placed.has(batchId)) pushBatch(batchId, list);
  return out;
}

/** The line under an answered batch's bubble (prototype `ssAnswered`, SPEC → Session → Chat). */
export const ANSWERS_WRITTEN = '● Answers written into the briefs. Blocked agents are resuming…';

/** The composer's placeholder (prototype `draftPh`); `sessionName` is what the session is shown as (D22: its title, else its name). */
export function composerPlaceholder(sessionName: string): string {
  return `Message ${sessionName}…`;
}

/** Label of the quick-reply row (prototype). */
export const QUICK_REPLIES_LABEL = 'Quick replies';

/** A quick reply: the pill's label and the text it puts in the composer (it does not send). */
export interface QuickReply {
  readonly label: string;
  readonly text: string;
}

/** The quick replies, labels and texts verbatim from the prototype (`quickDef` / `quick`). */
export const QUICK_REPLIES: readonly QuickReply[] = [
  { label: 'Accept recommended', text: 'Accept recommended: feature-building · single-solution · UI-first · sequential' },
  { label: 'Match Figma exactly', text: "Match the Figma frame exactly; don't add variants." },
  { label: 'Stop and ask designer', text: 'Stop and park this until the designer confirms.' },
  { label: 'Commit when green', text: "Commit once all checks are green. Stage only this feature's files." },
];

/** The text `POST /messages` sends for a draft, `null` when there is nothing to send (prototype `sendDraft`: trimmed, empty ignored). */
export function draftToSend(draft: string): string | null {
  const text = draft.trim();
  return text === '' ? null : text;
}
