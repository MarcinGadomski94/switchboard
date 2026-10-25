/**
 * D131 · lane S · the v2 chat's rows (`docs/design/v2-prototype.html` → *E. Chat
 * text space*). Pure: it turns the classic chat model's items (`chatItems` of
 * `views/session/chat.ts`, the same rules as the classic chat) into what the
 * document-style chat draws:
 *
 * - agent text → a **reply** (no bubble; a compact "Agent · reply N · time" line),
 *   consecutive replies of one turn grouped (the later ones `cont`, no line);
 * - the developer's messages → slim **you** pills (consecutive ones grouped);
 * - each run of tool steps → one collapsed **activity** row
 *   ("● Ran tests · 0:42 ✓") holding its lines;
 * - Agent / Task calls → a collapsed **helpers** thread ("3 helpers finished");
 * - a question batch → its answer slot (`inbox:<batchId>`);
 * - dividers (a switch of engine or account, a revert, "Continued from…") and
 *   **time gaps** of more than {@link GAP_MS}.
 *
 * Unit-tested in `tests/web/v2-agent.test.ts`; no DOM here.
 */
import type { Agent, Attachment, Question } from '../../../core/api.ts';
import type { QueuedReason, UserLoopMark } from '../../../core/event-payload.ts';
import type { ChatItem, ChatStep, StepMark } from '../../views/session/chat.ts';
import type { CutRef } from '../../views/session/full-text.ts';

/** A pause of more than this between two rows draws a time divider. */
export const GAP_MS = 45 * 60_000;

/** A reply this soon after the previous one of the same turn joins its group. */
export const GROUP_MS = 10 * 60_000;

/** How an activity row ended (its icon and colour). */
export type ActivityMark = 'ok' | 'bad' | 'running' | 'waiting' | 'stopped' | 'warn';

/** One line inside an expanded activity row. */
export interface ActivityLineItem {
  readonly id: number;
  readonly mark: StepMark;
  readonly label: string;
}

/** A helper started from the chat (an Agent / Task call). */
export interface HelperRef {
  /** The step's event id (the call). */
  readonly id: number;
  /** The helper's agent id when it has a chat to open; `null` otherwise. */
  readonly agentId: string | null;
  readonly name: string;
  /** `working` while its call has no result, `done` / `failed` after. */
  readonly state: 'working' | 'done' | 'failed';
  /** What the helper was asked (its description), `null` when unknown. */
  readonly detail: string | null;
}

/** What the v2 chat draws, top to bottom. */
export type ChatRow =
  | {
      readonly kind: 'you';
      readonly key: string;
      /** The event id (negative for a message on its way, D114). */
      readonly id: number;
      readonly text: string;
      readonly origin: string;
      readonly attachments: readonly Attachment[];
      readonly delivered: boolean;
      readonly queued: QueuedReason | null;
      readonly notSent: boolean;
      readonly heldNote: string | null;
      readonly loop: UserLoopMark | null;
      readonly cut: CutRef | null;
      readonly time: string | null;
      /** When (epoch ms), `null` when unknown. */
      readonly at: number | null;
      /** Follows another of the developer's messages (no "You · time" line). */
      readonly cont: boolean;
    }
  | {
      readonly kind: 'reply';
      readonly key: string;
      readonly id: number;
      readonly text: string;
      readonly cut: CutRef | null;
      /** The reply's number in this chat (a group shares its first reply's number). */
      readonly n: number;
      readonly time: string | null;
      readonly at: number | null;
      /** Part of the reply group above (no "Agent · reply N" line). */
      readonly cont: boolean;
      /** A progress note (D96). */
      readonly note: boolean;
      /** It holds a fenced code block (the ⋯ menu's Copy code). */
      readonly hasCode: boolean;
      /** The developer's message that started this turn (Undo from here reverts to before it); `null` when none is loaded. */
      readonly turnEventId: number | null;
    }
  | {
      readonly kind: 'activity';
      readonly key: string;
      readonly id: number;
      readonly summary: string;
      readonly mark: ActivityMark;
      /** `0:42` from the first step's start to the last step's end, `null` while unknown or running. */
      readonly duration: string | null;
      readonly lines: readonly ActivityLineItem[];
    }
  | {
      readonly kind: 'helpers';
      readonly key: string;
      readonly id: number;
      readonly helpers: readonly HelperRef[];
      readonly summary: string;
      readonly working: number;
    }
  | { readonly kind: 'questions'; readonly key: string; readonly batchId: string; readonly questions: readonly Question[]; readonly waiting: boolean }
  | {
      readonly kind: 'divider';
      readonly key: string;
      readonly id: number;
      readonly text: string;
      readonly linkedSessionId: string | null;
      readonly revert: 'reverted' | 'undone' | null;
    }
  | { readonly kind: 'gap'; readonly key: string; readonly text: string }
  /** Results (artifacts) the agent saved, as file attachments at the time they were saved. */
  | { readonly kind: 'results'; readonly key: string; readonly results: readonly ResultRef[] };

/** A result shown as an attachment in the chat. */
export interface ResultRef {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  /** "Markdown · v3". */
  readonly meta: string;
  readonly createdAt: string;
}

/** What {@link chatRows} needs besides the items. */
export interface ChatRowsInput {
  readonly items: readonly ChatItem[];
  /** Event id → its time (ISO) and end (ISO or `null`), for the reply lines, gaps and durations. */
  readonly times: ReadonlyMap<number, { readonly ts: string; readonly endTs: string | null }>;
  /** The session's agents (the helpers' names and states). */
  readonly agents: readonly Pick<Agent, 'id' | 'kind' | 'name' | 'description' | 'status' | 'toolUseId'>[];
  /** Messages on their way (D114) carry no time: they count as now. */
  readonly now: number;
  /** The clock format (tests pass a fixed one). */
  readonly clock?: (iso: string) => string;
  /** The gap divider's words (tests pass a fixed one). */
  readonly gapText?: (fromMs: number, toMs: number) => string;
}

/** `13:05` in the browser's locale (24 h unless it says otherwise). */
export function defaultClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** A gap's words: "2 hours later · 16:42", or the day when it changed ("Thursday 23 Oct · 09:10"). */
export function defaultGapText(fromMs: number, toMs: number): string {
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const time = to.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (from.toDateString() !== to.toDateString()) return `${to.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })} · ${time}`;
  return `${laterText(toMs - fromMs)} · ${time}`;
}

/** "45 minutes later", "2 hours later". */
export function laterText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minutes later`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'An hour later' : `${hours} hours later`;
}

/** `0:42`, `12:05`, `1:02:03`. */
export function durationText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** `true` when Markdown text holds a fenced code block. */
export function hasCodeBlock(text: string): boolean {
  return /(^|\n)\s{0,3}(```|~~~)/.test(text);
}

/** The fenced code blocks of Markdown text, in order (their bodies). */
export function codeBlocks(text: string): string[] {
  const out: string[] = [];
  const lines = text.split('\n');
  let fence: string | null = null;
  let body: string[] = [];
  for (const line of lines) {
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (match?.[1]) {
        fence = match[1];
        body = [];
      }
    } else if (match?.[1] && match[1][0] === fence[0] && match[1].length >= fence.length && line.trim() === match[1]) {
      out.push(body.join('\n'));
      fence = null;
    } else {
      body.push(line);
    }
  }
  if (fence !== null) out.push(body.join('\n'));
  return out;
}

/** Plain text of a reply for Copy (Markdown kept as written: it is what the agent wrote). */
export function replyCopyText(text: string): string {
  return text.trim();
}

/** The tool a step line names (`Bash · npm test` → `Bash`). */
export function stepTool(label: string): string {
  const cut = label.indexOf(' · ');
  return (cut < 0 ? label : label.slice(0, cut)).trim();
}

/** The detail of a step line (`Bash · npm test` → `npm test`), `''` without one. */
export function stepDetail(label: string): string {
  const cut = label.indexOf(' · ');
  return cut < 0 ? '' : label.slice(cut + 3).trim();
}

const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'apply_patch', 'ApplyPatch']);
const RUN_TOOLS = new Set(['Bash', 'BashOutput', 'shell', 'Shell', 'exec_command']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'LS', 'ToolSearch']);
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);
/** Agent / Task calls start helpers (`core/derive/event-kind.ts` → `AGENT_TOOLS`). */
export const HELPER_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A command's words: `npm test` → `Ran npm test`; a test command reads "Ran tests". */
function runText(detail: string): string {
  if (/\b(test|tests|vitest|jest|playwright|pytest|dotnet test|go test|cargo test)\b/i.test(detail)) return 'Ran tests';
  if (/\b(build|tsc|vite build|dotnet build|cargo build|make)\b/i.test(detail)) return 'Built the code';
  const short = detail.length > 48 ? `${detail.slice(0, 47)}…` : detail;
  return short ? `Ran ${short}` : 'Ran a command';
}

/**
 * The one-line words of a run of tool steps (the prototype's "Read 6 files",
 * "Ran tests"): one step names what it did; several are counted by kind, in the
 * order they first appear ("Read 4 files · edited 2 files · ran 3 commands").
 */
export function activitySummary(labels: readonly string[]): string {
  if (labels.length === 0) return '';
  if (labels.length === 1) {
    const label = labels[0] ?? '';
    const tool = stepTool(label);
    const detail = stepDetail(label);
    if (READ_TOOLS.has(tool)) return detail ? `Read ${detail}` : 'Read a file';
    if (EDIT_TOOLS.has(tool)) return detail ? `Edited ${detail}` : 'Edited a file';
    if (RUN_TOOLS.has(tool)) return runText(detail);
    if (SEARCH_TOOLS.has(tool)) return detail ? `Searched for ${detail}` : 'Searched the code';
    if (WEB_TOOLS.has(tool)) return detail ? `Looked up ${detail}` : 'Looked something up';
    return label;
  }
  const counts = new Map<string, number>();
  const order: string[] = [];
  const bump = (key: string): void => {
    if (!counts.has(key)) order.push(key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  let tests = false;
  for (const label of labels) {
    const tool = stepTool(label);
    if (READ_TOOLS.has(tool)) bump('read');
    else if (EDIT_TOOLS.has(tool)) bump('edit');
    else if (RUN_TOOLS.has(tool)) {
      bump('run');
      if (runText(stepDetail(label)) === 'Ran tests') tests = true;
    } else if (SEARCH_TOOLS.has(tool)) bump('search');
    else if (WEB_TOOLS.has(tool)) bump('web');
    else bump(`other:${tool}`);
  }
  const parts = order.map((key) => {
    const n = counts.get(key) ?? 0;
    switch (key) {
      case 'read':
        return `read ${plural(n, 'file', 'files')}`;
      case 'edit':
        return `edited ${plural(n, 'file', 'files')}`;
      case 'run':
        return tests ? (n === 1 ? 'ran tests' : `ran ${plural(n, 'command', 'commands')} (tests too)`) : `ran ${plural(n, 'command', 'commands')}`;
      case 'search':
        return `searched ${plural(n, 'time', 'times')}`;
      case 'web':
        return `looked up ${plural(n, 'page', 'pages')}`;
      default:
        return n === 1 ? `used ${key.slice(6)}` : `used ${key.slice(6)} ${n} times`;
    }
  });
  const text = parts.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** How a run of steps ended: a failure wins, then a running step, a wait, a stop, a notice. */
export function activityMark(marks: readonly StepMark[]): ActivityMark {
  if (marks.includes('✕')) return 'bad';
  if (marks.includes('●')) return 'running';
  if (marks.includes('⏸')) return 'waiting';
  if (marks.includes('■')) return 'stopped';
  if (marks.includes('⚠')) return 'warn';
  return 'ok';
}

/** `true` for a step line that started a helper. */
export function isHelperStep(step: ChatStep): boolean {
  return step.subagentId !== undefined || HELPER_TOOLS.has(stepTool(step.label));
}

function helperOf(step: ChatStep, agents: ChatRowsInput['agents']): HelperRef {
  const agent = step.subagentId ? agents.find((a) => a.id === step.subagentId) : undefined;
  const detail = stepDetail(step.label) || null;
  const state: HelperRef['state'] = step.mark === '✕' ? 'failed' : step.mark === '●' || step.mark === '⏸' ? 'working' : 'done';
  const live = agent ? (agent.status === 'run' || agent.status === 'need' ? 'working' : agent.status === 'fail' ? 'failed' : state) : state;
  return { id: step.id, agentId: step.subagentId ?? null, name: agent?.description || agent?.name || detail || 'Helper', state: live, detail: agent?.description ?? detail };
}

/** The helpers thread's words: "3 helpers finished" / "3 helpers · 1 still working". */
export function helpersSummary(helpers: readonly HelperRef[]): string {
  const working = helpers.filter((h) => h.state === 'working').length;
  if (working === 0) return `${helpers.length} helper${helpers.length === 1 ? '' : 's'} finished`;
  return `${helpers.length} helper${helpers.length === 1 ? '' : 's'} · ${working} still working`;
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * The v2 chat's rows for the classic chat items (see the module's rules). Rows
 * keep the items' order; `times` gives each event its time.
 */
export function chatRows(input: ChatRowsInput): ChatRow[] {
  const clock = input.clock ?? defaultClock;
  const gapText = input.gapText ?? defaultGapText;
  const out: ChatRow[] = [];
  let replyN = 0;
  let lastTurn: number | null = null;
  /** The previous drawn row's sender and time (for grouping and gaps). */
  let prevSender: 'you' | 'agent' | null = null;
  let prevAt: number | null = null;
  let lastReplyAt: number | null = null;
  /** A user message came since the last reply (a new turn). */
  let newTurn = true;

  const timeOf = (id: number): number | null => (id < 0 ? input.now : ms(input.times.get(id)?.ts));
  const gap = (at: number | null): void => {
    if (at !== null && prevAt !== null && at - prevAt > GAP_MS) {
      out.push({ kind: 'gap', key: `g:${at}`, text: gapText(prevAt, at) });
      prevSender = null;
    }
    if (at !== null) prevAt = at;
  };

  const pushSteps = (item: Extract<ChatItem, { kind: 'agent' }>): void => {
    let run: ChatStep[] = [];
    let helpers: ChatStep[] = [];
    const flushRun = (): void => {
      if (run.length === 0) return;
      const first = run[0] as ChatStep;
      const starts = run.map((s) => ms(input.times.get(s.id)?.ts)).filter((t): t is number => t !== null);
      const ends = run.map((s) => ms(input.times.get(s.id)?.endTs)).filter((t): t is number => t !== null);
      const mark = activityMark(run.map((s) => s.mark));
      const span = starts.length > 0 && ends.length > 0 ? Math.max(...ends) - Math.min(...starts) : 0;
      const duration = mark !== 'running' && span >= 1000 ? durationText(span) : null;
      out.push({ kind: 'activity', key: `act:${first.id}`, id: first.id, summary: activitySummary(run.map((s) => s.label)), mark, duration, lines: run.map((s) => ({ id: s.id, mark: s.mark, label: s.label })) });
      run = [];
    };
    const flushHelpers = (): void => {
      if (helpers.length === 0) return;
      const refs = helpers.map((s) => helperOf(s, input.agents));
      const first = helpers[0] as ChatStep;
      out.push({ kind: 'helpers', key: `hlp:${first.id}`, id: first.id, helpers: refs, summary: helpersSummary(refs), working: refs.filter((h) => h.state === 'working').length });
      helpers = [];
    };
    for (const step of item.steps) {
      if (isHelperStep(step)) {
        flushRun();
        helpers.push(step);
      } else {
        flushHelpers();
        run.push(step);
      }
    }
    flushRun();
    flushHelpers();
  };

  for (const item of input.items) {
    if (item.kind === 'user') {
      const at = timeOf(item.id);
      gap(at);
      const cont = prevSender === 'you';
      out.push({
        kind: 'you',
        key: item.key,
        id: item.id,
        text: item.text,
        origin: item.origin,
        attachments: item.attachments,
        delivered: item.delivered,
        queued: item.queued,
        notSent: item.notSent === true,
        heldNote: item.heldNote ?? null,
        loop: item.loop ?? null,
        cut: item.cut,
        time: at === null ? null : item.id < 0 ? null : clock(new Date(at).toISOString()),
        at,
        cont,
      });
      prevSender = 'you';
      // A message the agent took up starts a turn (a queued or held one has not yet).
      if (item.id > 0 && !item.queued) {
        lastTurn = item.id;
        newTurn = true;
      }
      continue;
    }
    if (item.kind === 'agent') {
      if (item.text !== '') {
        const at = timeOf(item.id);
        gap(at);
        const cont = !newTurn && prevSender === 'agent' && lastReplyAt !== null && at !== null && at - lastReplyAt <= GROUP_MS;
        if (!cont) replyN += 1;
        out.push({
          kind: 'reply',
          key: item.key,
          id: item.id,
          text: item.text,
          cut: item.cut,
          n: replyN,
          time: at === null ? null : clock(new Date(at).toISOString()),
          at,
          cont,
          note: item.note === true,
          hasCode: hasCodeBlock(item.text),
          turnEventId: lastTurn,
        });
        prevSender = 'agent';
        newTurn = false;
        if (at !== null) lastReplyAt = at;
      } else if (item.steps.length > 0) {
        gap(timeOf(item.steps[0]?.id ?? item.id));
      }
      pushSteps(item);
      continue;
    }
    if (item.kind === 'questions') {
      out.push({ kind: 'questions', key: item.key, batchId: item.batchId, questions: item.questions, waiting: item.waiting });
      prevSender = null;
      continue;
    }
    const at = timeOf(item.id);
    if (at !== null) prevAt = at;
    out.push({ kind: 'divider', key: item.key, id: item.id, text: item.text, linkedSessionId: item.linkedSessionId ?? null, revert: item.revert ?? null });
    prevSender = null;
  }
  return out;
}

/** The ids of the replies after (and including) `id`, for "Undo from here" words. */
export function repliesFrom(rows: readonly ChatRow[], id: number): number {
  const at = rows.findIndex((row) => row.kind === 'reply' && row.id === id);
  if (at < 0) return 0;
  return rows.slice(at).filter((row) => row.kind === 'reply' && !row.cont).length;
}

/** The questions of the chat's waiting batches, by batch id (the in-chat answer slots). */
export function waitingBatches(rows: readonly ChatRow[]): string[] {
  return rows.flatMap((row) => (row.kind === 'questions' && row.waiting ? [row.batchId] : []));
}

/** The time a row happened (epoch ms), `null` for rows without one. */
function rowAt(row: ChatRow): number | null {
  return row.kind === 'you' || row.kind === 'reply' ? row.at : null;
}

/**
 * The agent's results placed in the chat as attachments (the prototype's `files`
 * rows): each after the last message from before it was first saved; results
 * older than everything loaded go first, newer than everything last. Results
 * saved together (no message between) share one row.
 */
export function placeResults(rows: readonly ChatRow[], results: readonly ResultRef[]): ChatRow[] {
  if (results.length === 0) return [...rows];
  const sorted = [...results].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const slots = new Map<number, ResultRef[]>();
  for (const result of sorted) {
    const at = Date.parse(result.createdAt);
    let index = -1;
    rows.forEach((row, i) => {
      const t = rowAt(row);
      if (t !== null && t <= at) index = i;
    });
    const list = slots.get(index) ?? [];
    list.push(result);
    slots.set(index, list);
  }
  const out: ChatRow[] = [];
  const push = (index: number): void => {
    const list = slots.get(index);
    if (list) out.push({ kind: 'results', key: `res:${list.map((r) => r.id).join(',')}`, results: list });
  };
  push(-1);
  rows.forEach((row, i) => {
    out.push(row);
    push(i);
  });
  return out;
}

/** "Markdown · v3" for a result's attachment. */
export function resultMeta(kind: string, versions: number): string {
  const label = kind === 'csv' ? 'Table' : kind === 'svg' || kind === 'mermaid' ? 'Diagram' : kind.charAt(0).toUpperCase() + kind.slice(1);
  return `${label} · v${versions}`;
}
