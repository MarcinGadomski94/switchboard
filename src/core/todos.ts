/**
 * D68 (`docs/todos.md`): a session's todo list, the rules both sides share (the
 * server, the UI, the agent's `switchboard` MCP tools). D69: each item has a title,
 * a description and a handover plan. Pure: no I/O.
 */
import type { SessionTodo, SessionTodoList } from './api.ts';

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

/** D69: the fields of a new item (`title`, else its D68 alias `text`; `description`, `plan`), checked. */
export function checkNewTodo(input: Readonly<Record<string, unknown>>): TodoCheck<{ readonly title: string; readonly description: string | null; readonly plan: string | null }> {
  const title = checkTodoTitle(input['title'] ?? input['text']);
  if (!title.ok) return title;
  const description = checkTodoNote(input['description'], 'description');
  if (!description.ok) return description;
  const plan = checkTodoNote(input['plan'], 'plan');
  if (!plan.ok) return plan;
  return { ok: true, value: { title: title.value, description: description.value, plan: plan.value } };
}

/** D69: a patch's changed fields (each only when given), checked; `{}` when none of them is given. */
export function checkTodoPatch(input: Readonly<Record<string, unknown>>): TodoCheck<{ readonly title?: string; readonly description?: string | null; readonly plan?: string | null }> {
  const out: { title?: string; description?: string | null; plan?: string | null } = {};
  const rawTitle = input['title'] ?? input['text'];
  if (rawTitle !== undefined) {
    const title = checkTodoTitle(rawTitle);
    if (!title.ok) return title;
    out.title = title.value;
  }
  for (const field of ['description', 'plan'] as const) {
    if (input[field] === undefined) continue;
    const note = checkTodoNote(input[field], field);
    if (!note.ok) return note;
    out[field] = note.value;
  }
  return { ok: true, value: out };
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

/** The open and done items of a list, each in list order. */
export function splitTodos(todos: readonly SessionTodo[]): { readonly open: SessionTodo[]; readonly done: SessionTodo[] } {
  const sorted = [...todos].sort((a, b) => a.position - b.position);
  return { open: sorted.filter((t) => t.state === 'open'), done: sorted.filter((t) => t.state === 'done') };
}

/**
 * `ids` moved one step up (`-1`) or down (`1`) around `id`, among `scope` (the
 * open items, or the done ones): the item swaps with its neighbour in that scope;
 * the rest keeps its place. `null` when it cannot move.
 */
export function moveTodo(all: readonly SessionTodo[], id: string, step: -1 | 1): string[] | null {
  const sorted = [...all].sort((a, b) => a.position - b.position);
  const item = sorted.find((t) => t.id === id);
  if (!item) return null;
  const scope = sorted.filter((t) => t.state === item.state);
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
 * description / plan it has, not their text, to save context):
 * `[a1b2c3] ☐ Fix the login test (added by the developer) · has description, plan`.
 */
export function todoLine(todo: SessionTodo): string {
  const title = todo.title ?? todo.text;
  const has = [todo.description ? 'description' : null, todo.plan ? 'plan' : null].filter((part) => part !== null);
  return `[${todo.id}] ${todo.state === 'done' ? '☑' : '☐'} ${title}${todo.addedBy === 'developer' ? ' (added by the developer)' : ''}${has.length ? ` · has ${has.join(', ')}` : ''}`;
}

/** The list as the agent's tools print it (open items first, then done ones). */
export function todoListText(list: SessionTodoList): string {
  const { open, done } = splitTodos(list.todos);
  if (open.length === 0 && done.length === 0) return 'The todo list is empty.';
  const lines = [`Open (${open.length}):`, ...(open.length ? open.map(todoLine) : ['(none)'])];
  if (done.length) lines.push(`Done (${done.length}, removed an hour after done):`, ...done.map(todoLine));
  if ([...open, ...done].some((todo) => todo.description || todo.plan)) lines.push('(todo_get shows an item\'s description and plan.)');
  return lines.join('\n');
}

/** D69: one item in full, as `todo_get` prints it: its line, then its description and its plan. */
export function todoDetailText(todo: SessionTodo): string {
  const title = todo.title ?? todo.text;
  const lines = [
    `[${todo.id}] ${todo.state === 'done' ? '☑ done' : '☐ open'} · added by the ${todo.addedBy === 'agent' ? 'agent' : 'developer'}`,
    `Title: ${title}`,
    '',
    'Description:',
    todo.description ?? '(none)',
    '',
    'Plan:',
    todo.plan ?? '(none)',
  ];
  return lines.join('\n');
}

/**
 * D69 · ▶ Start: the message that puts an agent on an item (filled into the
 * composer, never sent by itself): `Work on todo [<id>]: <title>`, a blank line,
 * then the plan (else the description; nothing when it has neither).
 */
export function todoStartMessage(todo: Pick<SessionTodo, 'id' | 'title' | 'description' | 'plan'>): string {
  const head = `Work on todo [${todo.id}]: ${todo.title}`;
  const body = todo.plan ?? todo.description;
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
    'The handover plan for an AI agent who picks this item up later WITHOUT this conversation (Markdown): the context and what was decided, the relevant files, the steps, and the acceptance criteria. Self-contained. Optional; an empty string removes it.',
} as const;

/**
 * D68 / D69: the tools of the `switchboard` MCP server, scoped to the agent's own
 * session. Each item has a title, a description (for the developer) and a plan
 * (the handover for an AI agent); `todo_list` stays compact, `todo_get` gives the rest.
 */
export const TODO_TOOLS: readonly TodoToolDefinition[] = [
  {
    name: 'todo_list',
    description: "List this session's todo list (things that still need doing): each item's id, state and title, and whether it has a description or plan (not their text; use todo_get for that). Use it when the user asks what is left.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'todo_get',
    description: 'Read one item in full: its title, description and handover plan. Use it before you start working on an item.',
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'todo_add',
    description:
      "Add an item to this session's todo list (when the user says to add something to the todo list). Fill all three fields from the conversation: the title always, a short description for the developer, and a handover plan for an agent who will pick it up later without this conversation.",
    inputSchema: { type: 'object', properties: { title: TITLE, description: DESCRIPTION, plan: PLAN }, required: ['title'], additionalProperties: false },
  },
  {
    name: 'todo_update',
    description: 'Change an item: its title, description and / or plan (only the fields you give change; an empty description or plan removes it).',
    inputSchema: { type: 'object', properties: { id: ID, title: TITLE, description: DESCRIPTION, plan: PLAN }, required: ['id'], additionalProperties: false },
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

/** D69: the `switchboard` MCP server's `instructions` (for CLIs that pass them on to the model). */
export const AGENT_MCP_INSTRUCTIONS =
  "This session's todo list in Switchboard. Each item has a title (one short line), a description (for the developer: plain and brief) and a plan (a handover for an AI agent who picks the item up later without this conversation: context, relevant files, steps, acceptance criteria). When the user asks to add something to the todo list, use todo_add and fill all three from the conversation. Use todo_list when asked what is left, todo_get to read an item's description and plan before working on it, and todo_done when an item is finished.";
