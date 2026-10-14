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
  #upto: number | null = null;
  /** Bumped on every rollup write (the service's cache key). */
  revision = 0;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.enabled = ctx.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'insight_turns_daily'").get() !== undefined;
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

  #dims(sessionId: string): SessionDims | null {
    const row = this.#statement("SELECT provider, model, COALESCE(profile_id, 'default-' || provider) AS profile_id, root, kind FROM sessions WHERE id = ?").get(sessionId);
    if (!row) return null;
    return {
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

  /** Adds one event to the rollup (a result or a D80 revert / Redo; anything else adds nothing). */
  #roll(event: RollupEvent, dimsOf: (sessionId: string) => SessionDims | null): void {
    const parsed = rollupDelta(event.payload);
    if (!parsed) return;
    const dims = dimsOf(event.sessionId);
    if (!dims) return;
    const at = Date.parse(event.ts);
    if (!Number.isFinite(at)) return;
    // A revert belongs to the model the session runs on; a turn to the one the CLI reported.
    this.#add(utcDay(at), event.sessionId, dims, modelKey(parsed.model, dims.chosenModel), parsed.delta);
  }

  /**
   * The events repository's hook: rolls up a newly written event (only those after
   * {@link upto}; the earlier ones are the backfill's). Never throws.
   */
  recordEvent(event: RollupEvent): void {
    if (!this.enabled || event.id <= this.upto) return;
    try {
      this.#roll(event, (id) => this.#dims(id));
    } catch (error) {
      this.#onError(error);
    }
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
