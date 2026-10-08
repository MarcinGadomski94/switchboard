import { randomBytes } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import type { TodoAuthor, TodoPriority, TodoRunState, TodoStartSource, TodoState } from '../../../core/api.ts';
import type { TodoActualSample } from '../../../core/todo-actuals.ts';
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
  /** D76 (0032): the session ▸ Run in new session started for it; `null` = never run. */
  readonly runSessionId: string | null;
  /** D76: `active` / `discarded`; `null` with {@link runSessionId}. */
  readonly runState: TodoRunState | null;
  /** D78 (0032): when it first went in progress (never cleared). */
  readonly startedFirstAt: string | null;
  /** D78: when the current in-progress span began; `null` while not in progress. */
  readonly spanStartedAt: string | null;
  /** D78: the time spent in progress so far (closed spans), ms; `null` = never started. */
  readonly actualMs: number | null;
  /** D78: the tokens of the closed spans' turns; `null` = none known. */
  readonly actualTokens: number | null;
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
    runSessionId: ['run_session_id', 'text'],
    runState: ['run_state', 'text'],
    startedFirstAt: ['started_first_at', 'text'],
    spanStartedAt: ['span_started_at', 'text'],
    actualMs: ['actual_ms', 'int'],
    actualTokens: ['actual_tokens', 'int'],
  },
};

/** The states in which an item is not finished (the open count): D76's review is neither open nor done. */
const OPEN_STATES = `state IN ('open', 'in_progress')`;

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
    const rows = this.#ctx.db.prepare(`SELECT session_id, COUNT(*) AS n FROM session_todos WHERE ${OPEN_STATES} GROUP BY session_id`).all();
    return new Map(rows.map((row) => [String(row['session_id']), Number(row['n'])]));
  }

  /** The session's open items (D75: open and in progress: the sidebar's ☐ count). */
  async openCount(sessionId: string): Promise<number> {
    const row = this.#ctx.db.prepare(`SELECT COUNT(*) AS n FROM session_todos WHERE session_id = ? AND ${OPEN_STATES}`).get(sessionId);
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
        runSessionId: null,
        runState: null,
        startedFirstAt: null,
        spanStartedAt: null,
        actualMs: null,
        actualTokens: null,
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
        // D76: a run's review does not travel (the run session stays on the old machine): it arrives done.
        const state: TodoState = item.state === 'review' ? 'done' : item.state;
        const doneAt = state === 'done' ? (item.doneAt ?? now) : null;
        // D75: an in-progress item always has its start (an older source's has none: now, by the developer).
        const started = state === 'open' ? null : (item.startedAt ?? (state === 'in_progress' ? now : null));
        this.#table.insert({
          id: newId(),
          sessionId,
          title: item.title,
          description: item.description,
          plan: item.plan,
          priority: item.priority,
          estimateMinutes: item.estimateMinutes,
          state,
          addedBy: item.addedBy,
          position,
          createdAt: item.createdAt,
          updatedAt: now,
          doneAt,
          startedAt: started,
          // D76: a run's start is the developer's on the new machine (no run session there).
          startedBy: started === null ? null : item.startedBy && item.startedBy !== 'run' ? item.startedBy : 'developer',
          // A fresh start on the new session: its reminder may come once there.
          remindedAt: null,
          runSessionId: null,
          runState: null,
          startedFirstAt: started,
          spanStartedAt: state === 'in_progress' ? now : null,
          actualMs: null,
          actualTokens: null,
        });
        position += 1;
      }
      return items.length;
    });
  }

  /** D69 / D70: new title, description, plan, priority and / or estimate (each only when given); `null` when there is no such item. */
  async setFields(id: string, fields: Partial<TodoFields>): Promise<TodoRecord | null> {
    const now = this.#ctx.now();
    const updated = this.#table.update(id, { ...fields, updatedAt: now });
    // D78: a completed item's record follows its title and estimate.
    if (updated && (updated.state === 'done' || updated.state === 'review') && (fields.title !== undefined || fields.estimateMinutes !== undefined)) this.#recordActuals(updated, now);
    return updated;
  }

  /**
   * Ticks (`done`: `done_at` now) or unticks (`open`: no `done_at`) an item; one already in that
   * state is unchanged. D75: `in_progress` starts it (`started_at` now, `startedBy`, no reminder
   * sent yet; `done_at` cleared); `open` clears its start too; `done` keeps it.
   */
  async setState(id: string, state: TodoState, startedBy: TodoStartSource = 'developer'): Promise<TodoRecord | null> {
    return transaction(this.#ctx.db, () => {
      const current = this.#table.get(id);
      if (!current) return null;
      if (current.state === state) return current;
      const now = this.#ctx.now();
      // D78: leaving in progress closes the span (its time and its turns' tokens are added).
      const closed = current.state === 'in_progress' ? this.#closeSpan(current, now) : {};
      let updated: TodoRecord | null;
      if (state === 'in_progress') {
        updated = this.#table.update(id, { ...closed, state, doneAt: null, startedAt: now, startedBy, remindedAt: null, updatedAt: now, startedFirstAt: current.startedFirstAt ?? now, spanStartedAt: now });
      } else if (state === 'open') {
        updated = this.#table.update(id, { ...closed, state, doneAt: null, startedAt: null, startedBy: null, remindedAt: null, updatedAt: now, spanStartedAt: null });
      } else {
        // D76: review has no done time (it is never removed by the done hour).
        updated = this.#table.update(id, { ...closed, state, doneAt: state === 'done' ? now : null, updatedAt: now, spanStartedAt: null });
      }
      if (updated) this.#recordActuals(updated, now);
      return updated;
    });
  }

  /** D75: starts the item afresh (▶ Start, also of an item already in progress): `started_at` now, `startedBy`, the reminder re-armed. D78: an item already in progress keeps its span. */
  async start(id: string, startedBy: TodoStartSource): Promise<TodoRecord | null> {
    return transaction(this.#ctx.db, () => {
      const current = this.#table.get(id);
      if (!current) return null;
      const now = this.#ctx.now();
      const updated = this.#table.update(id, {
        state: 'in_progress',
        doneAt: null,
        startedAt: now,
        startedBy,
        remindedAt: null,
        updatedAt: now,
        startedFirstAt: current.startedFirstAt ?? now,
        spanStartedAt: current.state === 'in_progress' ? (current.spanStartedAt ?? now) : now,
      });
      if (updated) this.#recordActuals(updated, now);
      return updated;
    });
  }

  /** D75: puts back an item's state and start as they were (a ▶ Start whose message could not be sent; D76: a run that could not start). */
  async restoreState(record: Pick<TodoRecord, 'id' | 'state' | 'doneAt' | 'startedAt' | 'startedBy' | 'remindedAt' | 'updatedAt'> & Partial<Pick<TodoRecord, 'startedFirstAt' | 'spanStartedAt' | 'runSessionId' | 'runState'>>): Promise<TodoRecord | null> {
    return this.#table.update(record.id, {
      state: record.state,
      doneAt: record.doneAt,
      startedAt: record.startedAt,
      startedBy: record.startedBy,
      remindedAt: record.remindedAt,
      updatedAt: record.updatedAt,
      ...(record.startedFirstAt !== undefined ? { startedFirstAt: record.startedFirstAt } : {}),
      ...(record.spanStartedAt !== undefined ? { spanStartedAt: record.spanStartedAt } : {}),
      ...(record.runSessionId !== undefined ? { runSessionId: record.runSessionId, runState: record.runState ?? null } : {}),
    });
  }

  /** D76: links the item to its run session (`active`), or marks its run `discarded`. */
  async setRun(id: string, runSessionId: string, runState: TodoRunState): Promise<TodoRecord | null> {
    return this.#table.update(id, { runSessionId, runState, updatedAt: this.#ctx.now() });
  }

  /** D76: the items run in session `runSessionId` (any state, any run state). */
  async listByRunSession(runSessionId: string): Promise<TodoRecord[]> {
    return this.#table.select('run_session_id = ?', [runSessionId], 'position, created_at, id');
  }

  /** D78: the session that works on the item: its active run's session, else its own. */
  #workingSession(record: TodoRecord): string {
    return record.runState === 'active' && record.runSessionId ? record.runSessionId : record.sessionId;
  }

  /**
   * D78: the tokens of session `sessionId`'s turns that ended after `from`, up to `to` (each result
   * event's `tokens`, `resultTurnTokens`); `null` when none of them carried any.
   */
  turnTokens(sessionId: string, from: string, to: string): number | null {
    const row = this.#ctx.db
      .prepare(
        `SELECT SUM(json_extract(payload, '$.tokens')) AS n, COUNT(json_extract(payload, '$.tokens')) AS c FROM events
         WHERE session_id = ? AND ts > ? AND ts <= ? AND json_valid(payload) AND json_extract(payload, '$.type') = 'result'`,
      )
      .get(sessionId, from, to);
    return Number(row?.['c'] ?? 0) > 0 ? Number(row?.['n'] ?? 0) : null;
  }

  /** D78: the actuals of a span from `spanStartedAt` to `now` added to the item's. */
  #closeSpan(record: TodoRecord, now: string): Partial<TodoRecord> {
    const from = record.spanStartedAt ?? record.startedAt;
    if (!from) return { spanStartedAt: null };
    const ms = Math.max(0, Date.parse(now) - Date.parse(from));
    const tokens = this.turnTokens(this.#workingSession(record), from, now);
    return {
      actualMs: (record.actualMs ?? 0) + (Number.isFinite(ms) ? ms : 0),
      actualTokens: tokens === null ? record.actualTokens : (record.actualTokens ?? 0) + tokens,
      spanStartedAt: null,
    };
  }

  /** D78: keeps `todo_actuals` in step: a completed (done / review) item that was started has its row; any other has none. */
  #recordActuals(record: TodoRecord, now: string): void {
    const completed = (record.state === 'done' || record.state === 'review') && record.actualMs !== null;
    if (!completed) {
      this.#ctx.db.prepare('DELETE FROM todo_actuals WHERE todo_id = ?').run(record.id);
      return;
    }
    const folder = this.#ctx.db.prepare('SELECT root FROM sessions WHERE id = ?').get(record.sessionId)?.['root'];
    this.#ctx.db
      .prepare(
        `INSERT INTO todo_actuals (todo_id, session_id, folder, title, estimate_minutes, actual_ms, actual_tokens, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (todo_id) DO UPDATE SET title = excluded.title, estimate_minutes = excluded.estimate_minutes, actual_ms = excluded.actual_ms, actual_tokens = excluded.actual_tokens`,
      )
      .run(record.id, record.sessionId, typeof folder === 'string' ? folder : null, record.title, record.estimateMinutes, record.actualMs ?? 0, record.actualTokens, now);
  }

  /** D78: the completed items' records of these sessions (also the ones removed after their done hour), by session. */
  async actualsFor(sessionIds: readonly string[]): Promise<Map<string, TodoActualSample[]>> {
    const out = new Map<string, TodoActualSample[]>();
    if (sessionIds.length === 0) return out;
    const rows = this.#ctx.db.prepare(`SELECT session_id, estimate_minutes, actual_ms, actual_tokens FROM todo_actuals WHERE session_id IN (${placeholders(sessionIds.length)}) ORDER BY completed_at`).all(...sessionIds);
    for (const row of rows) {
      const list = out.get(String(row['session_id'])) ?? [];
      list.push(sampleOf(row));
      out.set(String(row['session_id']), list);
    }
    return out;
  }

  /** D78: the most recent completed items with an estimate, newest first: of session `sessionId`, or of every session in folder `folder`. */
  async recentEstimated(where: { readonly sessionId: string } | { readonly folder: string }, limit: number): Promise<TodoActualSample[]> {
    const [column, value] = 'sessionId' in where ? ['session_id', where.sessionId] : ['folder', where.folder];
    const rows = this.#ctx.db
      .prepare(`SELECT estimate_minutes, actual_ms, actual_tokens FROM todo_actuals WHERE ${column} = ? AND estimate_minutes IS NOT NULL ORDER BY completed_at DESC, rowid DESC LIMIT ?`)
      .all(value, limit);
    return rows.map(sampleOf);
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

  /** The earliest `done_at` of any done item, `null` when there is none. */
  async earliestDone(): Promise<string | null> {
    const row = this.#ctx.db.prepare(`SELECT MIN(done_at) AS at FROM session_todos WHERE state = 'done'`).get();
    const at = row?.['at'];
    return typeof at === 'string' ? at : null;
  }
}

function sampleOf(row: Readonly<Record<string, unknown>>): TodoActualSample {
  const estimate = row['estimate_minutes'];
  const tokens = row['actual_tokens'];
  return {
    estimateMinutes: typeof estimate === 'number' || typeof estimate === 'bigint' ? Number(estimate) : null,
    actualMs: Number(row['actual_ms'] ?? 0),
    actualTokens: typeof tokens === 'number' || typeof tokens === 'bigint' ? Number(tokens) : null,
  };
}
