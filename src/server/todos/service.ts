import type { SessionTodo, SessionTodoList, TodoAuthor, TodoGroup, TodoState } from '../../core/api.ts';
import {
  DEFAULT_TODO_PRIORITY,
  TODO_DESCRIPTION_MAX,
  TODO_DONE_TTL_MS,
  TODO_MAX_PER_SESSION,
  TODO_NO_PLAN,
  TODO_PLAN_MAX,
  checkNewTodo,
  checkTodoEstimate,
  checkTodoNote,
  checkTodoPatch,
  checkTodoTitle,
  isTodoPriority,
  legacyTodoFields,
  todoRemoveAt,
} from '../../core/todos.ts';
import type { TodoFields, TodoRecord } from '../db/repos/todos.ts';
import type { Store } from '../db/store.ts';
import { StoreError } from '../db/table.ts';
import type { HubBus } from '../hub/bus.ts';

/** Why the service refused a call: maps to the HTTP status of the route. */
export class TodoError extends Error {
  override name = 'TodoError';
  readonly status: 404 | 409 | 422;
  readonly code: 'not-found' | 'too-many' | 'invalid';
  constructor(status: 404 | 409 | 422, code: 'not-found' | 'too-many' | 'invalid', message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Options for {@link TodoService}. */
export interface TodoServiceOptions {
  readonly store: Store;
  readonly bus: HubBus;
  /** Publishes the session's `sessionUpdated` (its `openTodoCount`: the sidebar badge); none in tests that do not need it. */
  readonly announce?: (sessionId: string) => Promise<void>;
  /** Clock (tests pass a fake one). */
  readonly now?: () => number;
  /** How long a done item stays ({@link TODO_DONE_TTL_MS}). */
  readonly doneTtlMs?: number;
  readonly onError?: (error: unknown) => void;
}

/** The API shape of a stored item. */
export function toTodo(record: TodoRecord, ttlMs: number = TODO_DONE_TTL_MS): SessionTodo {
  return {
    id: record.id,
    sessionId: record.sessionId,
    title: record.title,
    description: record.description,
    // D70: never empty (0028 filled the old ones; a row written outside the service reads as No plan).
    plan: record.plan && record.plan.trim() !== '' ? record.plan : TODO_NO_PLAN,
    priority: isTodoPriority(record.priority) ? record.priority : DEFAULT_TODO_PRIORITY,
    estimateMinutes: record.estimateMinutes ?? null,
    // D69: the D68 name, for a peer still on 1.7.0.
    text: record.title,
    state: record.state,
    addedBy: record.addedBy,
    position: record.position,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    doneAt: record.doneAt,
    removeAt: todoRemoveAt(record.doneAt, ttlMs),
  };
}

/**
 * D69: a taken-over item's fields: its title, description and plan when the source
 * sent them (1.8 and later), else its D68 text split like migration 0027
 * ({@link legacyTodoFields}). A field that does not fit is cut rather than the item lost.
 * D70: its priority and estimate when the source sent valid ones (1.9 and later), else
 * medium and none; a missing plan is `No plan` (like migration 0028).
 */
function importedFields(item: Readonly<Record<string, unknown>>): TodoFields | null {
  const extra = {
    priority: isTodoPriority(item['priority']) ? item['priority'] : DEFAULT_TODO_PRIORITY,
    estimateMinutes: (() => {
      const checked = checkTodoEstimate(item['estimateMinutes']);
      return checked.ok ? checked.value : null;
    })(),
  };
  const title = checkTodoTitle(item['title']);
  if (title.ok) {
    const note = (field: 'description' | 'plan'): string | null => {
      const value = item[field];
      const checked = checkTodoNote(typeof value === 'string' ? value.trim().slice(0, field === 'plan' ? TODO_PLAN_MAX : TODO_DESCRIPTION_MAX) : null, field);
      return checked.ok ? checked.value : null;
    };
    return { title: title.value, description: note('description'), plan: note('plan') ?? TODO_NO_PLAN, ...extra };
  }
  const legacy = legacyTodoFields(item['title'] ?? item['text']);
  return legacy ? { ...legacy, plan: TODO_NO_PLAN, ...extra } : null;
}

/** Timers longer than this are capped (`setTimeout` fires at once past 2^31-1 ms); the sweep then re-arms. */
const MAX_TIMER_MS = 2_147_000_000;

/**
 * D68 (`docs/todos.md`): every session's todo list. The developer's UI and the
 * session's agent (the `switchboard` MCP tools, `/agent/v1/*`) write through
 * here; each change publishes `todosChanged` and the session's `sessionUpdated`
 * (its open count). Done items are removed an hour after they were marked done
 * by a timer armed for the earliest one, and by a sweep at {@link start}, so a
 * restart keeps the hour (it is stored as `done_at`).
 */
export class TodoService {
  readonly #store: Store;
  readonly #bus: HubBus;
  readonly #announce: ((sessionId: string) => Promise<void>) | null;
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #onError: (error: unknown) => void;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #closed = false;

  constructor(options: TodoServiceOptions) {
    this.#store = options.store;
    this.#bus = options.bus;
    this.#announce = options.announce ?? null;
    this.#now = options.now ?? Date.now;
    this.#ttl = options.doneTtlMs ?? TODO_DONE_TTL_MS;
    this.#onError = options.onError ?? ((error) => console.error('switchboard todos:', error));
  }

  /** Runs the sweep now (items whose hour passed while Switchboard was stopped) and arms the timer. */
  async start(): Promise<void> {
    this.#started = true;
    await this.sweep();
  }

  /** Stops the timer. */
  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #session(sessionId: string): Promise<void> {
    if (!(await this.#store.sessions.get(sessionId))) throw new TodoError(404, 'not-found', `no session ${sessionId}`);
  }

  async #item(sessionId: string, todoId: string): Promise<TodoRecord> {
    const item = await this.#store.todos.get(todoId);
    // Another session's item is "not found": a token for one session never reaches another's items.
    if (!item || item.sessionId !== sessionId) throw new TodoError(404, 'not-found', `no todo ${todoId} in this session`);
    return item;
  }

  /** The session's list (`GET /api/sessions/{id}/todos`). */
  async list(sessionId: string): Promise<SessionTodoList> {
    await this.#session(sessionId);
    return this.#listOf(sessionId);
  }

  async #listOf(sessionId: string): Promise<SessionTodoList> {
    const todos = (await this.#store.todos.list(sessionId)).map((record) => toTodo(record, this.#ttl));
    return { sessionId, todos, openCount: todos.filter((t) => t.state === 'open').length, doneCount: todos.filter((t) => t.state === 'done').length };
  }

  /** The session's item `todoId` (`GET /agent/v1/todos/{todoId}`: the agent's `todo_get`). */
  async get(sessionId: string, todoId: string): Promise<SessionTodo> {
    await this.#session(sessionId);
    return toTodo(await this.#item(sessionId, todoId), this.#ttl);
  }

  /**
   * Adds an item at the end. D69: `input` carries `title` (or its D68 alias `text`)
   * and optionally `description` and `plan`. D70: `priority` (absent: medium) and
   * `estimateMinutes` (absent: none); an absent or blank plan is stored as `No plan`
   * on every route (an older UI or peer, or an agent tool that skipped it: ruling D70),
   * only the agent's tool schema requires one.
   */
  async add(sessionId: string, input: Readonly<Record<string, unknown>>, addedBy: TodoAuthor): Promise<{ readonly todo: SessionTodo; readonly list: SessionTodoList }> {
    await this.#session(sessionId);
    const checked = checkNewTodo(input);
    if (!checked.ok) throw new TodoError(422, 'invalid', checked.message);
    if ((await this.#store.todos.count(sessionId)) >= TODO_MAX_PER_SESSION) {
      throw new TodoError(409, 'too-many', `a session keeps at most ${TODO_MAX_PER_SESSION} todos: remove or clear some first`);
    }
    const record = await this.#store.todos.add(sessionId, checked.value, addedBy);
    return { todo: toTodo(record, this.#ttl), list: await this.#changed(sessionId) };
  }

  /**
   * New title (or its D68 alias `text`), description (`''` / `null` removes it),
   * plan (D70: cannot be emptied: 422), priority, estimate (`null` removes it) and / or
   * state (`done` ticks, `open` unticks: the hour's removal is cancelled).
   */
  async update(sessionId: string, todoId: string, patch: Readonly<Record<string, unknown>>): Promise<{ readonly todo: SessionTodo; readonly list: SessionTodoList }> {
    await this.#session(sessionId);
    await this.#item(sessionId, todoId);
    const given = ['title', 'text', 'description', 'plan', 'priority', 'estimateMinutes', 'state'].some((key) => patch[key] !== undefined);
    if (!given) throw new TodoError(422, 'invalid', 'give title, description, plan, priority, estimateMinutes and / or state');
    const fields = checkTodoPatch(patch);
    if (!fields.ok) throw new TodoError(422, 'invalid', fields.message);
    let state: TodoState | null = null;
    if (patch['state'] !== undefined) {
      if (patch['state'] !== 'open' && patch['state'] !== 'done') throw new TodoError(422, 'invalid', 'state must be open or done');
      state = patch['state'];
    }
    if (Object.keys(fields.value).length > 0) await this.#store.todos.setFields(todoId, fields.value);
    if (state !== null) await this.#store.todos.setState(todoId, state);
    const record = await this.#item(sessionId, todoId);
    return { todo: toTodo(record, this.#ttl), list: await this.#changed(sessionId) };
  }

  /** Deletes an item. */
  async remove(sessionId: string, todoId: string): Promise<SessionTodoList> {
    await this.#session(sessionId);
    await this.#item(sessionId, todoId);
    await this.#store.todos.delete(todoId);
    return this.#changed(sessionId);
  }

  /** Clear done: removes the session's done items now. */
  async clearDone(sessionId: string): Promise<SessionTodoList> {
    await this.#session(sessionId);
    await this.#store.todos.clearDone(sessionId);
    return this.#changed(sessionId);
  }

  /** Puts the items in the order of `ids` (every item id of the session, once). */
  async reorder(sessionId: string, ids: unknown): Promise<SessionTodoList> {
    await this.#session(sessionId);
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw new TodoError(422, 'invalid', 'ids must be a list of item ids');
    try {
      await this.#store.todos.reorder(sessionId, ids as string[]);
    } catch (error) {
      if (error instanceof StoreError) throw new TodoError(422, 'invalid', error.message);
      throw error;
    }
    return this.#changed(sessionId);
  }

  /**
   * `GET /api/todos`: every open session of this machine that has items, with
   * its items (open and done), most recently active first.
   */
  async groups(): Promise<TodoGroup[]> {
    const sessions = (await this.#store.sessions.list()).filter((record) => record.closedAt === null);
    const byId = await this.#store.todos.listFor(sessions.map((record) => record.id));
    const out: TodoGroup[] = [];
    for (const record of sessions) {
      const items = byId.get(record.id);
      if (!items || items.length === 0) continue;
      out.push({
        sessionId: record.id,
        title: record.title ?? record.name,
        solutions: record.solutions,
        folderPath: record.root,
        machine: null,
        lastActivityAt: record.lastActivityAt ?? record.createdAt,
        todos: items.map((item) => toTodo(item, this.#ttl)),
      });
    }
    return out.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  }

  /** Copies a taken-over session's items into the new session (D65); publishes nothing (the session is not announced yet). */
  async import(sessionId: string, todos: readonly unknown[]): Promise<number> {
    const items: Array<TodoFields & Pick<TodoRecord, 'state' | 'addedBy' | 'createdAt' | 'doneAt'>> = [];
    for (const raw of todos.slice(0, TODO_MAX_PER_SESSION)) {
      if (typeof raw !== 'object' || raw === null) continue;
      const item = raw as Record<string, unknown>;
      const fields = importedFields(item);
      if (!fields) continue;
      const state: TodoState = item['state'] === 'done' ? 'done' : 'open';
      items.push({
        ...fields,
        state,
        addedBy: item['addedBy'] === 'agent' ? 'agent' : 'developer',
        createdAt: typeof item['createdAt'] === 'string' ? item['createdAt'] : new Date(this.#now()).toISOString(),
        doneAt: state === 'done' && typeof item['doneAt'] === 'string' ? item['doneAt'] : null,
      });
    }
    const count = await this.#store.todos.import(sessionId, items);
    await this.#arm();
    return count;
  }

  /** Removes the done items whose hour has passed, publishes for their sessions, and re-arms the timer. */
  async sweep(): Promise<void> {
    if (this.#closed) return;
    const cutoff = new Date(this.#now() - this.#ttl).toISOString();
    const sessions = await this.#store.todos.removeDoneBefore(cutoff);
    for (const sessionId of sessions) await this.#publish(sessionId);
    await this.#arm();
  }

  /** Arms the timer for the earliest done item (none when there is none). */
  async #arm(): Promise<void> {
    if (this.#closed || !this.#started) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const earliest = await this.#store.todos.earliestDone();
    if (earliest === null) return;
    const due = Date.parse(earliest) + this.#ttl - this.#now();
    this.#timer = setTimeout(
      () => {
        this.#timer = null;
        void this.sweep().catch((error: unknown) => this.#onError(error));
      },
      Math.min(Math.max(due, 0) + 50, MAX_TIMER_MS),
    );
    this.#timer.unref?.();
  }

  async #changed(sessionId: string): Promise<SessionTodoList> {
    const list = await this.#publish(sessionId);
    await this.#arm();
    return list;
  }

  async #publish(sessionId: string): Promise<SessionTodoList> {
    const list = await this.#listOf(sessionId);
    this.#bus.publish('todosChanged', { sessionId, openCount: list.openCount, doneCount: list.doneCount });
    if (this.#announce) await this.#announce(sessionId).catch((error: unknown) => this.#onError(error));
    return list;
  }
}
