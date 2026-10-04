/**
 * D68 (`docs/todos.md`): a session's todo list, the rules both sides share (the
 * server, the UI, the agent's `switchboard` MCP tools). Pure: no I/O.
 */
import type { SessionTodo, SessionTodoList } from './api.ts';

/** A done item is removed by itself this long after it was marked done (1 hour, ruling D68). */
export const TODO_DONE_TTL_MS = 60 * 60 * 1000;

/** The longest item text (characters, after trimming). */
export const TODO_TEXT_MAX = 1_000;

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

/** `text` trimmed, or why it cannot be an item's text. */
export function checkTodoText(text: unknown): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string } {
  if (typeof text !== 'string') return { ok: false, message: 'text must be a string' };
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, message: 'text must not be empty' };
  if (trimmed.length > TODO_TEXT_MAX) return { ok: false, message: `text must be at most ${TODO_TEXT_MAX} characters` };
  return { ok: true, text: trimmed };
}

/** When a done item goes by itself (`doneAt` + {@link TODO_DONE_TTL_MS}); `null` for an open item. */
export function todoRemoveAt(doneAt: string | null, ttlMs: number = TODO_DONE_TTL_MS): string | null {
  if (doneAt === null) return null;
  const at = Date.parse(doneAt);
  return Number.isFinite(at) ? new Date(at + ttlMs).toISOString() : null;
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

/** One item as the agent's tools print it: `[a1b2c3] ☐ Fix the login test (added by developer)`. */
export function todoLine(todo: SessionTodo): string {
  return `[${todo.id}] ${todo.state === 'done' ? '☑' : '☐'} ${todo.text}${todo.addedBy === 'developer' ? ' (added by the developer)' : ''}`;
}

/** The list as the agent's tools print it (open items first, then done ones). */
export function todoListText(list: SessionTodoList): string {
  const { open, done } = splitTodos(list.todos);
  if (open.length === 0 && done.length === 0) return 'The todo list is empty.';
  const lines = [`Open (${open.length}):`, ...(open.length ? open.map(todoLine) : ['(none)'])];
  if (done.length) lines.push(`Done (${done.length}, removed an hour after done):`, ...done.map(todoLine));
  return lines.join('\n');
}

/** An MCP tool definition (`tools/list`). */
export interface TodoToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

const ID = { type: 'string', description: 'The item id, as todo_list shows it in brackets.' } as const;

/** D68: the tools of the `switchboard` MCP server, scoped to the agent's own session. */
export const TODO_TOOLS: readonly TodoToolDefinition[] = [
  {
    name: 'todo_list',
    description: "List this session's todo list (things that still need doing). Use it when the user asks what is left.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'todo_add',
    description: "Add an item to this session's todo list (when the user says to add something to the todo list).",
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What still needs doing, one short line.' } }, required: ['text'], additionalProperties: false },
  },
  {
    name: 'todo_update',
    description: 'Change the text of an item on the todo list.',
    inputSchema: { type: 'object', properties: { id: ID, text: { type: 'string' } }, required: ['id', 'text'], additionalProperties: false },
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
