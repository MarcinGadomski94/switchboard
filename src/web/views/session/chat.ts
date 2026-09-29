import { withoutSessionStartBlock } from '../../../core/first-turn.ts';
import type { Agent, Question, SessionEvent } from '../../../core/api.ts';
import { isAsyncAgentLaunch } from '../../../core/derive/background.ts';
import { AGENT_TOOLS } from '../../../core/derive/event-kind.ts';
import type {
  AgentPromptPayload,
  AssistantPayload,
  ModelPayload,
  QueuedReason,
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
  /**
   * D36: on an Agent / Task call, the id of the subagent it started when that
   * subagent has a chat to open ({@link hasSubagentChat}): the step line links to it.
   */
  readonly subagentId?: string;
}

/** What the chat shows, top to bottom. */
export type ChatItem =
  /**
   * A user bubble (right): typed here, the task, "Continue.", a service note or a
   * terminal prompt; D36, in a subagent's chat, a later prompt the main agent sent
   * it (origin `agent-prompt`).
   */
  | {
      readonly kind: 'user';
      readonly key: string;
      readonly id: number;
      readonly text: string;
      readonly origin: string;
      /** `false` until the CLI echoed the line (`isReplay`). */
      readonly delivered: boolean;
      /** D44: why the message still waits for the agent (the bubble shows a clock); `null` once taken up, and for messages that never waited. */
      readonly queued: QueuedReason | null;
    }
  /** Agent text (left) with the step lines that followed it; `text` is empty when the turn started with a tool. */
  | { readonly kind: 'agent'; readonly key: string; readonly id: number; readonly text: string; readonly steps: readonly ChatStep[] }
  /** A question batch: the inline card while it waits, else the answers bubble. */
  | { readonly kind: 'questions'; readonly key: string; readonly batchId: string; readonly questions: readonly Question[]; readonly waiting: boolean };

/**
 * D44: the clock's tooltip on a message the agent has not taken up yet
 * (`docs/decisions.md` → D44): written while a turn ran, or sent while the
 * session had no live process.
 */
export const QUEUED_TOOLTIPS: Readonly<Record<QueuedReason, string>> = {
  turn: 'Queued: the agent reads it after its current turn',
  resume: 'Queued: sent when the session resumes',
};

/** D44: why a batch's answers still wait (in the session's outbox), `null` when they do not. */
export function batchQueued(questions: readonly Question[]): QueuedReason | null {
  return questions.find((question) => question.queued)?.queued ?? null;
}

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
    case 'model':
      // D31: the model / effort changed ("Model: Opus 5.5 · effort: high"), or the CLI refused the change.
      return (payload as ModelPayload).action === 'failed' ? '✕' : '✓';
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
 * D33: nor does a batch closed with its session (`closedReason`).
 */
export function batchWaiting(questions: readonly Pick<Question, 'answeredAt' | 'answeredOn' | 'closedReason'>[]): boolean {
  if (questions.some((question) => question.answeredOn || question.closedReason)) return false;
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

/** What {@link conversationItems} does beyond the main chat's rules. */
interface ConversationOptions {
  /** D36: Agent / Task call ids → the subagent whose chat that call's step line opens. */
  readonly chats: ReadonlyMap<string, string>;
  /** Batches with no AskUserQuestion call among the events: last (the main chat) or left out (a subagent's chat, D36). */
  readonly trailingBatches: boolean;
  /** D36: a subagent's prompt lines (`agent-prompt`) are user bubbles (its chat); the main chat has none. */
  readonly prompts: boolean;
}

/**
 * D36: `true` when a subagent has a chat to open: a subagent started by an
 * Agent / Task call Switchboard saw (its `toolUseId`); the main agent and agents
 * seen without one (the demo's; a Workflow's never appear) have none.
 */
export function hasSubagentChat(agent: Pick<Agent, 'kind' | 'toolUseId'>): boolean {
  return agent.kind === 'subagent' && typeof agent.toolUseId === 'string' && agent.toolUseId !== '';
}

/** D36: Agent / Task call ids → the subagents that have a chat to open (keyed by the call that started them). */
export function subagentChats(agents: readonly Pick<Agent, 'id' | 'kind' | 'toolUseId'>[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const agent of agents) if (hasSubagentChat(agent) && agent.toolUseId) out.set(agent.toolUseId, agent.id);
  return out;
}

/** The Agent / Task call payload of an event, `null` for any other event. */
function agentCall(event: SessionEvent): ToolPayload | null {
  const payload = payloadOf(event);
  if (payload?.type !== 'tool') return null;
  const tool = payload as ToolPayload;
  return AGENT_TOOLS.includes(tool.name) ? tool : null;
}

/** Items of an already filtered and sorted conversation (the rules of {@link chatItems}). */
function conversationItems(sorted: readonly SessionEvent[], questions: readonly Question[], options: ConversationOptions): ChatItem[] {
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
    const call = agentCall(event);
    const subagentId = call ? options.chats.get(call.toolUseId) : undefined;
    block.steps.push({ id: event.id, mark, label: stepLabel(event), ...(subagentId ? { subagentId } : {}) });
  };

  for (const event of sorted) {
    const payload = payloadOf(event);
    const type = payload?.type;
    if (type === 'user') {
      const user = payload as UserPayload;
      out.push({
        kind: 'user',
        key: `u:${event.id}`,
        id: event.id,
        text: withoutSessionStartBlock(user.text),
        origin: user.origin,
        delivered: user.delivered,
        queued: user.queued ?? null,
      });
      block = null;
    } else if (type === 'agent-prompt' && options.prompts) {
      out.push({ kind: 'user', key: `u:${event.id}`, id: event.id, text: (payload as AgentPromptPayload).text, origin: 'agent-prompt', delivered: true, queued: null });
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
  if (options.trailingBatches) for (const [batchId, list] of grouped) if (!placed.has(batchId)) pushBatch(batchId, list);
  return out;
}

/**
 * The chat's items (`docs/chat.md`):
 * - only the main conversation: events of the main agent (or of no agent); a
 *   subagent's own lines belong to its agent card, the timeline and (D36) its own
 *   chat ({@link subagentChat});
 * - in time order (`ts`, then id);
 * - user messages → user bubbles; assistant text → an agent block; tool calls,
 *   permission requests, automatic denials, failed turns and a permission-mode
 *   mismatch → step lines under the agent block before them (a block without
 *   text when the turn started with a tool); D36: an Agent / Task call whose
 *   subagent has a chat (`agents`, {@link hasSubagentChat}) carries its id, so its
 *   step line opens that chat;
 * - an AskUserQuestion call → its question batch (by `requestId` = batch id) at
 *   that place: the card while it waits, else the answers bubble; batches without
 *   a matching event in `events` go at the end, in batch order.
 */
export function chatItems(
  events: readonly SessionEvent[],
  questions: readonly Question[],
  mainAgentId: string | null,
  agents: readonly Pick<Agent, 'id' | 'kind' | 'toolUseId'>[] = [],
): ChatItem[] {
  const main = [...events].filter((event) => mainAgentId === null || event.agentId === null || event.agentId === mainAgentId).sort(byTime);
  return conversationItems(main, questions, { chats: subagentChats(agents), trailingBatches: true, prompts: false });
}

/** D36: a subagent's result: the text its Agent / Task call returned to the main agent. */
export interface SubagentResult {
  readonly text: string;
  /** The call's `tool_result` was an error (e.g. interrupted). */
  readonly isError: boolean;
}

/** D36: what a subagent's own chat shows (`docs/chat.md` → *Subagent chats*). */
export interface SubagentChat {
  /**
   * The brief the main agent gave it: the `prompt` of the Agent / Task call that
   * started it, else its first prompt line (`agent-prompt`); `null` when neither
   * was seen.
   */
  readonly brief: string | null;
  /** Its messages, tool steps and question batches, by the main chat's rules (its batches only where it asked them). */
  readonly items: readonly ChatItem[];
  /**
   * Its result: the call's `tool_result` text once it arrived; `null` before, and
   * for an agent that runs in the background, whose call returns only the CLI's
   * launch notice (`isAsyncAgentLaunch`).
   */
  readonly result: SubagentResult | null;
}

/**
 * D36: a subagent's own chat from the session's events (filtered here: the chat
 * already loads them all, `GET /api/sessions/{id}/events`):
 * - the brief (see {@link SubagentChat.brief});
 * - its own events (`agentId` = the subagent's id) as the main chat shows them,
 *   except its first prompt line, which is the brief delivered; later prompt lines
 *   are user bubbles; its question batches sit at their calls, and batches it did
 *   not ask are not its; a nested Agent call links to that subagent's chat;
 * - the result (see {@link SubagentChat.result}).
 */
export function subagentChat(
  events: readonly SessionEvent[],
  questions: readonly Question[],
  agent: Pick<Agent, 'id' | 'toolUseId'>,
  agents: readonly Pick<Agent, 'id' | 'kind' | 'toolUseId'>[] = [],
): SubagentChat {
  const call = agent.toolUseId ? (events.map(agentCall).find((tool) => tool !== null && tool.toolUseId === agent.toolUseId) ?? null) : null;
  const own = events.filter((event) => event.agentId === agent.id).sort(byTime);
  const firstPrompt = own.find((event) => payloadOf(event)?.type === 'agent-prompt') ?? null;
  const prompt = call && typeof call.input['prompt'] === 'string' && call.input['prompt'] !== '' ? call.input['prompt'] : null;
  const brief = prompt ?? (firstPrompt ? (firstPrompt.payload as AgentPromptPayload).text : null);
  const items = conversationItems(
    own.filter((event) => event !== firstPrompt),
    questions,
    { chats: subagentChats(agents), trailingBatches: false, prompts: true },
  );
  const result = call && call.result !== undefined && !isAsyncAgentLaunch(call.result) ? { text: call.result, isError: call.isError === true } : null;
  return { brief, items, result };
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
/**
 * What a key press in the composer does (D26): Enter sends; Shift+Enter inserts
 * a line break (the field's own behaviour); Enter while an IME is composing does
 * neither (it confirms the composition). Every other key: `null`.
 */
export function composerKeyAction(event: { readonly key: string; readonly shiftKey: boolean; readonly isComposing: boolean }): 'send' | 'newline' | null {
  if (event.key !== 'Enter' || event.isComposing) return null;
  return event.shiftKey ? 'newline' : 'send';
}

/** The composer grows with its text up to this many lines, then scrolls (D26). */
export const COMPOSER_MAX_LINES = 8;

export function draftToSend(draft: string): string | null {
  const text = draft.trim();
  return text === '' ? null : text;
}
