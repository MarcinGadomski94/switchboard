import { randomBytes } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import type { TodoAuthor, TodoCaptureSource, TodoPriority, TodoRunState, TodoStartSource, TodoState } from '../../../core/api.ts';
import type { TodoActualSample } from '../../../core/todo-actuals.ts';
import { type TokenUsage, addUsage, EMPTY_USAGE, modelKey, readTokenUsage } from '../../../core/insights.ts';
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
  /** D108 (0045): those turns' tokens by kind (`unsplit` = turns without a split); `null` = none known. */
  readonly actualUsage?: TokenUsage | null;
  /**
   * D147 (0052): its working time so far (closed working spans), ms: the time its working session
   * was working while it was in progress, split equally among that session's items in progress.
   * `null` = no working clock (it was finished before D147: open time only).
   */
  readonly workingMs?: number | null;
  /** D147 (0052): when its current working span began (in progress and its working session working); `null` otherwise. */
  readonly workingSpanStartedAt?: string | null;
  /** D147 (0052): how many items share the current span (each gets 1/share of its time); `null` with no span. */
  readonly workingShare?: number | null;
  /** D81 (0035): a captured item still waits for its agent to fill it in. */
  readonly needsEnrichment: boolean;
  /** D81 (0035): how it was captured; `null` for an item added any other way. */
  readonly capturedFrom: TodoCaptureSource | null;
  /** D81 (0035): when the agent was asked to fill it in (at most once); `null` = not asked. */
  readonly enrichAskedAt: string | null;
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
    actualUsage: ['actual_usage', 'json'],
    workingMs: ['working_ms', 'int'],
    workingSpanStartedAt: ['working_span_started_at', 'text'],
    workingShare: ['working_share', 'int'],
    needsEnrichment: ['needs_enrichment', 'bool'],
    capturedFrom: ['captured_from', 'text'],
    enrichAskedAt: ['enrich_asked_at', 'text'],
  },
};

/** D147: the session working on an item (SQL): its active run's session, else its own (like {@link TodoRepository} `#workingSession`). */
const WORKING_SESSION = `CASE WHEN run_state = 'active' AND run_session_id IS NOT NULL THEN run_session_id ELSE session_id END`;

/** The states in which an item is not finished (the open count). */
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
  /** D147: the sessions working now (status `run`), as the work clock last heard ({@link setWorking}). */
  readonly #working = new Set<string>();

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
        workingMs: null,
        workingSpanStartedAt: null,
      });
    });
  }

  /** Copies items into `sessionId` (a take-over, D65): their fields, state, author and order; their done time is kept (D75: and their start). */
  async import(sessionId: string, items: ReadonlyArray<TodoFields & Pick<TodoRecord, 'state' | 'addedBy' | 'createdAt' | 'doneAt'> & Partial<Pick<TodoRecord, 'startedAt' | 'startedBy'>>>): Promise<number> {
    return transaction(this.#ctx.db, () => {
      const now = this.#ctx.now();
      // D147: the session's in-progress items share its working time with the imported ones from now on.
      this.#settle([sessionId], now);
      const row = this.#ctx.db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS next FROM session_todos WHERE session_id = ?').get(sessionId);
      let position = Number(row?.['next'] ?? 0);
      for (const item of items) {
        const state: TodoState = item.state;
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
          // D147: an imported item in progress starts its working clock here.
          workingMs: state === 'in_progress' ? 0 : null,
          workingSpanStartedAt: null,
        });
        position += 1;
      }
      this.#settle([sessionId], now);
      return items.length;
    });
  }

  /** D69 / D70: new title, description, plan, priority and / or estimate (each only when given); `null` when there is no such item. */
  async setFields(id: string, fields: Partial<TodoFields>): Promise<TodoRecord | null> {
    const now = this.#ctx.now();
    const updated = this.#table.update(id, { ...fields, updatedAt: now });
    // D78: a completed item's record follows its title and estimate.
    if (updated && updated.state === 'done' && (fields.title !== undefined || fields.estimateMinutes !== undefined)) this.#recordActuals(updated, now);
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
      this.#recordReopen(current, state, now);
      // D147: the working time so far, at the old split, before the item joins or leaves its session's items in progress.
      const sessions = [this.#workingSession(current)];
      this.#settle(sessions, now);
      const settled = this.#table.get(id) ?? current;
      // D78: leaving in progress closes the span (its time and its turns' tokens are added).
      const closed = current.state === 'in_progress' ? this.#closeSpan(settled, now) : {};
      let updated: TodoRecord | null;
      if (state === 'in_progress') {
        updated = this.#table.update(id, { ...closed, state, doneAt: null, startedAt: now, startedBy, remindedAt: null, updatedAt: now, startedFirstAt: current.startedFirstAt ?? now, spanStartedAt: now, ...clockFrom(current) });
      } else if (state === 'open') {
        updated = this.#table.update(id, { ...closed, state, doneAt: null, startedAt: null, startedBy: null, remindedAt: null, updatedAt: now, spanStartedAt: null, workingSpanStartedAt: null, workingShare: null, ...clockFrom(current) });
      } else {
        updated = this.#table.update(id, { ...closed, state, doneAt: now, updatedAt: now, spanStartedAt: null, workingSpanStartedAt: null, workingShare: null });
      }
      this.#settle(sessions, now);
      updated = this.#table.get(id);
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
      this.#recordReopen(current, 'in_progress', now);
      const sessions = [this.#workingSession(current)];
      this.#settle(sessions, now);
      this.#table.update(id, {
        state: 'in_progress',
        doneAt: null,
        startedAt: now,
        startedBy,
        remindedAt: null,
        updatedAt: now,
        startedFirstAt: current.startedFirstAt ?? now,
        spanStartedAt: current.state === 'in_progress' ? (current.spanStartedAt ?? now) : now,
        ...(current.state === 'in_progress' ? {} : clockFrom(current)),
      });
      this.#settle(sessions, now);
      const updated = this.#table.get(id);
      if (updated) this.#recordActuals(updated, now);
      return updated;
    });
  }

  /** D75: puts back an item's state and start as they were (a ▶ Start whose message could not be sent; D76: a run that could not start). */
  async restoreState(record: Pick<TodoRecord, 'id' | 'state' | 'doneAt' | 'startedAt' | 'startedBy' | 'remindedAt' | 'updatedAt'> & Partial<Pick<TodoRecord, 'startedFirstAt' | 'spanStartedAt' | 'runSessionId' | 'runState' | 'workingMs'>>): Promise<TodoRecord | null> {
    return transaction(this.#ctx.db, () => this.#withClock([record.id], () => this.#table.update(record.id, {
      state: record.state,
      doneAt: record.doneAt,
      startedAt: record.startedAt,
      startedBy: record.startedBy,
      remindedAt: record.remindedAt,
      updatedAt: record.updatedAt,
      ...(record.startedFirstAt !== undefined ? { startedFirstAt: record.startedFirstAt } : {}),
      ...(record.spanStartedAt !== undefined ? { spanStartedAt: record.spanStartedAt } : {}),
      ...(record.runSessionId !== undefined ? { runSessionId: record.runSessionId, runState: record.runState ?? null } : {}),
      // D147: its working clock as it was (the failed start's moment is dropped); the work clock re-opens a span for an item in progress.
      ...(record.workingMs !== undefined ? { workingMs: record.workingMs } : {}),
      workingSpanStartedAt: null,
      workingShare: null,
    })));
  }

  /** D76: links the item to its run session (`active`), or marks its run `discarded`. */
  async setRun(id: string, runSessionId: string, runState: TodoRunState): Promise<TodoRecord | null> {
    // D147: the item's working session may change (its run's, else its own): both are settled.
    return transaction(this.#ctx.db, () => this.#withClock([id], () => this.#table.update(id, { runSessionId, runState, updatedAt: this.#ctx.now() })));
  }

  /** D76: the items run in session `runSessionId` (any state, any run state). */
  async listByRunSession(runSessionId: string): Promise<TodoRecord[]> {
    return this.#table.select('run_session_id = ?', [runSessionId], 'position, created_at, id');
  }

  /** D78: the session that works on the item: its active run's session, else its own. */
  #workingSession(record: Pick<TodoRecord, 'runState' | 'runSessionId' | 'sessionId'>): string {
    return record.runState === 'active' && record.runSessionId ? record.runSessionId : record.sessionId;
  }

  // ── D147: the working clock ────────────────────────────────────────

  /**
   * D147: session `sessionId` started (`true`) or stopped working (status `run`, as the work clock
   * reads `sessionUpdated`). The time so far is split among the items it works on, and their spans
   * open (working) or close (not); `at` is when (ISO; default now). Answers the ids of the items
   * whose working time changed.
   */
  async setWorking(sessionId: string, working: boolean, at?: string): Promise<string[]> {
    if (this.#working.has(sessionId) === working) return [];
    return transaction(this.#ctx.db, () => {
      const now = at ?? this.#ctx.now();
      const touched = this.#settle([sessionId], now);
      if (working) this.#working.add(sessionId);
      else this.#working.delete(sessionId);
      return [...new Set([...touched, ...this.#settle([sessionId], now)])];
    });
  }

  /** D147: whether session `sessionId` works, as the work clock last said (tests). */
  isWorking(sessionId: string): boolean {
    return this.#working.has(sessionId);
  }

  /**
   * D147: closes every working span still open in the database (a start after a crash or a stop
   * that did not close them): each at its working session's **last known working moment**, its
   * newest event since the span began (else the span's start: nothing was seen working), never
   * later than now. The time is split among that session's open spans as usual. The clock then
   * forgets every session (they are working again only when their status says so).
   */
  async closeWorkSpans(): Promise<number> {
    return transaction(this.#ctx.db, () => {
      const now = this.#ctx.now();
      this.#working.clear();
      const open = this.#table.select(`working_span_started_at IS NOT NULL`, [], 'id');
      const bySession = new Map<string, TodoRecord[]>();
      for (const record of open) {
        const key = this.#workingSession(record);
        bySession.set(key, [...(bySession.get(key) ?? []), record]);
      }
      for (const [sessionId, records] of bySession) {
        const from = records.reduce((min, record) => (record.workingSpanStartedAt && record.workingSpanStartedAt < min ? record.workingSpanStartedAt : min), records[0]?.workingSpanStartedAt ?? now);
        const row = this.#ctx.db.prepare('SELECT MAX(ts) AS at FROM events WHERE session_id = ? AND ts >= ? AND ts <= ?').get(sessionId, from, now);
        const last = typeof row?.['at'] === 'string' ? row['at'] : null;
        for (const record of records) {
          const start = record.workingSpanStartedAt ?? now;
          const end = last !== null && last > start ? last : start;
          const ms = Math.max(0, Date.parse(end) - Date.parse(start));
          this.#table.update(record.id, { workingMs: (record.workingMs ?? 0) + (Number.isFinite(ms) ? Math.round(ms / records.length) : 0), workingSpanStartedAt: null, workingShare: null });
        }
      }
      return open.length;
    });
  }

  /** D147: closes the open working spans now (Switchboard is stopping) and forgets every session. */
  async stopWorkClock(): Promise<void> {
    const sessions = [...this.#working];
    if (sessions.length === 0) return;
    transaction(this.#ctx.db, () => {
      const now = this.#ctx.now();
      this.#settle(sessions, now);
      this.#working.clear();
      this.#settle(sessions, now);
    });
  }

  /**
   * D147: runs `change` (one write to items `ids`) between two settlements of their working
   * sessions before and after, so the time before it is split at the old share and the spans
   * after it follow the new one. Runs inside the caller's transaction.
   */
  #withClock<T>(ids: readonly string[], change: () => T): T {
    const sessionsOf = (): string[] => ids.map((id) => this.#table.get(id)).filter((record): record is TodoRecord => record !== null).map((record) => this.#workingSession(record));
    const now = this.#ctx.now();
    const before = sessionsOf();
    this.#settle(before, now);
    const result = change();
    this.#settle([...before, ...sessionsOf()], now);
    return result;
  }

  /**
   * D147: brings the working time of the items in progress that sessions `sessionIds` work on up
   * to `now`: each open span adds its time divided by how many such items have one (the equal
   * split), then a span opens at `now` for every one of them (also one that had none) while its
   * session works, and none stays open while it does not. Items without a working clock
   * (`working_ms` NULL: finished before D147, reopened) take no part. Answers the ids it changed.
   */
  #settle(sessionIds: readonly string[], now: string): string[] {
    const changed: string[] = [];
    for (const sessionId of new Set(sessionIds)) {
      const items = this.#table.select(`state = 'in_progress' AND working_ms IS NOT NULL AND ${WORKING_SESSION} = ?`, [sessionId], 'id');
      const open = items.filter((record) => record.workingSpanStartedAt);
      const working = this.#working.has(sessionId);
      const nowMs = Date.parse(now);
      for (const record of items) {
        let workingMs = record.workingMs ?? 0;
        if (record.workingSpanStartedAt) {
          const ms = Math.max(0, nowMs - Date.parse(record.workingSpanStartedAt));
          if (Number.isFinite(ms)) workingMs += Math.round(ms / open.length);
        }
        const span = working ? now : null;
        // The live share the UI divides the running span by (every item of the session in progress with a clock).
        const share = working ? items.length : null;
        if (workingMs === record.workingMs && span === (record.workingSpanStartedAt ?? null) && share === (record.workingShare ?? null)) continue;
        this.#table.update(record.id, { workingMs, workingSpanStartedAt: span, workingShare: share });
        changed.push(record.id);
      }
    }
    return changed;
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

  /**
   * D108: the token split of session `sessionId`'s turns that ended after `from`, up to `to`
   * (each result event's `usage`; a result without one adds its `tokens` as `unsplit`); `null`
   * when none of them carried any tokens.
   */
  turnUsage(sessionId: string, from: string, to: string): TokenUsage | null {
    const row = this.#ctx.db
      .prepare(
        `SELECT SUM(json_extract(payload, '$.usage.input')) AS i, SUM(json_extract(payload, '$.usage.output')) AS o,
           SUM(json_extract(payload, '$.usage.cacheWrite')) AS w, SUM(json_extract(payload, '$.usage.cacheRead')) AS r,
           SUM(CASE WHEN json_extract(payload, '$.usage') IS NULL THEN json_extract(payload, '$.tokens') END) AS u,
           COUNT(json_extract(payload, '$.usage')) + COUNT(json_extract(payload, '$.tokens')) AS c
         FROM events WHERE session_id = ? AND ts > ? AND ts <= ? AND json_valid(payload) AND json_extract(payload, '$.type') = 'result'`,
      )
      .get(sessionId, from, to);
    if (Number(row?.['c'] ?? 0) === 0) return null;
    return { input: Number(row?.['i'] ?? 0), output: Number(row?.['o'] ?? 0), cacheWrite: Number(row?.['w'] ?? 0), cacheRead: Number(row?.['r'] ?? 0), unsplit: Number(row?.['u'] ?? 0) };
  }

  /** D108: the model the CLI reported for session `sessionId`'s newest turn that ended up to `to`; `null` when none did. */
  #reportedModel(sessionId: string, to: string): string | null {
    const row = this.#ctx.db
      .prepare(`SELECT json_extract(payload, '$.model') AS m FROM events WHERE session_id = ? AND ts <= ? AND json_valid(payload) AND json_extract(payload, '$.type') = 'result' AND json_extract(payload, '$.model') IS NOT NULL ORDER BY ts DESC, id DESC LIMIT 1`)
      .get(sessionId, to);
    return typeof row?.['m'] === 'string' ? row['m'] : null;
  }

  /** D78: the actuals of a span from `spanStartedAt` to `now` added to the item's. */
  #closeSpan(record: TodoRecord, now: string): Partial<TodoRecord> {
    const from = record.spanStartedAt ?? record.startedAt;
    if (!from) return { spanStartedAt: null };
    const ms = Math.max(0, Date.parse(now) - Date.parse(from));
    const tokens = this.turnTokens(this.#workingSession(record), from, now);
    // D108: the same turns' split, accumulated like the tokens.
    const usage = this.turnUsage(this.#workingSession(record), from, now);
    return {
      actualMs: (record.actualMs ?? 0) + (Number.isFinite(ms) ? ms : 0),
      actualTokens: tokens === null ? record.actualTokens : (record.actualTokens ?? 0) + tokens,
      ...(usage === null ? {} : { actualUsage: addUsage(readTokenUsage(record.actualUsage) ?? EMPTY_USAGE, usage) }),
      spanStartedAt: null,
    };
  }

  /** D108: records that an item went from done back to open / in progress (a reopen: Insights' rework signal). */
  #recordReopen(current: TodoRecord, state: TodoState, now: string): void {
    if (current.state !== 'done' || state === 'done') return;
    this.#ctx.db.prepare('INSERT INTO todo_reopens (todo_id, session_id, reopened_at) VALUES (?, ?, ?)').run(current.id, current.sessionId, now);
  }

  /** D78: keeps `todo_actuals` in step: a completed (done) item that was started has its row; any other has none. */
  #recordActuals(record: TodoRecord, now: string): void {
    const completed = record.state === 'done' && record.actualMs !== null;
    if (!completed) {
      this.#ctx.db.prepare('DELETE FROM todo_actuals WHERE todo_id = ?').run(record.id);
      return;
    }
    const folder = this.#ctx.db.prepare('SELECT root FROM sessions WHERE id = ?').get(record.sessionId)?.['root'];
    // D108: the session that worked on it (its run's, else its own): CLI, model (the one its CLI reported last, else its choice) and account.
    const working = this.#workingSession(record);
    const session = this.#ctx.db.prepare("SELECT provider, model, COALESCE(profile_id, 'default-' || provider) AS profile_id FROM sessions WHERE id = ?").get(working);
    const model = modelKey(this.#reportedModel(working, now), typeof session?.['model'] === 'string' ? session['model'] : null);
    const usage = readTokenUsage(record.actualUsage) ?? (record.actualTokens === null ? null : { ...EMPTY_USAGE, unsplit: record.actualTokens });
    this.#ctx.db
      .prepare(
        `INSERT INTO todo_actuals (todo_id, session_id, folder, title, estimate_minutes, actual_ms, actual_tokens, completed_at, run_session_id, priority, provider, model, profile_id, usage, working_ms, measure) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (todo_id) DO UPDATE SET title = excluded.title, estimate_minutes = excluded.estimate_minutes, actual_ms = excluded.actual_ms, actual_tokens = excluded.actual_tokens, priority = excluded.priority, working_ms = excluded.working_ms, measure = excluded.measure`,
      )
      .run(
        record.id,
        record.sessionId,
        typeof folder === 'string' ? folder : null,
        record.title,
        record.estimateMinutes,
        record.actualMs ?? 0,
        record.actualTokens,
        now,
        record.runSessionId,
        record.priority,
        typeof session?.['provider'] === 'string' ? session['provider'] : null,
        model,
        typeof session?.['profile_id'] === 'string' ? session['profile_id'] : null,
        usage === null ? null : JSON.stringify(usage),
        // D147: its working time; an item without a working clock (finished before D147) is open time only.
        typeof record.workingMs === 'number' ? record.workingMs : null,
        typeof record.workingMs === 'number' ? 'working' : 'open',
      );
  }

  /** D78: the completed items' records of these sessions (also the ones removed after their done hour), by session. */
  async actualsFor(sessionIds: readonly string[]): Promise<Map<string, TodoActualSample[]>> {
    const out = new Map<string, TodoActualSample[]>();
    if (sessionIds.length === 0) return out;
    const rows = this.#ctx.db.prepare(`SELECT session_id, estimate_minutes, actual_ms, actual_tokens, working_ms, measure FROM todo_actuals WHERE session_id IN (${placeholders(sessionIds.length)}) ORDER BY completed_at`).all(...sessionIds);
    for (const row of rows) {
      const list = out.get(String(row['session_id'])) ?? [];
      list.push(sampleOf(row));
      out.set(String(row['session_id']), list);
    }
    return out;
  }

  /**
   * D78: the most recent completed items with an estimate, newest first: of session `sessionId`, or
   * of every session in folder `folder`. D147: only those measured in working time (calibration's).
   */
  async recentEstimated(where: { readonly sessionId: string } | { readonly folder: string }, limit: number): Promise<TodoActualSample[]> {
    const [column, value] = 'sessionId' in where ? ['session_id', where.sessionId] : ['folder', where.folder];
    const rows = this.#ctx.db
      .prepare(`SELECT estimate_minutes, actual_ms, actual_tokens, working_ms, measure FROM todo_actuals WHERE ${column} = ? AND estimate_minutes IS NOT NULL AND measure = 'working' ORDER BY completed_at DESC, rowid DESC LIMIT ?`)
      .all(value, limit);
    return rows.map(sampleOf);
  }

  /** D75: records the finish reminder of the item's current start (`updated_at` unchanged: it is not an edit). */
  async markReminded(id: string): Promise<TodoRecord | null> {
    return this.#table.update(id, { remindedAt: this.#ctx.now() });
  }

  /** D81: marks a just-added item as captured (`from`) and, when `needsEnrichment`, as waiting for its agent to fill it in. */
  async markCaptured(id: string, from: TodoCaptureSource, needsEnrichment: boolean): Promise<TodoRecord | null> {
    return this.#table.update(id, { capturedFrom: from, needsEnrichment, enrichAskedAt: null });
  }

  /** D81: the session's open items that wait for their agent to fill them in and were not asked yet, in list order. */
  async pendingEnrichment(sessionId: string): Promise<TodoRecord[]> {
    return this.#table.select(`session_id = ? AND needs_enrichment = 1 AND enrich_asked_at IS NULL AND state = 'open'`, [sessionId], 'position, created_at, id');
  }

  /** D81: records that the agent was asked to fill these items in (`updated_at` unchanged: it is not an edit). */
  async markEnrichAsked(ids: readonly string[]): Promise<void> {
    const now = this.#ctx.now();
    transaction(this.#ctx.db, () => {
      for (const id of ids) this.#table.update(id, { enrichAskedAt: now });
    });
  }

  /** D81: the item no longer waits to be filled in (the agent's `todo_update`, or the developer's own edit). */
  async clearEnrichment(id: string): Promise<TodoRecord | null> {
    return this.#table.update(id, { needsEnrichment: false });
  }

  async delete(id: string): Promise<boolean> {
    // D147: an item in progress leaves its session's split.
    return transaction(this.#ctx.db, () => {
      const record = this.#table.get(id);
      if (!record) return false;
      const now = this.#ctx.now();
      const sessions = [this.#workingSession(record)];
      this.#settle(sessions, now);
      const deleted = this.#table.delete(id as SQLInputValue);
      this.#settle(sessions, now);
      return deleted;
    });
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
      // D147: the moved items in progress work on the fresh session's clock from now on.
      const now = this.#ctx.now();
      this.#settle([fromSessionId, toSessionId], now);
      const moved = this.#ctx.db.prepare('UPDATE session_todos SET session_id = ?, position = position + ? WHERE session_id = ?').run(toSessionId, offset, fromSessionId);
      this.#settle([fromSessionId, toSessionId], now);
      return Number(moved.changes);
    });
  }

  /**
   * D83 × D76 / D78: a session continued in a fresh one hands its run links and its
   * completed items' actuals to the fresh session: items whose run session it was are now
   * run by `toSessionId` (still `active` / `discarded` as they were), and the `todo_actuals`
   * history of its list follows the list. Answers the sessions whose lists hold the relinked
   * items (to publish them).
   */
  async followContinuation(fromSessionId: string, toSessionId: string): Promise<string[]> {
    return transaction(this.#ctx.db, () => {
      const rows = this.#ctx.db.prepare('SELECT DISTINCT session_id FROM session_todos WHERE run_session_id = ?').all(fromSessionId);
      const now = this.#ctx.now();
      this.#settle([fromSessionId, toSessionId], now);
      this.#ctx.db.prepare('UPDATE session_todos SET run_session_id = ?, updated_at = ? WHERE run_session_id = ?').run(toSessionId, now, fromSessionId);
      this.#settle([fromSessionId, toSessionId], now);
      this.#ctx.db.prepare('UPDATE todo_actuals SET session_id = ? WHERE session_id = ?').run(toSessionId, fromSessionId);
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
  const working = row['working_ms'];
  return {
    estimateMinutes: typeof estimate === 'number' || typeof estimate === 'bigint' ? Number(estimate) : null,
    actualMs: Number(row['actual_ms'] ?? 0),
    actualTokens: typeof tokens === 'number' || typeof tokens === 'bigint' ? Number(tokens) : null,
    // D147: an open-time-only row (finished before D147) has no working time.
    workingMs: row['measure'] === 'working' && (typeof working === 'number' || typeof working === 'bigint') ? Number(working) : null,
  };
}

/**
 * D147: an item without a working clock gets one (from 0) when it goes in progress or is
 * reopened: a new item's first start, and a done item measured in open time only (finished
 * before D147) that is reopened: its old open time stays in `actual_ms`, its working time
 * counts from the reopen.
 */
function clockFrom(current: Pick<TodoRecord, 'workingMs'>): Partial<TodoRecord> {
  return (current.workingMs ?? null) === null ? { workingMs: 0, workingSpanStartedAt: null, workingShare: null } : {};
}
