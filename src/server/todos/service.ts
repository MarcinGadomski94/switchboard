import type { SessionTodo, SessionTodoList, TodoAuthor, TodoGroup, TodoStartSource, TodoState } from '../../core/api.ts';
import type { ReviewOutcome } from '../../core/reviews.ts';
import { CALIBRATION_WINDOW, todoActualsTotal, todoCalibration } from '../../core/todo-actuals.ts';
import { isTodoCaptureSource } from '../../core/todo-capture.ts';
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
  isTodoState,
  todoIsOpen,
  legacyTodoFields,
  todoRemoveAt,
  todoStartMessage,
  todoStateOf,
} from '../../core/todos.ts';
import type { TodoFields, TodoRecord } from '../db/repos/todos.ts';
import type { Store } from '../db/store.ts';
import { StoreError } from '../db/table.ts';
import type { HubBus } from '../hub/bus.ts';

/** Why the service refused a call: maps to the HTTP status of the route. */
export class TodoError extends Error {
  override name = 'TodoError';
  readonly status: 404 | 409 | 422;
  readonly code: 'not-found' | 'too-many' | 'invalid' | 'already-running' | 'no-folder';
  constructor(status: 404 | 409 | 422, code: 'not-found' | 'too-many' | 'invalid' | 'already-running' | 'no-folder', message: string) {
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
    // D75: when and how it went in progress.
    startedAt: record.startedAt ?? null,
    startedBy: record.startedBy ?? null,
    // D76: its run session (kept after the run), D78: its actuals.
    runSessionId: record.runSessionId ?? null,
    runState: record.runState ?? null,
    startedFirstAt: record.startedFirstAt ?? null,
    actualMs: record.actualMs ?? null,
    actualTokens: record.actualTokens ?? null,
    // D81: a captured item waiting for its agent to fill it in (an open one only), and how it was captured.
    needsEnrichment: record.needsEnrichment === true && record.state === 'open',
    capturedFrom: record.capturedFrom ?? null,
  };
}

/** D75: sends a text to a session as a normal user message (queued while the agent is busy; a hooked session's waits in its mailbox). */
export type TodoMessageSender = (sessionId: string, text: string) => Promise<void>;

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
  /** D75: item id → when the agent last changed it (other than `todo_start`): the finish reminder skips an item touched in the turn. */
  readonly #agentTouches = new Map<string, number>();
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
    // D75: open = not done (open and in progress: the sidebar's count); inProgressCount says how many of them are started.
    // D76: an item in review is neither open nor done (reviewCount).
    return {
      sessionId,
      todos,
      openCount: todos.filter(todoIsOpen).length,
      doneCount: todos.filter((t) => t.state === 'done').length,
      inProgressCount: todos.filter((t) => t.state === 'in_progress').length,
      reviewCount: todos.filter((t) => t.state === 'review').length,
    };
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
   * state (`done` ticks, `open` unticks: the hour's removal is cancelled; D75 `in_progress`
   * starts it: by the agent (`todo_start`) or the developer (⋯ → Mark in progress), `by`).
   */
  async update(sessionId: string, todoId: string, patch: Readonly<Record<string, unknown>>, by: TodoAuthor = 'developer'): Promise<{ readonly todo: SessionTodo; readonly list: SessionTodoList }> {
    await this.#session(sessionId);
    await this.#item(sessionId, todoId);
    const given = ['title', 'text', 'description', 'plan', 'priority', 'estimateMinutes', 'state'].some((key) => patch[key] !== undefined);
    if (!given) throw new TodoError(422, 'invalid', 'give title, description, plan, priority, estimateMinutes and / or state');
    const fields = checkTodoPatch(patch);
    if (!fields.ok) throw new TodoError(422, 'invalid', fields.message);
    let state: TodoState | null = null;
    if (patch['state'] !== undefined) {
      if (!isTodoState(patch['state'])) throw new TodoError(422, 'invalid', 'state must be open, in_progress, review or done');
      state = patch['state'];
    }
    const before = await this.#item(sessionId, todoId);
    if (state === 'review' && before.runSessionId === null) throw new TodoError(422, 'invalid', 'only an item run in its own session can be in review');
    // D76: done of an item whose run is active is review (its run's work waits for the developer); D77: the board's drag to Done skips it.
    if (state === 'done' && before.runState === 'active' && before.state !== 'review' && patch['skipReview'] !== true) state = 'review';
    if (Object.keys(fields.value).length > 0) await this.#store.todos.setFields(todoId, fields.value);
    if (state !== null) {
      const current = await this.#item(sessionId, todoId);
      // D75: the agent's todo_start on an item the developer marked in progress makes it the agent's start (the reminder applies).
      // D76: the run session's agent (`linked`) keeps the run's start (its reminder is the run session's).
      const source: TodoStartSource = by === 'agent' ? (current.startedBy === 'run' && current.runState === 'active' ? 'run' : 'agent') : 'developer';
      if (state === 'in_progress' && by === 'agent' && current.state === 'in_progress' && current.startedBy === 'developer') await this.#store.todos.start(todoId, source);
      else await this.#store.todos.setState(todoId, state, source);
    }
    // D81: the agent's todo_update fills a captured item in; so does the developer's own edit of what the agent would fill.
    const fills = by === 'agent' ? Object.keys(fields.value).length > 0 : ['description', 'plan', 'priority', 'estimateMinutes'].some((key) => key in fields.value);
    if (fills && (await this.#item(sessionId, todoId)).needsEnrichment) await this.#store.todos.clearEnrichment(todoId);
    // D75: the agent touched the item (anything but marking it in progress), so a turn ending now needs no reminder for it.
    if (by === 'agent' && (Object.keys(fields.value).length > 0 || (state !== null && state !== 'in_progress'))) this.#agentTouches.set(todoId, this.#now());
    const record = await this.#item(sessionId, todoId);
    return { todo: toTodo(record, this.#ttl), list: await this.#changed(sessionId) };
  }

  /**
   * D81 · quick capture (`POST /api/sessions/{id}/todos/capture`): a title and an optional note
   * (the description), saved bare (plan `No plan`, medium, no estimate) by the developer, marked
   * as captured `from`, and, when `enrich` (Settings → Sessions → *Let the agent fill in captured
   * todos*), as waiting for the agent to fill it in (`TodoEnricher` asks it when it is next idle).
   */
  async capture(sessionId: string, input: Readonly<Record<string, unknown>>, enrich: boolean): Promise<{ readonly todo: SessionTodo; readonly list: SessionTodoList }> {
    await this.#session(sessionId);
    const from = input['from'];
    if (!isTodoCaptureSource(from)) throw new TodoError(422, 'invalid', 'from must be palette, selection or share');
    const checked = checkNewTodo({ title: input['title'], description: input['note'] ?? null });
    if (!checked.ok) throw new TodoError(422, 'invalid', checked.message);
    if ((await this.#store.todos.count(sessionId)) >= TODO_MAX_PER_SESSION) {
      throw new TodoError(409, 'too-many', `a session keeps at most ${TODO_MAX_PER_SESSION} todos: remove or clear some first`);
    }
    const added = await this.#store.todos.add(sessionId, { ...checked.value, plan: TODO_NO_PLAN, priority: DEFAULT_TODO_PRIORITY, estimateMinutes: null }, 'developer');
    const record = (await this.#store.todos.markCaptured(added.id, from, enrich)) ?? added;
    return { todo: toTodo(record, this.#ttl), list: await this.#changed(sessionId) };
  }

  /** D81: the session's open captured items that wait for the agent and were not asked yet. */
  async pendingEnrichment(sessionId: string): Promise<SessionTodo[]> {
    return (await this.#store.todos.pendingEnrichment(sessionId)).map((record) => toTodo(record, this.#ttl));
  }

  /** D81: records that the agent was asked to fill these items in (once per item). */
  async markEnrichAsked(ids: readonly string[]): Promise<void> {
    await this.#store.todos.markEnrichAsked(ids);
  }

  /** Deletes an item. */
  async remove(sessionId: string, todoId: string): Promise<SessionTodoList> {
    await this.#session(sessionId);
    await this.#item(sessionId, todoId);
    await this.#store.todos.delete(todoId);
    this.#agentTouches.delete(todoId);
    return this.#changed(sessionId);
  }

  /**
   * D75 · ▶ Start (`POST /api/sessions/{id}/todos/{todoId}/start`): the item goes in progress
   * (afresh, also when it already was: its reminder is re-armed) and its start message
   * ({@link todoStartMessage}) is sent to the session as a normal user message through `send`
   * (queued while the agent is busy). When the message cannot be sent the item is put back as
   * it was and the sender's error is thrown. A done item cannot be started (422: reopen it first).
   */
  async startItem(sessionId: string, todoId: string, send: TodoMessageSender): Promise<{ readonly todo: SessionTodo; readonly list: SessionTodoList }> {
    await this.#session(sessionId);
    const before = await this.#item(sessionId, todoId);
    if (before.state === 'done') throw new TodoError(422, 'invalid', 'a done item cannot be started: reopen it first');
    // In progress before the message goes, so a turn that ends at once already sees it started.
    const started = await this.#store.todos.start(todoId, 'start');
    try {
      await send(sessionId, todoStartMessage({ id: before.id, title: before.title, description: before.description, plan: before.plan }));
    } catch (error) {
      await this.#store.todos.restoreState(before);
      throw error;
    }
    return { todo: toTodo(started ?? before, this.#ttl), list: await this.#changed(sessionId) };
  }

  /**
   * D75: the items a turn that ran from `turnStartedAt` (epoch ms; 0 = unknown) and just ended
   * should remind the agent of: in progress, started by ▶ Start or the agent (not ⋯ → Mark in
   * progress), not reminded for this start yet, and not changed by the agent since the turn
   * began (marking it in progress does not count).
   */
  async remindable(sessionId: string, turnStartedAt: number): Promise<SessionTodo[]> {
    const out: SessionTodo[] = [];
    const candidates = [...(await this.#store.todos.list(sessionId))];
    // D76: a run session is reminded of the item it runs (in its source session's list), not the source session.
    const linked = await this.#linkedItem(sessionId);
    if (linked) candidates.push(linked);
    for (const record of candidates) {
      if (record.state !== 'in_progress' || record.remindedAt !== null) continue;
      const own = record.sessionId === sessionId;
      if (own ? record.startedBy !== 'start' && record.startedBy !== 'agent' : record.startedBy !== 'run' && record.startedBy !== 'agent') continue;
      const touched = this.#agentTouches.get(record.id);
      if (touched !== undefined && touched >= turnStartedAt) continue;
      out.push(toTodo(record, this.#ttl));
    }
    return out;
  }

  // ── D76: a todo's run session ────────────────────────────────────────

  /** D76: the item session `sessionId` runs (its `todoLink`), while that run is active; `null` otherwise. */
  async #linkedItem(sessionId: string): Promise<TodoRecord | null> {
    const link = (await this.#store.sessions.get(sessionId))?.todoLink ?? null;
    if (!link) return null;
    const item = await this.#store.todos.get(link.todoId);
    return item && item.sessionId === link.sourceSessionId && item.runSessionId === sessionId && item.runState === 'active' ? item : null;
  }

  /**
   * D76: the session whose list holds item `todoId` for the agent of session `agentSessionId`:
   * its own, or, for its run session, the source session of its one linked item (the agent token
   * of a run session reaches that item and nothing else of the source's list). An unknown item
   * answers the agent's own session (the call then says not found).
   */
  async agentScope(agentSessionId: string, todoId: string): Promise<{ readonly sessionId: string; readonly linked: boolean }> {
    const own = await this.#store.todos.get(todoId);
    if (own && own.sessionId === agentSessionId) return { sessionId: agentSessionId, linked: false };
    const linked = await this.#linkedItem(agentSessionId);
    return linked && linked.id === todoId ? { sessionId: linked.sessionId, linked: true } : { sessionId: agentSessionId, linked: false };
  }

  /** D76: the item session `sessionId` runs (`todo_list`'s extra line), `null` when none. */
  async linkedTodo(sessionId: string): Promise<SessionTodo | null> {
    const linked = await this.#linkedItem(sessionId);
    return linked ? toTodo(linked, this.#ttl) : null;
  }

  /**
   * D76: ▸ Run in new session began: the item goes in progress (started by `run`, a span opens)
   * and is linked to `runSessionId` (`active`). Answers the item as it was, for {@link cancelRun}.
   */
  async beginRun(sessionId: string, todoId: string, runSessionId: string): Promise<TodoRecord> {
    const before = await this.#item(sessionId, todoId);
    await this.#store.todos.setRun(todoId, runSessionId, 'active');
    await this.#store.todos.start(todoId, 'run');
    return before;
  }

  /** D76: the run could not start: the item is put back as it was. */
  async cancelRun(before: TodoRecord): Promise<void> {
    await this.#store.todos.restoreState(before);
    await this.#changed(before.sessionId);
  }

  /** D76: the run's item can run (not done / in review, no active run), else why not. */
  async checkRunnable(sessionId: string, todoId: string): Promise<SessionTodo> {
    await this.#session(sessionId);
    const item = await this.#item(sessionId, todoId);
    if (item.state === 'done' || item.state === 'review') throw new TodoError(422, 'invalid', `a ${item.state === 'done' ? 'done' : 'reviewed'} item cannot be run: reopen it first`);
    if (item.runState === 'active' && item.runSessionId !== null && (await this.#store.sessions.get(item.runSessionId))?.closedAt === null) {
      throw new TodoError(409, 'already-running', 'this item already runs in its own session');
    }
    return toTodo(item, this.#ttl);
  }

  /** D76: publishes the source session's change after a run began; answers its list. */
  async announceRun(sessionId: string): Promise<SessionTodoList> {
    return this.#changed(sessionId);
  }

  /**
   * D76 · `reviewResolved` (lane B's review queue): the items in review whose run session is
   * `sessionId` leave it: merged / committed / dismissed → done; discarded → open (the run is
   * marked discarded, its link kept as history); sent back → in progress again (the run's).
   */
  async resolveReview(sessionId: string, outcome: ReviewOutcome): Promise<number> {
    const items = (await this.#store.todos.listByRunSession(sessionId)).filter((record) => record.state === 'review');
    const touched = new Set<string>();
    for (const record of items) {
      if (outcome === 'discarded') {
        await this.#store.todos.setRun(record.id, sessionId, 'discarded');
        await this.#store.todos.setState(record.id, 'open');
      } else if (outcome === 'sent-back') {
        await this.#store.todos.setState(record.id, 'in_progress', 'run');
      } else {
        await this.#store.todos.setState(record.id, 'done');
      }
      touched.add(record.sessionId);
    }
    for (const id of touched) await this.#changed(id);
    return items.length;
  }

  /**
   * D78: the calibration line for session `sessionId`'s agent: its own last estimates' accuracy
   * when it has enough completed estimated items, else its folder's; `null` when neither has.
   */
  async calibration(sessionId: string): Promise<string | null> {
    const own = await this.#store.todos.recentEstimated({ sessionId }, CALIBRATION_WINDOW);
    const mine = todoCalibration(own, 'this session');
    if (mine) return mine;
    const root = (await this.#store.sessions.get(sessionId))?.root ?? null;
    if (!root) return null;
    return todoCalibration(await this.#store.todos.recentEstimated({ folder: root }, CALIBRATION_WINDOW), 'this folder');
  }

  /** D75: records that the item's finish reminder was sent (once per start). */
  async markReminded(todoId: string): Promise<void> {
    await this.#store.todos.markReminded(todoId);
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
    // D78: the completed items' actual vs. estimate (also the ones removed after their done hour).
    const actuals = await this.#store.todos.actualsFor(sessions.map((record) => record.id));
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
        actuals: actuals.has(record.id) ? todoActualsTotal(actuals.get(record.id) ?? []) : null,
      });
    }
    return out.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  }

  /** Copies a taken-over session's items into the new session (D65); publishes nothing (the session is not announced yet). */
  async import(sessionId: string, todos: readonly unknown[]): Promise<number> {
    const items: Array<TodoFields & Pick<TodoRecord, 'state' | 'addedBy' | 'createdAt' | 'doneAt' | 'startedAt' | 'startedBy'>> = [];
    for (const raw of todos.slice(0, TODO_MAX_PER_SESSION)) {
      if (typeof raw !== 'object' || raw === null) continue;
      const item = raw as Record<string, unknown>;
      const fields = importedFields(item);
      if (!fields) continue;
      // D75: in progress travels too (an older source sends open / done only).
      const state: TodoState = todoStateOf(item['state']);
      const startedBy = item['startedBy'];
      items.push({
        ...fields,
        state,
        addedBy: item['addedBy'] === 'agent' ? 'agent' : 'developer',
        createdAt: typeof item['createdAt'] === 'string' ? item['createdAt'] : new Date(this.#now()).toISOString(),
        doneAt: state === 'done' && typeof item['doneAt'] === 'string' ? item['doneAt'] : null,
        startedAt: state !== 'open' && typeof item['startedAt'] === 'string' ? item['startedAt'] : null,
        startedBy: startedBy === 'start' || startedBy === 'agent' || startedBy === 'developer' ? startedBy : null,
      });
    }
    const count = await this.#store.todos.import(sessionId, items);
    await this.#arm();
    return count;
  }

  /**
   * D83: the old session's whole list moves to the fresh session that continues it
   * (ids and states kept, with D76's run fields, D78's actuals and D81's capture flags);
   * both lists are published. The D76 links follow too: the fresh session runs the items the
   * old one ran (and takes over its `todoLink`, so its agent still reaches its one item), and
   * the runs of the moved items now name the fresh session as their source. Answers how many moved.
   */
  async moveAll(fromSessionId: string, toSessionId: string): Promise<number> {
    const moved = await this.#store.todos.moveAll(fromSessionId, toSessionId);
    const relinked = await this.#store.todos.followContinuation(fromSessionId, toSessionId);
    const from = await this.#store.sessions.get(fromSessionId);
    if (from?.todoLink) await this.#store.sessions.update(toSessionId, { todoLink: from.todoLink });
    if (moved > 0) {
      for (const session of await this.#store.sessions.list()) {
        if (session.todoLink?.sourceSessionId === fromSessionId) await this.#store.sessions.update(session.id, { todoLink: { ...session.todoLink, sourceSessionId: toSessionId } });
      }
    }
    if (moved > 0) {
      await this.#publish(fromSessionId);
      await this.#changed(toSessionId);
    }
    for (const sessionId of relinked) if (sessionId !== toSessionId && (moved === 0 || sessionId !== fromSessionId)) await this.#changed(sessionId);
    return moved;
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
