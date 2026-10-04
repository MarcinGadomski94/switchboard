/**
 * D68 (`docs/todos.md`): a session's todo list, the rules both sides share (the
 * server, the UI, the agent's `switchboard` MCP tools). D69: each item has a title,
 * a description and a handover plan. D70: the plan is mandatory (`No plan` allowed),
 * and each item has a priority and an estimate. Pure: no I/O.
 */
import type { SessionTodo, SessionTodoList, TodoPriority } from './api.ts';

/** A done item is removed by itself this long after it was marked done (1 hour, ruling D68). */
export const TODO_DONE_TTL_MS = 60 * 60 * 1000;

/** D68: the longest item text; D69: what migration 0027 and a take-over from 1.7.0 may still bring as one text (split by {@link legacyTodoFields}). */
export const TODO_TEXT_MAX = 1_000;

/** D69: the longest title (characters, after trimming; one line). */
export const TODO_TITLE_MAX = 120;

/** D69: the longest description (characters, after trimming). */
export const TODO_DESCRIPTION_MAX = 4_000;

/** D69: the longest handover plan (characters, after trimming). */
export const TODO_PLAN_MAX = 8_000;

/** D70: the priorities, most pressing first (the order open items sort in). */
export const TODO_PRIORITIES: readonly TodoPriority[] = ['urgent', 'high', 'medium', 'low'];

/** D70: a priority's label in the UI. */
export const TODO_PRIORITY_LABELS: Readonly<Record<TodoPriority, string>> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };

/** D70: the priority of an item that was given none (an older caller, migration 0028). */
export const DEFAULT_TODO_PRIORITY: TodoPriority = 'medium';

/** D70: the plan of an item with nothing to plan (migration 0028, an older caller, the UI's prefilled form); an agent adds `: <reason>`. */
export const TODO_NO_PLAN = 'No plan';

/** D70: the longest estimate (minutes: one week). */
export const TODO_ESTIMATE_MAX = 10_080;

/** The most items one session keeps (open and done together): a runaway agent stops here. */
export const TODO_MAX_PER_SESSION = 200;

/** The MCP server name every Switchboard-started session gets (its tools are `mcp__switchboard__todo_*` in Claude Code). */
export const AGENT_MCP_SERVER = 'switchboard';

/** The marker argument of the MCP helper script (`src/hook/sb-mcp.ts --switchboard-mcp <port> <sessionId>`). */
export const AGENT_MCP_MARKER = '--switchboard-mcp';

/** The environment variable that carries the session's agent token to the MCP helper (never on its argv). */
export const AGENT_TOKEN_ENV = 'SWITCHBOARD_TODO_TOKEN';

/** The header that names the session on `/agent/v1/*` (the bearer token must be that session's). */
export const AGENT_SESSION_HEADER = 'x-switchboard-session';

/** A check's answer: the value, or why it cannot be one. */
export type TodoCheck<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/** D69: `title` trimmed (1–120 characters, one line), or why it cannot be an item's title. */
export function checkTodoTitle(title: unknown): TodoCheck<string> {
  if (typeof title !== 'string') return { ok: false, message: 'title must be a string' };
  const trimmed = title.trim();
  if (trimmed === '') return { ok: false, message: 'title must not be empty' };
  if (/[\r\n]/.test(trimmed)) return { ok: false, message: 'title must be one line (put the details in description or plan)' };
  if (trimmed.length > TODO_TITLE_MAX) return { ok: false, message: `title must be at most ${TODO_TITLE_MAX} characters (put the details in description or plan)` };
  return { ok: true, value: trimmed };
}

/**
 * D69: an optional Markdown field (`description`, `plan`) trimmed; `null` for none
 * (`null`, absent or blank), or why it cannot be one.
 */
export function checkTodoNote(value: unknown, field: 'description' | 'plan'): TodoCheck<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, message: `${field} must be a string` };
  const max = field === 'plan' ? TODO_PLAN_MAX : TODO_DESCRIPTION_MAX;
  const trimmed = value.trim();
  if (trimmed.length > max) return { ok: false, message: `${field} must be at most ${max} characters` };
  return { ok: true, value: trimmed === '' ? null : trimmed };
}

/** D70: `true` for one of {@link TODO_PRIORITIES}. */
export function isTodoPriority(value: unknown): value is TodoPriority {
  return typeof value === 'string' && (TODO_PRIORITIES as readonly string[]).includes(value);
}

/** D70: a given priority, or why it cannot be one; `undefined` / `null` = {@link DEFAULT_TODO_PRIORITY}. */
export function checkTodoPriority(value: unknown): TodoCheck<TodoPriority> {
  if (value === undefined || value === null) return { ok: true, value: DEFAULT_TODO_PRIORITY };
  return isTodoPriority(value) ? { ok: true, value } : { ok: false, message: `priority must be one of ${TODO_PRIORITIES.join(', ')}` };
}

/** D70: an estimate in whole minutes (1–{@link TODO_ESTIMATE_MAX}); `undefined` / `null` = not estimated. */
export function checkTodoEstimate(value: unknown): TodoCheck<number | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > TODO_ESTIMATE_MAX) {
    return { ok: false, message: `estimate must be whole minutes from 1 to ${TODO_ESTIMATE_MAX} (how long an AI agent would take)` };
  }
  return { ok: true, value };
}

/** D70: the message of a refused empty plan. */
const PLAN_REQUIRED = `plan must not be empty: write a handover plan, or "${TODO_NO_PLAN}: <one-line reason>"`;

/** D70: the stored plan of a plan as given (`blank` = absent, `null` or only spaces), or why it cannot be one. */
function checkTodoPlan(value: unknown, blank: 'default' | 'refuse'): TodoCheck<string> {
  const note = checkTodoNote(value, 'plan');
  if (!note.ok) return note;
  if (note.value !== null) return { ok: true, value: note.value };
  return blank === 'default' ? { ok: true, value: TODO_NO_PLAN } : { ok: false, message: PLAN_REQUIRED };
}

/**
 * D70: `true` when the plan is a real handover plan, not {@link TODO_NO_PLAN} (or
 * `No plan: <reason>`): the card then offers **▸ Handover plan**, ▶ Start sends it,
 * and `todo_list` says `has plan`.
 */
export function todoHasPlan(plan: string | null | undefined): boolean {
  if (typeof plan !== 'string') return false;
  const trimmed = plan.trim();
  return trimmed !== '' && !/^no plan\b/i.test(trimmed);
}

/** D69 / D70: a new item's fields, checked. */
export interface NewTodoFields {
  readonly title: string;
  readonly description: string | null;
  readonly plan: string;
  readonly priority: TodoPriority;
  readonly estimateMinutes: number | null;
}

/**
 * D69: the fields of a new item (`title`, else its D68 alias `text`; `description`,
 * `plan`), checked. D70: `priority` (absent: medium), `estimateMinutes` (absent: none);
 * an absent or blank plan is {@link TODO_NO_PLAN} (an older client, ruling D70: never a
 * 422 for it; only the agent's tool schema requires one).
 */
export function checkNewTodo(input: Readonly<Record<string, unknown>>): TodoCheck<NewTodoFields> {
  const title = checkTodoTitle(input['title'] ?? input['text']);
  if (!title.ok) return title;
  const description = checkTodoNote(input['description'], 'description');
  if (!description.ok) return description;
  const plan = checkTodoPlan(input['plan'], 'default');
  if (!plan.ok) return plan;
  const priority = checkTodoPriority(input['priority']);
  if (!priority.ok) return priority;
  const estimate = checkTodoEstimate(input['estimateMinutes']);
  if (!estimate.ok) return estimate;
  return { ok: true, value: { title: title.value, description: description.value, plan: plan.value, priority: priority.value, estimateMinutes: estimate.value } };
}

/** D69 / D70: a patch's changed fields. */
export interface TodoPatchFields {
  readonly title?: string;
  readonly description?: string | null;
  readonly plan?: string;
  readonly priority?: TodoPriority;
  readonly estimateMinutes?: number | null;
}

/**
 * D69: a patch's changed fields (each only when given), checked; `{}` when none of
 * them is given. D70: a plan can change but not be emptied; `priority`; `estimateMinutes`
 * (`null` removes it).
 */
export function checkTodoPatch(input: Readonly<Record<string, unknown>>): TodoCheck<TodoPatchFields> {
  const out: { title?: string; description?: string | null; plan?: string; priority?: TodoPriority; estimateMinutes?: number | null } = {};
  const rawTitle = input['title'] ?? input['text'];
  if (rawTitle !== undefined) {
    const title = checkTodoTitle(rawTitle);
    if (!title.ok) return title;
    out.title = title.value;
  }
  if (input['description'] !== undefined) {
    const note = checkTodoNote(input['description'], 'description');
    if (!note.ok) return note;
    out.description = note.value;
  }
  if (input['plan'] !== undefined) {
    const plan = checkTodoPlan(input['plan'], 'refuse');
    if (!plan.ok) return plan;
    out.plan = plan.value;
  }
  if (input['priority'] !== undefined) {
    if (!isTodoPriority(input['priority'])) return { ok: false, message: `priority must be one of ${TODO_PRIORITIES.join(', ')}` };
    out.priority = input['priority'];
  }
  if (input['estimateMinutes'] !== undefined) {
    const estimate = checkTodoEstimate(input['estimateMinutes']);
    if (!estimate.ok) return estimate;
    out.estimateMinutes = estimate.value;
  }
  return { ok: true, value: out };
}

/** D70: a duration in minutes as the UI and the tools show it: `45m`, `2h`, `1h 30m`. */
export function formatTodoMinutes(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** D70: an item's estimate on its card: `~45m`, `~2h`, `~1h 30m`; `''` when it has none. */
export function todoEstimateLabel(minutes: number | null | undefined): string {
  return typeof minutes === 'number' && minutes > 0 ? `~${formatTodoMinutes(minutes)}` : '';
}

/**
 * D70: the total of the open items' known estimates: `~2h 15m`, with a `+` when some
 * open items have none (`~2h 15m+`); `''` when none is known.
 */
export function todoEstimateTotal(todos: readonly Pick<SessionTodo, 'state' | 'estimateMinutes'>[]): string {
  const open = todos.filter((todo) => todo.state === 'open');
  const known = open.filter((todo) => typeof todo.estimateMinutes === 'number' && todo.estimateMinutes > 0);
  if (known.length === 0) return '';
  const total = known.reduce((sum, todo) => sum + (todo.estimateMinutes ?? 0), 0);
  return `~${formatTodoMinutes(total)}${known.length < open.length ? '+' : ''}`;
}

/**
 * D70: the developer's estimate as typed in the form: `45`, `45m`, `2h`, `1h 30m`,
 * `1.5h` (minutes when there is no unit); `''` = none. Answers whole minutes.
 */
export function parseTodoEstimate(text: string): TodoCheck<number | null> {
  const value = text.trim().toLowerCase();
  if (value === '') return { ok: true, value: null };
  const invalid = { ok: false, message: 'Estimate: minutes, e.g. 45, 45m, 2h or 1h 30m' } as const;
  let minutes: number;
  if (/^\d+$/.test(value)) minutes = Number(value);
  else {
    const match = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?$/.exec(value);
    if (!match || (match[1] === undefined && match[2] === undefined)) return invalid;
    minutes = Math.round(Number(match[1] ?? 0) * 60) + Number(match[2] ?? 0);
  }
  const checked = checkTodoEstimate(minutes);
  return checked.ok ? checked : { ok: false, message: `Estimate: from 1 minute to ${TODO_ESTIMATE_MAX / 60 / 24} days (${TODO_ESTIMATE_MAX} minutes)` };
}

/** D70: an estimate back in the form's text: `45m`, `1h 30m`; `''` for none. */
export function todoEstimateInput(minutes: number | null | undefined): string {
  return typeof minutes === 'number' && minutes > 0 ? formatTodoMinutes(minutes) : '';
}

/** D70: a priority's rank (0 = urgent); an unknown one ranks as medium. */
export function todoPriorityRank(priority: unknown): number {
  const at = TODO_PRIORITIES.indexOf(isTodoPriority(priority) ? priority : DEFAULT_TODO_PRIORITY);
  return at;
}

/**
 * D69: a D68 item's single text as the three fields, the way migration 0027 splits
 * it: the first line is the title (cut to {@link TODO_TITLE_MAX} with `…`), and the
 * whole text becomes the description when the title is not all of it. `null` when
 * the text is empty.
 */
export function legacyTodoFields(text: unknown): { readonly title: string; readonly description: string | null } | null {
  if (typeof text !== 'string') return null;
  const whole = text.trim().slice(0, TODO_TEXT_MAX);
  if (whole === '') return null;
  const firstLine = (whole.split('\n', 1)[0] ?? '').trim();
  const title = firstLine.length > TODO_TITLE_MAX ? `${firstLine.slice(0, TODO_TITLE_MAX - 1)}…` : firstLine;
  return { title, description: title === whole ? null : whole };
}

/** When a done item goes by itself (`doneAt` + {@link TODO_DONE_TTL_MS}); `null` for an open item. */
export function todoRemoveAt(doneAt: string | null, ttlMs: number = TODO_DONE_TTL_MS): string | null {
  if (doneAt === null) return null;
  const at = Date.parse(doneAt);
  return Number.isFinite(at) ? new Date(at + ttlMs).toISOString() : null;
}

/** D69: a done item's countdown on its card: `removed in 42m` (minutes rounded up), `removed soon` once due. */
export function todoRemovalLabel(removeAt: string | null, now: number): string {
  if (!removeAt) return '';
  const ms = Date.parse(removeAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'removed soon';
  const minutes = Math.ceil(ms / 60_000);
  return minutes <= 60 ? `removed in ${minutes}m` : `removed in ${Math.ceil(minutes / 60)}h`;
}

/**
 * The open and done items of a list. D70: the open ones by priority (urgent first),
 * the manual order (position) within a level; the done ones in list order.
 */
export function splitTodos(todos: readonly SessionTodo[]): { readonly open: SessionTodo[]; readonly done: SessionTodo[] } {
  const sorted = [...todos].sort((a, b) => a.position - b.position);
  const open = sorted.filter((t) => t.state === 'open').sort((a, b) => todoPriorityRank(a.priority) - todoPriorityRank(b.priority) || a.position - b.position);
  return { open, done: sorted.filter((t) => t.state === 'done') };
}

/**
 * D70: the items an item moves among with Move up / down: the open items of its
 * priority (open ones sort by priority, so a move never crosses a level), or the
 * done ones; in the order shown.
 */
export function todoMoveScope(all: readonly SessionTodo[], todo: Pick<SessionTodo, 'state' | 'priority'>): SessionTodo[] {
  const { open, done } = splitTodos(all);
  if (todo.state === 'done') return done;
  const rank = todoPriorityRank(todo.priority);
  return open.filter((t) => todoPriorityRank(t.priority) === rank);
}

/**
 * `ids` moved one step up (`-1`) or down (`1`) around `id`, among its scope
 * ({@link todoMoveScope}: D70, the open items of its priority, or the done ones):
 * the item swaps with its neighbour in that scope; the rest keeps its place.
 * `null` when it cannot move (at the edge of its level).
 */
export function moveTodo(all: readonly SessionTodo[], id: string, step: -1 | 1): string[] | null {
  const sorted = [...all].sort((a, b) => a.position - b.position);
  const item = sorted.find((t) => t.id === id);
  if (!item) return null;
  const scope = todoMoveScope(all, item);
  const at = scope.findIndex((t) => t.id === id);
  const other = scope[at + step];
  if (!other) return null;
  const ids = sorted.map((t) => t.id);
  const i = ids.indexOf(item.id);
  const j = ids.indexOf(other.id);
  ids[i] = other.id;
  ids[j] = item.id;
  return ids;
}

/**
 * One item as the agent's tools print it, compact (D69: the title only, and which of
 * description / plan it has, not their text, to save context; D70: its priority and
 * estimate, `~?` when it has none; `has plan` only for a real plan, not `No plan`):
 * `[a1b2c3] ☐ HIGH ~45m Fix the login test (added by the developer) · has description, plan`.
 */
export function todoLine(todo: SessionTodo): string {
  const title = todo.title ?? todo.text;
  const has = [todo.description ? 'description' : null, todoHasPlan(todo.plan) ? 'plan' : null].filter((part) => part !== null);
  const priority = (isTodoPriority(todo.priority) ? todo.priority : DEFAULT_TODO_PRIORITY).toUpperCase();
  const estimate = todoEstimateLabel(todo.estimateMinutes) || '~?';
  return `[${todo.id}] ${todo.state === 'done' ? '☑' : '☐'} ${priority} ${estimate} ${title}${todo.addedBy === 'developer' ? ' (added by the developer)' : ''}${has.length ? ` · has ${has.join(', ')}` : ''}`;
}

/** The list as the agent's tools print it (open items first, by priority (D70), then done ones). */
export function todoListText(list: SessionTodoList): string {
  const { open, done } = splitTodos(list.todos);
  if (open.length === 0 && done.length === 0) return 'The todo list is empty.';
  const lines = [`Open (${open.length}):`, ...(open.length ? open.map(todoLine) : ['(none)'])];
  if (done.length) lines.push(`Done (${done.length}, removed an hour after done):`, ...done.map(todoLine));
  if ([...open, ...done].some((todo) => todo.description || todo.plan)) lines.push('(todo_get shows an item\'s description and plan.)');
  return lines.join('\n');
}

/** D69: one item in full, as `todo_get` prints it: its line, then (D70) its priority and estimate, its description and its plan. */
export function todoDetailText(todo: SessionTodo): string {
  const title = todo.title ?? todo.text;
  const estimate = todoEstimateLabel(todo.estimateMinutes);
  const lines = [
    `[${todo.id}] ${todo.state === 'done' ? '☑ done' : '☐ open'} · added by the ${todo.addedBy === 'agent' ? 'agent' : 'developer'}`,
    `Title: ${title}`,
    `Priority: ${TODO_PRIORITY_LABELS[isTodoPriority(todo.priority) ? todo.priority : DEFAULT_TODO_PRIORITY]}`,
    `Estimate: ${estimate ? `${estimate} (${todo.estimateMinutes} minutes for an AI agent)` : '(none)'}`,
    '',
    'Description:',
    todo.description ?? '(none)',
    '',
    'Plan:',
    todo.plan || TODO_NO_PLAN,
  ];
  return lines.join('\n');
}

/**
 * D69 · ▶ Start: the message that puts an agent on an item (filled into the
 * composer, never sent by itself): `Work on todo [<id>]: <title>`, a blank line,
 * then the plan (else the description; nothing when it has neither). D70: `No plan`
 * counts as none ({@link todoHasPlan}).
 */
export function todoStartMessage(todo: Pick<SessionTodo, 'id' | 'title' | 'description'> & { readonly plan: string | null }): string {
  const head = `Work on todo [${todo.id}]: ${todo.title}`;
  const body = todoHasPlan(todo.plan) ? todo.plan : todo.description;
  return body ? `${head}\n\n${body}` : head;
}

/**
 * D69: the composer's text after ▶ Start: the start message when the draft is
 * empty; else the draft is kept and the message added after a blank line (a draft
 * is never replaced).
 */
export function composerWithStart(draft: string, message: string): string {
  return draft.trim() === '' ? message : `${draft.replace(/\s+$/, '')}\n\n${message}`;
}

/** An MCP tool definition (`tools/list`). */
export interface TodoToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

const ID = { type: 'string', description: 'The item id, as todo_list shows it in brackets.' } as const;

const TITLE = { type: 'string', description: 'One short line naming the work (at most 120 characters), e.g. "Fix the login test flake".' } as const;

const DESCRIPTION = {
  type: 'string',
  description: 'For the developer: a plain, brief explanation (one to three sentences, Markdown) of what and why. Optional; an empty string removes it.',
} as const;

const PLAN = {
  type: 'string',
  description:
    'Required. The handover plan for an AI agent who picks this item up later WITHOUT this conversation (Markdown): the context and what was decided, the relevant files, the steps, and the acceptance criteria. Self-contained. When there is nothing to plan, write "No plan: <one-line reason>". It cannot be emptied.',
} as const;

const PRIORITY = {
  type: 'string',
  enum: ['urgent', 'high', 'medium', 'low'],
  description:
    'urgent = blocking or breaking now (production down, data loss, blocks other work); high = important, should be done next; medium = a normal task; low = nice-to-have or cleanup. Revise it with todo_update when you learn more.',
} as const;

const ESTIMATE = {
  type: 'integer',
  minimum: 1,
  maximum: TODO_ESTIMATE_MAX,
  description: 'Your rough estimate, in minutes, of how long an AI agent (not a human) would take to do this item: development time. Rough is fine (e.g. 15, 45, 120). Revise it with todo_update when you learn more.',
} as const;

/**
 * D68 / D69: the tools of the `switchboard` MCP server, scoped to the agent's own
 * session. Each item has a title, a description (for the developer) and a plan
 * (the handover for an AI agent); `todo_list` stays compact, `todo_get` gives the rest.
 * D70: `todo_add` requires the plan (`No plan: <reason>` allowed), a priority and an
 * estimate (minutes for an AI agent); `todo_update` revises them.
 */
export const TODO_TOOLS: readonly TodoToolDefinition[] = [
  {
    name: 'todo_list',
    description:
      "List this session's todo list (things that still need doing), open items by priority: each item's id, state, priority, estimate and title, and whether it has a description or plan (not their text; use todo_get for that). Use it when the user asks what is left.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'todo_get',
    description: 'Read one item in full: its title, priority, estimate, description and handover plan. Use it before you start working on an item.',
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'todo_add',
    description:
      "Add an item to this session's todo list (when the user says to add something to the todo list). Fill it from the conversation: the title, a short description for the developer, a handover plan for an agent who will pick it up later without this conversation (or \"No plan: <reason>\"), a priority and your estimate in minutes.",
    inputSchema: {
      type: 'object',
      properties: { title: TITLE, description: DESCRIPTION, plan: PLAN, priority: PRIORITY, estimate_minutes: ESTIMATE },
      required: ['title', 'plan', 'priority', 'estimate_minutes'],
      additionalProperties: false,
    },
  },
  {
    name: 'todo_update',
    description:
      'Change an item: its title, description, plan, priority and / or estimate (only the fields you give change; an empty description removes it; the plan cannot be emptied). Revise the priority and estimate when you learn more.',
    inputSchema: {
      type: 'object',
      properties: { id: ID, title: TITLE, description: DESCRIPTION, plan: { ...PLAN, description: PLAN.description.replace('Required. ', '') }, priority: PRIORITY, estimate_minutes: ESTIMATE },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'todo_done',
    description: 'Mark an item on the todo list done once it is finished (done: false reopens it).',
    inputSchema: { type: 'object', properties: { id: ID, done: { type: 'boolean', description: 'false reopens the item; default true.' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'todo_remove',
    description: 'Remove an item from the todo list (when it is no longer needed at all).',
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'], additionalProperties: false },
  },
];

/** D69 / D70: the `switchboard` MCP server's `instructions` (for CLIs that pass them on to the model). */
export const AGENT_MCP_INSTRUCTIONS =
  "This session's todo list in Switchboard. Each item has a title (one short line), a description (for the developer: plain and brief), a plan (a handover for an AI agent who picks the item up later without this conversation: context, relevant files, steps, acceptance criteria; \"No plan: <reason>\" when there is nothing to plan), a priority (urgent = blocking or breaking now; high = should be next; medium = normal; low = nice-to-have or cleanup) and an estimate (minutes an AI agent would take). When the user asks to add something to the todo list, use todo_add and fill all of them from the conversation; revise the priority and estimate with todo_update when you learn more. Use todo_list when asked what is left, todo_get to read an item in full before working on it, and todo_done when an item is finished.";
