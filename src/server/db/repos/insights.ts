import type { StatementSync } from 'node:sqlite';
import {
  EMPTY_USAGE,
  type InsightReading,
  type MergeDecisionRow,
  type TodoActualRow,
  type TokenSplit,
  type TurnRollupRow,
  modelKey,
  payloadTokenSplit,
  readTokenUsage,
  utcDay,
} from '../../../core/insights.ts';
import type { TodoPriority } from '../../../core/api.ts';
import { type ModelTotals, type UsageTurnRow, agentTokensOfTurn, backgroundSessionId, readModelTotals } from '../../../core/usage-breakdown.ts';
import type { RepoContext } from '../context.ts';
import { transaction } from '../database.ts';

/** The Inbox kind of D102's "Ready to merge" item (`src/server/inbox/system-items.ts`). */
const PLAN_READY_TO_MERGE = 'plan-ready-to-merge';

/** What one event adds to the rollup. */
interface Delta {
  readonly turns: number;
  readonly errorTurns: number;
  readonly tokens: number;
  readonly split: TokenSplit | null;
  readonly durationMs: number;
  readonly reverts: number;
  readonly redos: number;
}

/** The parts of a stored event the rollup reads. */
export interface RollupEvent {
  readonly id: number;
  readonly sessionId: string;
  readonly ts: string;
  readonly payload: unknown;
}

/** A session's dimensions as the rollup stores them. */
interface SessionDims {
  readonly origin: string;
  readonly provider: string;
  readonly chosenModel: string | null;
  readonly profileId: string;
  readonly folder: string;
  readonly kind: 'session' | 'chat';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** The rollup delta of an event's payload; `null` when it adds nothing (not a result or a revert). */
export function rollupDelta(payload: unknown): { readonly delta: Delta; readonly model: string | null } | null {
  if (!isRecord(payload)) return null;
  if (payload['type'] === 'result') {
    const split = payloadTokenSplit(payload['usage']);
    const tokens = num(payload['tokens']);
    return {
      delta: { turns: 1, errorTurns: payload['isError'] === true ? 1 : 0, tokens, split, durationMs: num(payload['durationMs']), reverts: 0, redos: 0 },
      model: typeof payload['model'] === 'string' ? payload['model'] : null,
    };
  }
  if (payload['type'] === 'lifecycle' && (payload['action'] === 'reverted' || payload['action'] === 'revert-undone')) {
    const revert = payload['action'] === 'reverted';
    return { delta: { turns: 0, errorTurns: 0, tokens: 0, split: null, durationMs: 0, reverts: revert ? 1 : 0, redos: revert ? 0 : 1 }, model: null };
  }
  return null;
}

/** D136: one model's tokens of a background run (a memory check), as {@link InsightsRepository.recordBackgroundTurn} stores it. */
export interface BackgroundTurn {
  readonly ts: string;
  readonly kind: 'memory-check';
  readonly provider: string;
  readonly model: string;
  readonly profileId: string;
  readonly folder: string;
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly durationMs: number;
}

/**
 * D108 (`docs/insights.md`): the daily turn rollup (`insight_turns_daily`, 0045) and the
 * reads of the Insights page. Every event write goes through {@link recordEvent} (the events
 * repository calls it, like D97's index), so the rollup is current without scanning events;
 * the events written before 0045 are added by the background backfill
 * (`src/server/insights/backfill.ts`).
 */
export class InsightsRepository {
  readonly #ctx: RepoContext;
  readonly #statements = new Map<string, StatementSync>();
  #onError: (error: unknown) => void = (error) => console.error('switchboard insights rollup:', error);
  /** `false` in a store built without migration 0045 (tests with an older schema). */
  readonly enabled: boolean;
  /** D134: `false` in a store built without migration 0050 (`insight_turns`). */
  readonly turnsEnabled: boolean;
  /** D136: `false` in a store built without migration 0051 (`insight_background_turns`). */
  readonly backgroundEnabled: boolean;
  #upto: number | null = null;
  #turnsUpto: number | null = null;
  /** Bumped on every rollup write (the service's cache key). */
  revision = 0;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.enabled = ctx.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'insight_turns_daily'").get() !== undefined;
    this.turnsEnabled = ctx.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'insight_turns'").get() !== undefined;
    this.backgroundEnabled = ctx.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'insight_background_turns'").get() !== undefined;
  }

  // Project memory (D107) hook, D136: the memory checks' tokens (docs/memory-removal.md).
  /**
   * D136: records the tokens of work Switchboard ran by itself without a session (a memory check),
   * one row per model, so Insights → Usage counts them (kind "Memory check", the folder's).
   */
  recordBackgroundTurn(row: BackgroundTurn): void {
    if (!this.backgroundEnabled) return;
    this.#statement(
      `INSERT INTO insight_background_turns (ts, kind, provider, model, profile_id, folder, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.ts, row.kind, row.provider, row.model, row.profileId, row.folder, row.input, row.output, row.cacheWrite, row.cacheRead, Math.max(0, Math.round(row.durationMs)));
    this.revision += 1;
  }

  /** Where a failed rollup write is reported (it never fails the event write). */
  set onError(handler: (error: unknown) => void) {
    this.#onError = handler;
  }

  #statement(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#ctx.db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  /** `insight_state` value, `null` when unset. */
  getState(key: string): string | null {
    const row = this.#statement('SELECT value FROM insight_state WHERE key = ?').get(key);
    return row ? String(row['value']) : null;
  }

  setState(key: string, value: string): void {
    this.#statement('INSERT INTO insight_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** The newest event id 0045 saw: events up to it are the backfill's. */
  get upto(): number {
    this.#upto ??= Number(this.getState('events.upto') ?? 0);
    return this.#upto;
  }

  /** D134: the newest event id 0050 saw: events up to it are the turns backfill's. */
  get turnsUpto(): number {
    this.#turnsUpto ??= Number(this.getState('turns.upto') ?? 0);
    return this.#turnsUpto;
  }

  #dims(sessionId: string): SessionDims | null {
    const row = this.#statement("SELECT origin, provider, model, COALESCE(profile_id, 'default-' || provider) AS profile_id, root, kind FROM sessions WHERE id = ?").get(sessionId);
    if (!row) return null;
    return {
      origin: String(row['origin'] ?? 'switchboard'),
      provider: String(row['provider'] ?? ''),
      chosenModel: typeof row['model'] === 'string' ? row['model'] : null,
      profileId: typeof row['profile_id'] === 'string' ? row['profile_id'] : '',
      folder: typeof row['root'] === 'string' ? row['root'] : '',
      kind: row['kind'] === 'chat' ? 'chat' : 'session',
    };
  }

  #add(day: string, sessionId: string, dims: SessionDims, model: string, delta: Delta): void {
    const split = delta.split;
    this.#statement(
      `INSERT INTO insight_turns_daily (day, session_id, provider, model, profile_id, folder, kind, turns, error_turns, tokens, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, unsplit_tokens, duration_ms, reverts, redos)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (day, session_id, provider, model, profile_id) DO UPDATE SET
         turns = turns + excluded.turns, error_turns = error_turns + excluded.error_turns, tokens = tokens + excluded.tokens,
         input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens,
         cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens, cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
         unsplit_tokens = unsplit_tokens + excluded.unsplit_tokens, duration_ms = duration_ms + excluded.duration_ms,
         reverts = reverts + excluded.reverts, redos = redos + excluded.redos`,
    ).run(
      day,
      sessionId,
      dims.provider,
      model,
      dims.profileId,
      dims.folder,
      dims.kind,
      delta.turns,
      delta.errorTurns,
      delta.tokens,
      split?.input ?? 0,
      split?.output ?? 0,
      split?.cacheWrite ?? 0,
      split?.cacheRead ?? 0,
      split ? 0 : delta.tokens,
      delta.durationMs,
      delta.reverts,
      delta.redos,
    );
    this.revision += 1;
  }

  /** The model the CLI reported for the session's newest turn written before event `beforeId`; `null` when none did. */
  #lastTurnModel(sessionId: string, beforeId: number): string | null {
    const row = this.#statement(
      "SELECT json_extract(payload, '$.model') AS m FROM events WHERE session_id = ? AND id < ? AND kind IN ('ok', 'error', 'text') AND json_extract(payload, '$.type') = 'result' ORDER BY id DESC LIMIT 1",
    ).get(sessionId, beforeId);
    return typeof row?.['m'] === 'string' ? row['m'] : null;
  }

  /** Adds one event to the rollup (a result or a D80 revert / Redo; anything else adds nothing). */
  #roll(event: RollupEvent, dimsOf: (sessionId: string) => SessionDims | null): void {
    const parsed = rollupDelta(event.payload);
    if (!parsed) return;
    const dims = dimsOf(event.sessionId);
    if (!dims) return;
    const at = Date.parse(event.ts);
    if (!Number.isFinite(at)) return;
    // A turn belongs to the model the CLI reported for it; a revert / Redo to the model of the session's newest turn before it.
    const model = parsed.delta.turns > 0 ? parsed.model : this.#lastTurnModel(event.sessionId, event.id);
    this.#add(utcDay(at), event.sessionId, dims, modelKey(model, dims.chosenModel), parsed.delta);
  }

  /**
   * The events repository's hook: rolls up a newly written event (only those after
   * {@link upto}; the earlier ones are the backfill's). Never throws.
   */
  recordEvent(event: RollupEvent): void {
    const daily = this.enabled && event.id > this.upto;
    // D134: a turn's own row (`insight_turns`), for events after 0050 (the earlier ones are the turns backfill's).
    const turn = this.turnsEnabled && event.id > this.turnsUpto;
    if (!daily && !turn) return;
    try {
      let dims: SessionDims | null | undefined;
      const dimsOf = (id: string): SessionDims | null => (dims === undefined ? (dims = this.#dims(id)) : dims);
      if (daily) this.#roll(event, dimsOf);
      if (turn) this.#turn(event, dimsOf);
    } catch (error) {
      this.#onError(error);
    }
  }

  /**
   * D134: adds a `result` event as a row of `insight_turns` (once: the event id is the key), with
   * its subagents', workflow agents' and background calls' tokens (the growth of the CLI's
   * cumulative `modelUsage` since the session's previous turn, minus the turn's own `usage`).
   */
  #turn(event: RollupEvent, dimsOf: (sessionId: string) => SessionDims | null): void {
    const payload = event.payload;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return;
    const record = payload as Record<string, unknown>;
    if (record['type'] !== 'result') return;
    const parsed = rollupDelta(payload);
    if (!parsed) return;
    const dims = dimsOf(event.sessionId);
    if (!dims) return;
    const at = Date.parse(event.ts);
    if (!Number.isFinite(at)) return;
    const split = parsed.delta.split;
    const totals = readModelTotals(record['modelTotals']);
    let agents: Record<string, unknown> = {};
    if (totals && dims.provider === 'claude') {
      const previous = this.#statement('SELECT model_totals FROM insight_turns WHERE session_id = ? AND event_id < ? AND model_totals IS NOT NULL ORDER BY event_id DESC LIMIT 1').get(event.sessionId, event.id);
      let baseline: ModelTotals | null = null;
      try {
        baseline = typeof previous?.['model_totals'] === 'string' ? readModelTotals(JSON.parse(previous['model_totals'])) : null;
      } catch {
        baseline = null;
      }
      // Without a baseline, the CLI started at zero only for the session's first turn ever (a Switchboard session).
      const fresh = baseline === null && dims.origin === 'switchboard' && !this.#hasEarlierResult(event.sessionId, event.id);
      agents = agentTokensOfTurn(totals, baseline, split, parsed.model ?? '', fresh);
    }
    this.#statement(
      `INSERT OR IGNORE INTO insight_turns (event_id, ts, session_id, provider, model, profile_id, folder, kind, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, unsplit_tokens, agent_usage, model_totals, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      new Date(at).toISOString(),
      event.sessionId,
      dims.provider,
      modelKey(parsed.model, dims.chosenModel),
      dims.profileId,
      dims.folder,
      dims.kind,
      split?.input ?? 0,
      split?.output ?? 0,
      split?.cacheWrite ?? 0,
      split?.cacheRead ?? 0,
      split ? 0 : parsed.delta.tokens,
      JSON.stringify(agents),
      totals ? JSON.stringify(totals) : null,
      parsed.delta.durationMs,
    );
    this.revision += 1;
  }

  /** The session has a `result` event before event `beforeId`. */
  #hasEarlierResult(sessionId: string, beforeId: number): boolean {
    return (
      this.#statement("SELECT 1 AS ok FROM events WHERE session_id = ? AND id < ? AND kind IN ('ok', 'error', 'text') AND json_extract(payload, '$.type') = 'result' LIMIT 1").get(sessionId, beforeId) !== undefined
    );
  }

  /**
   * D134: the first event id written at or after `sinceIso` (a binary search over the ids, which
   * grow with time; an imported older event in between only moves the start a little).
   */
  firstEventIdSince(sinceIso: string): number {
    let lo = 1;
    let hi = this.maxEventId();
    if (hi === 0) return 0;
    const tsAt = (id: number): { id: number; ts: string } | null => {
      const row = this.#statement('SELECT id, ts FROM events WHERE id >= ? ORDER BY id LIMIT 1').get(id);
      return row ? { id: Number(row['id']), ts: String(row['ts']) } : null;
    };
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const at = tsAt(mid);
      if (!at || at.ts >= sinceIso) hi = mid;
      else lo = at.id + 1;
    }
    return tsAt(lo)?.id ?? hi;
  }

  /**
   * D134 backfill step: adds the `result` events with `after < id <= upto` (at most `limit`
   * candidates) to `insight_turns`, storing the progress (`turns.done`) in the same transaction.
   */
  backfillTurns(after: number, upto: number, limit: number): { readonly last: number; readonly read: number } {
    const rows = this.#statement("SELECT id, session_id, ts, payload FROM events WHERE id > ? AND id <= ? AND kind IN ('ok', 'error', 'text') ORDER BY id LIMIT ?").all(after, upto, limit);
    let last = after;
    const dims = new Map<string, SessionDims | null>();
    const dimsOf = (id: string): SessionDims | null => {
      if (!dims.has(id)) dims.set(id, this.#dims(id));
      return dims.get(id) ?? null;
    };
    transaction(this.#ctx.db, () => {
      for (const row of rows) {
        last = Number(row['id']);
        const text = row['payload'];
        if (typeof text !== 'string' || !text.includes('"result"')) continue;
        let payload: unknown = null;
        try {
          payload = JSON.parse(text);
        } catch {
          continue;
        }
        this.#turn({ id: last, sessionId: String(row['session_id']), ts: String(row['ts']), payload }, dimsOf);
      }
      this.setState('turns.done', String(rows.length < limit || last >= upto ? upto : last));
    });
    return { last, read: rows.length };
  }

  /** D134: the turns that ended with `fromIso ≤ ts ≤ toIso` (indexed by time); D136: then the background runs of the period. */
  usageTurns(fromIso: string, toIso: string): UsageTurnRow[] {
    if (!this.turnsEnabled) return [];
    return [...this.#sessionTurns(fromIso, toIso), ...this.#backgroundTurns(fromIso, toIso)];
  }

  /** D136: the background runs (`insight_background_turns`) as turns: a negative event id, the folder's pseudo-session (`backgroundSessionId`). */
  #backgroundTurns(fromIso: string, toIso: string): UsageTurnRow[] {
    if (!this.backgroundEnabled) return [];
    return this.#statement('SELECT * FROM insight_background_turns WHERE ts >= ? AND ts <= ? ORDER BY ts, id')
      .all(fromIso, toIso)
      .map(
        (row) =>
          ({
            eventId: -Number(row['id']),
            ts: String(row['ts']),
            sessionId: backgroundSessionId(String(row['folder'])),
            provider: String(row['provider']),
            model: String(row['model']),
            profileId: String(row['profile_id']),
            folder: String(row['folder']),
            kind: 'session',
            usage: { input: Number(row['input_tokens']), output: Number(row['output_tokens']), cacheWrite: Number(row['cache_write_tokens']), cacheRead: Number(row['cache_read_tokens']), unsplit: 0 },
            agents: {},
            durationMs: Number(row['duration_ms']),
          }) satisfies UsageTurnRow,
      );
  }

  #sessionTurns(fromIso: string, toIso: string): UsageTurnRow[] {
    return this.#statement('SELECT * FROM insight_turns WHERE ts >= ? AND ts <= ? ORDER BY ts, event_id')
      .all(fromIso, toIso)
      .map((row) => {
        let agents: Record<string, TokenSplit> = {};
        try {
          const parsed: unknown = JSON.parse(String(row['agent_usage'] ?? '{}'));
          agents = readModelTotals(parsed) ?? {};
        } catch {
          agents = {};
        }
        return {
          eventId: Number(row['event_id']),
          ts: String(row['ts']),
          sessionId: String(row['session_id']),
          provider: String(row['provider']),
          model: String(row['model']),
          profileId: String(row['profile_id']),
          folder: String(row['folder']),
          kind: row['kind'] === 'chat' ? 'chat' : 'session',
          usage: {
            input: Number(row['input_tokens']),
            output: Number(row['output_tokens']),
            cacheWrite: Number(row['cache_write_tokens']),
            cacheRead: Number(row['cache_read_tokens']),
            unsplit: Number(row['unsplit_tokens']),
          },
          agents,
          durationMs: Number(row['duration_ms']),
        } satisfies UsageTurnRow;
      });
  }

  /** D134: of these sessions, those that are routines (a Switchboard loop that has not ended, or a schedule's run). */
  routineSessions(ids: readonly string[]): Set<string> {
    const out = new Set<string>();
    if (ids.length === 0) return out;
    const list = JSON.stringify(ids);
    for (const row of this.#statement(
      "SELECT id FROM sessions WHERE id IN (SELECT value FROM json_each(?)) AND (schedule_id IS NOT NULL OR EXISTS (SELECT 1 FROM session_loops l WHERE l.session_id = sessions.id AND l.state <> 'ended'))",
    ).all(list)) {
      out.add(String(row['id']));
    }
    return out;
  }

  /** The newest event id. */
  maxEventId(): number {
    return Number(this.#statement('SELECT COALESCE(MAX(id), 0) AS n FROM events').get()?.['n'] ?? 0);
  }

  /** Events with `after < id <= upto` (the backfill's total). */
  countEvents(after: number, upto: number): number {
    return Number(this.#statement("SELECT COUNT(*) AS n FROM events WHERE id > ? AND id <= ? AND kind IN ('ok', 'error', 'text')").get(after, upto)?.['n'] ?? 0);
  }

  /**
   * Backfill step: rolls up the candidate events (results and lifecycle lines: kinds `ok`,
   * `error`, `text`) with `after < id <= upto`, at most `limit`, in one transaction that also
   * stores the progress (`events.done`: the last id, or `upto` once fewer than `limit` were
   * left). Returns the last id read (`after` when none) and how many were read.
   */
  backfillEvents(after: number, upto: number, limit: number): { readonly last: number; readonly read: number } {
    const rows = this.#statement("SELECT id, session_id, ts, payload FROM events WHERE id > ? AND id <= ? AND kind IN ('ok', 'error', 'text') ORDER BY id LIMIT ?").all(after, upto, limit);
    let last = after;
    const dims = new Map<string, SessionDims | null>();
    const dimsOf = (id: string): SessionDims | null => {
      if (!dims.has(id)) dims.set(id, this.#dims(id));
      return dims.get(id) ?? null;
    };
    transaction(this.#ctx.db, () => {
      for (const row of rows) {
        last = Number(row['id']);
        const text = row['payload'];
        if (typeof text !== 'string' || (!text.includes('"result"') && !text.includes('"lifecycle"'))) continue;
        let payload: unknown = null;
        try {
          payload = JSON.parse(text);
        } catch {
          continue;
        }
        this.#roll({ id: last, sessionId: String(row['session_id']), ts: String(row['ts']), payload }, dimsOf);
      }
      // The progress in the same transaction: a crash never counts a batch twice.
      this.setState('events.done', String(rows.length < limit || last >= upto ? upto : last));
    });
    return { last, read: rows.length };
  }

  /** The rollup rows of days `from`–`to` (`YYYY-MM-DD`, included). */
  rollup(from: string, to: string): TurnRollupRow[] {
    return this.#statement('SELECT * FROM insight_turns_daily WHERE day >= ? AND day <= ?')
      .all(from, to)
      .map((row) => ({
        day: String(row['day']),
        sessionId: String(row['session_id']),
        provider: String(row['provider']),
        model: String(row['model']),
        profileId: String(row['profile_id']),
        folder: String(row['folder']),
        kind: row['kind'] === 'chat' ? 'chat' : 'session',
        turns: Number(row['turns']),
        errorTurns: Number(row['error_turns']),
        tokens: Number(row['tokens']),
        usage: {
          input: Number(row['input_tokens']),
          output: Number(row['output_tokens']),
          cacheWrite: Number(row['cache_write_tokens']),
          cacheRead: Number(row['cache_read_tokens']),
          unsplit: Number(row['unsplit_tokens']),
        },
        durationMs: Number(row['duration_ms']),
        reverts: Number(row['reverts']),
        redos: Number(row['redos']),
      }));
  }

  /** Completed todos with `fromIso ≤ completed_at < toIso`, with their reopen counts. */
  todoActuals(fromIso: string, toIso: string): TodoActualRow[] {
    return this.#statement(
      `SELECT a.*, (SELECT COUNT(*) FROM todo_reopens r WHERE r.todo_id = a.todo_id) AS reopens
       FROM todo_actuals a WHERE a.completed_at >= ? AND a.completed_at < ?`,
    )
      .all(fromIso, toIso)
      .map((row) => {
        let usage = null;
        try {
          usage = typeof row['usage'] === 'string' ? readTokenUsage(JSON.parse(row['usage'])) : null;
        } catch {
          usage = null;
        }
        const tokens = row['actual_tokens'];
        return {
          todoId: String(row['todo_id']),
          sessionId: String(row['session_id']),
          runSessionId: typeof row['run_session_id'] === 'string' ? row['run_session_id'] : null,
          folder: typeof row['folder'] === 'string' ? row['folder'] : '',
          title: String(row['title']),
          priority: typeof row['priority'] === 'string' ? (row['priority'] as TodoPriority) : null,
          estimateMinutes: typeof row['estimate_minutes'] === 'number' || typeof row['estimate_minutes'] === 'bigint' ? Number(row['estimate_minutes']) : null,
          actualMs: Number(row['actual_ms']),
          // D147: an open-time-only row (before D147) has no working time.
          workingMs: row['measure'] === 'working' && (typeof row['working_ms'] === 'number' || typeof row['working_ms'] === 'bigint') ? Number(row['working_ms']) : null,
          actualTokens: tokens === null || tokens === undefined ? null : Number(tokens),
          usage: usage ?? (tokens === null || tokens === undefined ? EMPTY_USAGE : { ...EMPTY_USAGE, unsplit: Number(tokens) }),
          provider: typeof row['provider'] === 'string' ? row['provider'] : '',
          model: modelKey(null, typeof row['model'] === 'string' ? row['model'] : null),
          profileId: typeof row['profile_id'] === 'string' ? row['profile_id'] : '',
          completedAt: String(row['completed_at']),
          reopens: Number(row['reopens'] ?? 0),
        } satisfies TodoActualRow;
      });
  }

  /**
   * D102 Merge-step decisions closed with `fromIso ≤ closed_at < toIso`: the Inbox's "Ready to
   * merge" items closed `merged`, `sent-back` or `failed`, with their session's dimensions.
   */
  mergeDecisions(fromIso: string, toIso: string): MergeDecisionRow[] {
    return this.#statement(
      `SELECT i.payload AS payload, i.closed_action AS action, i.closed_at AS at, s.provider AS provider, s.model AS model, COALESCE(s.profile_id, 'default-' || s.provider) AS profile_id, s.root AS root
       FROM system_items i LEFT JOIN sessions s ON s.id = i.session_id
       WHERE i.kind = ? AND i.state = 'closed' AND i.closed_at >= ? AND i.closed_at < ? AND i.closed_action IN ('merged', 'sent-back', 'failed')`,
    )
      .all(PLAN_READY_TO_MERGE, fromIso, toIso)
      .map((row) => {
        let itemId = '';
        try {
          const payload: unknown = typeof row['payload'] === 'string' ? JSON.parse(row['payload']) : null;
          if (isRecord(payload) && typeof payload['itemId'] === 'string') itemId = payload['itemId'];
        } catch {
          itemId = '';
        }
        return {
          itemId,
          decision: row['action'] as MergeDecisionRow['decision'],
          at: String(row['at']),
          provider: typeof row['provider'] === 'string' ? row['provider'] : '',
          model: modelKey(null, typeof row['model'] === 'string' ? row['model'] : null),
          profileId: typeof row['profile_id'] === 'string' ? row['profile_id'] : '',
          folder: typeof row['root'] === 'string' ? row['root'] : '',
        };
      });
  }

  /** Usage readings received at or after `sinceIso`, oldest first (the forecast). */
  readings(sinceIso: string): InsightReading[] {
    return this.#statement('SELECT profile_id, received_at, five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at FROM usage_readings WHERE received_at >= ? ORDER BY received_at, id')
      .all(sinceIso)
      .map((row) => ({
        profileId: String(row['profile_id']),
        receivedAt: String(row['received_at']),
        fiveHourPct: typeof row['five_hour_pct'] === 'number' ? row['five_hour_pct'] : null,
        fiveHourResetsAt: typeof row['five_hour_resets_at'] === 'string' ? row['five_hour_resets_at'] : null,
        sevenDayPct: typeof row['seven_day_pct'] === 'number' ? row['seven_day_pct'] : null,
        sevenDayResetsAt: typeof row['seven_day_resets_at'] === 'string' ? row['seven_day_resets_at'] : null,
      }));
  }

  /** Titles (else names) of these sessions. */
  sessionTitles(ids: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    for (const row of this.#statement('SELECT id, title, name FROM sessions WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids))) {
      const title = typeof row['title'] === 'string' && row['title'] !== '' ? row['title'] : String(row['name']);
      out.set(String(row['id']), title);
    }
    return out;
  }

  /** The session dimensions of these sessions (a plan item's run session). */
  sessionDims(ids: readonly string[]): Map<string, { provider: string; model: string; profileId: string; folder: string }> {
    const out = new Map<string, { provider: string; model: string; profileId: string; folder: string }>();
    if (ids.length === 0) return out;
    for (const row of this.#statement("SELECT id, provider, model, COALESCE(profile_id, 'default-' || provider) AS profile_id, root FROM sessions WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids))) {
      out.set(String(row['id']), {
        provider: String(row['provider'] ?? ''),
        model: modelKey(null, typeof row['model'] === 'string' ? row['model'] : null),
        profileId: typeof row['profile_id'] === 'string' ? row['profile_id'] : '',
        folder: typeof row['root'] === 'string' ? row['root'] : '',
      });
    }
    return out;
  }
}
