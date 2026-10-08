import { randomBytes } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import type { TodoAuthor, TodoPriority, TodoStartSource, TodoState } from '../../../core/api.ts';
import type { RepoContext } from '../context.ts';
import { placeholders } from '../context.ts';
import { transaction } from '../database.ts';
import { StoreError, Table, type TableSpec } from '../table.ts';

/** D68: a stored todo item (`session_todos`, migration 0026; D69: 0027's title, description and plan; D70: 0028's priority and estimate; D75: 0031's in progress). */
export interface TodoRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly title: string;
  readonly description: string | null;
  /** D70: never empty once written by the service (0028 filled the old ones); `null` only in a row written outside it. */
  readonly plan: string | null;
  /** D70: urgent / high / medium / low. */
  readonly priority: TodoPriority;
  /** D70: minutes an AI agent would take, 1–10,080; `null` = not estimated. */
  readonly estimateMinutes: number | null;
  readonly state: TodoState;
  readonly addedBy: TodoAuthor;
  readonly position: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly doneAt: string | null;
  /** D75: when it went in progress (kept while done, `null` while open). */
  readonly startedAt: string | null;
  /** D75: how it went in progress (▶ Start, the agent, ⋯ → Mark in progress); `null` like {@link startedAt}. */
  readonly startedBy: TodoStartSource | null;
  /** D75: when the one finish reminder of this start was sent; `null` = not sent. */
  readonly remindedAt: string | null;
}

const SPEC: TableSpec<TodoRecord> = {
  table: 'session_todos',
  key: 'id',
  fields: {
    id: ['id', 'text'],
    sessionId: ['session_id', 'text'],
    title: ['title', 'text'],
    description: ['description', 'text'],
    plan: ['plan', 'text'],
    priority: ['priority', 'text'],
    estimateMinutes: ['estimate_minutes', 'int'],
    state: ['state', 'text'],
    addedBy: ['added_by', 'text'],
    position: ['position', 'int'],
    createdAt: ['created_at', 'text'],
    updatedAt: ['updated_at', 'text'],
    doneAt: ['done_at', 'text'],
    startedAt: ['started_at', 'text'],
    startedBy: ['started_by', 'text'],
    remindedAt: ['reminded_at', 'text'],
  },
};

/** D69 / D70: an item's fields (title 1–120 characters; description `null` when none; the plan; priority; estimate). */
export interface TodoFields {
  readonly title: string;
  readonly description: string | null;
  readonly plan: string;
  readonly priority: TodoPriority;
  readonly estimateMinutes: number | null;
}

/** A new item's id: 12 hex characters (short enough for an agent to quote). */
function newId(): string {
  return randomBytes(6).toString('hex');
}

/**
 * D68: the sessions' todo lists. Each method runs to completion without
 * yielding (node:sqlite is synchronous), so it is atomic on its own; the
 * multi-row writes run in one transaction.
 */
export class TodoRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<TodoRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  /** The session's items in order. */
  async list(sessionId: string): Promise<TodoRecord[]> {
    return this.#table.select('session_id = ?', [sessionId], 'position, created_at, id');
  }

  async get(id: string): Promise<TodoRecord | null> {
    return this.#table.get(id);
  }

  /** How many items the session has. */
  async count(sessionId: string): Promise<number> {
    const row = this.#ctx.db.prepare('SELECT COUNT(*) AS n FROM session_todos WHERE session_id = ?').get(sessionId);
    return Number(row?.['n'] ?? 0);
  }

  /** Open items per session (sessions without any are left out); D75: in-progress items count as open (not done). */
  async openCounts(): Promise<Map<string, number>> {
    const rows = this.#ctx.db.prepare(`SELECT session_id, COUNT(*) AS n FROM session_todos WHERE state <> 'done' GROUP BY session_id`).all();
    return new Map(rows.map((row) => [String(row['session_id']), Number(row['n'])]));
  }

  /** The session's open items (D75: open and in progress: the sidebar's ☐ count). */
  async openCount(sessionId: string): Promise<number> {
    const row = this.#ctx.db.prepare(`SELECT COUNT(*) AS n FROM session_todos WHERE session_id = ? AND state <> 'done'`).get(sessionId);
    return Number(row?.['n'] ?? 0);
  }

  /** Every item of these sessions, by session, in order. */
  async listFor(sessionIds: readonly string[]): Promise<Map<string, TodoRecord[]>> {
    const out = new Map<string, TodoRecord[]>();
    if (sessionIds.length === 0) return out;
    for (const row of this.#table.select(`session_id IN (${placeholders(sessionIds.length)})`, sessionIds, 'session_id, position, created_at, id')) {
      const list = out.get(row.sessionId) ?? [];
      list.push(row);
      out.set(row.sessionId, list);
    }
    return out;
  }

  /** Adds an item at the end of the session's list. */
  async add(sessionId: string, fields: TodoFields, addedBy: TodoAuthor): Promise<TodoRecord> {
    return transaction(this.#ctx.db, () => {
      const now = this.#ctx.now();
      const row = this.#ctx.db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS next FROM session_todos WHERE session_id = ?').get(sessionId);
      return this.#table.insert({
        id: newId(),
        sessionId,
        title: fields.title,
        description: fields.description,
        plan: fields.plan,
        priority: fields.priority,
        estimateMinutes: fields.estimateMinutes,
        state: 'open',
        addedBy,
        position: Number(row?.['next'] ?? 0),
        createdAt: now,
        updatedAt: now,
        doneAt: null,
        startedAt: null,
        startedBy: null,
        remindedAt: null,
      });
    });
  }

  /** Copies items into `sessionId` (a take-over, D65): their fields, state, author and order; their done time is kept (D75: and their start). */
  async import(sessionId: string, items: ReadonlyArray<TodoFields & Pick<TodoRecord, 'state' | 'addedBy' | 'createdAt' | 'doneAt'> & Partial<Pick<TodoRecord, 'startedAt' | 'startedBy'>>>): Promise<number> {
    return transaction(this.#ctx.db, () => {
      const now = this.#ctx.now();
      const row = this.#ctx.db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS next FROM session_todos WHERE session_id = ?').get(sessionId);
      let position = Number(row?.['next'] ?? 0);
      for (const item of items) {
        const doneAt = item.state === 'done' ? (item.doneAt ?? now) : null;
        // D75: an in-progress item always has its start (an older source's has none: now, by the developer).
        const started = item.state === 'open' ? null : (item.startedAt ?? (item.state === 'in_progress' ? now : null));
        this.#table.insert({
          id: newId(),
          sessionId,
          title: item.title,
          description: item.description,
          plan: item.plan,
          priority: item.priority,
          estimateMinutes: item.estimateMinutes,
          state: item.state,
          addedBy: item.addedBy,
          position,
          createdAt: item.createdAt,
          updatedAt: now,
          doneAt,
          startedAt: started,
          startedBy: started === null ? null : (item.startedBy ?? 'developer'),
          // A fresh start on the new session: its reminder may come once there.
          remindedAt: null,
        });
        position += 1;
      }
      return items.length;
    });
  }

  /** D69 / D70: new title, description, plan, priority and / or estimate (each only when given); `null` when there is no such item. */
  async setFields(id: string, fields: Partial<TodoFields>): Promise<TodoRecord | null> {
    return this.#table.update(id, { ...fields, updatedAt: this.#ctx.now() });
  }

  /**
   * Ticks (`done`: `done_at` now) or unticks (`open`: no `done_at`) an item; one already in that
   * state is unchanged. D75: `in_progress` starts it (`started_at` now, `startedBy`, no reminder
   * sent yet; `done_at` cleared); `open` clears its start too; `done` keeps it.
   */
  async setState(id: string, state: TodoState, startedBy: TodoStartSource = 'developer'): Promise<TodoRecord | null> {
    const current = this.#table.get(id);
    if (!current) return null;
    if (current.state === state) return current;
    const now = this.#ctx.now();
    if (state === 'in_progress') return this.#table.update(id, { state, doneAt: null, startedAt: now, startedBy, remindedAt: null, updatedAt: now });
    if (state === 'open') return this.#table.update(id, { state, doneAt: null, startedAt: null, startedBy: null, remindedAt: null, updatedAt: now });
    return this.#table.update(id, { state, doneAt: now, updatedAt: now });
  }

  /** D75: starts the item afresh (▶ Start, also of an item already in progress): `started_at` now, `startedBy`, the reminder re-armed. */
  async start(id: string, startedBy: TodoStartSource): Promise<TodoRecord | null> {
    const now = this.#ctx.now();
    return this.#table.update(id, { state: 'in_progress', doneAt: null, startedAt: now, startedBy, remindedAt: null, updatedAt: now });
  }

  /** D75: puts back an item's state and start as they were (a ▶ Start whose message could not be sent). */
  async restoreState(record: Pick<TodoRecord, 'id' | 'state' | 'doneAt' | 'startedAt' | 'startedBy' | 'remindedAt' | 'updatedAt'>): Promise<TodoRecord | null> {
    return this.#table.update(record.id, { state: record.state, doneAt: record.doneAt, startedAt: record.startedAt, startedBy: record.startedBy, remindedAt: record.remindedAt, updatedAt: record.updatedAt });
  }

  /** D75: records the finish reminder of the item's current start (`updated_at` unchanged: it is not an edit). */
  async markReminded(id: string): Promise<TodoRecord | null> {
    return this.#table.update(id, { remindedAt: this.#ctx.now() });
  }

  async delete(id: string): Promise<boolean> {
    return this.#table.delete(id as SQLInputValue);
  }

  /** Removes the session's done items; answers how many. */
  async clearDone(sessionId: string): Promise<number> {
    const result = this.#ctx.db.prepare(`DELETE FROM session_todos WHERE session_id = ? AND state = 'done'`).run(sessionId);
    return Number(result.changes);
  }

  /**
   * Puts the session's items in the order of `ids`.
   * @throws {StoreError} `invalid` unless `ids` is exactly the session's item ids (each once).
   */
  async reorder(sessionId: string, ids: readonly string[]): Promise<TodoRecord[]> {
    return transaction(this.#ctx.db, () => {
      const current = this.#table.select('session_id = ?', [sessionId], 'position, created_at, id');
      const known = new Set(current.map((row) => row.id));
      if (ids.length !== known.size || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) {
        throw new StoreError('invalid', 'ids must list every item of the session once');
      }
      const update = this.#ctx.db.prepare('UPDATE session_todos SET position = ? WHERE id = ?');
      ids.forEach((id, index) => update.run(index, id));
      return this.#table.select('session_id = ?', [sessionId], 'position, created_at, id');
    });
  }

  /** Removes the done items marked done at or before `iso`; answers the sessions they belonged to. */
  async removeDoneBefore(iso: string): Promise<string[]> {
    return transaction(this.#ctx.db, () => {
      const rows = this.#ctx.db.prepare(`SELECT DISTINCT session_id FROM session_todos WHERE state = 'done' AND done_at <= ?`).all(iso);
      this.#ctx.db.prepare(`DELETE FROM session_todos WHERE state = 'done' AND done_at <= ?`).run(iso);
      return rows.map((row) => String(row['session_id']));
    });
  }

  /**
   * D83: moves every item of `fromSessionId` to `toSessionId` (a session continued in a
   * fresh one): ids, states, times and order are kept, after any items the target has.
   * Answers how many moved.
   */
  async moveAll(fromSessionId: string, toSessionId: string): Promise<number> {
    return transaction(this.#ctx.db, () => {
      const row = this.#ctx.db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS next FROM session_todos WHERE session_id = ?').get(toSessionId);
      const offset = Number(row?.['next'] ?? 0);
      const moved = this.#ctx.db.prepare('UPDATE session_todos SET session_id = ?, position = position + ? WHERE session_id = ?').run(toSessionId, offset, fromSessionId);
      return Number(moved.changes);
    });
  }

  /** The earliest `done_at` of any done item, `null` when there is none. */
  async earliestDone(): Promise<string | null> {
    const row = this.#ctx.db.prepare(`SELECT MIN(done_at) AS at FROM session_todos WHERE state = 'done'`).get();
    const at = row?.['at'];
    return typeof at === 'string' ? at : null;
  }
}
