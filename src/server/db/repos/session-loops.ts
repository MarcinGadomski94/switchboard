import type { StatementSync } from 'node:sqlite';
import type { OwnedLoopAuthor, OwnedLoopSchedule, OwnedLoopState } from '../../../core/api.ts';
import type { RepoContext } from '../context.ts';

/** D94 (0041): one stored Switchboard loop (`session_loops`). */
export interface SessionLoopRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly label: string | null;
  readonly prompt: string;
  readonly schedule: OwnedLoopSchedule;
  readonly expiresAt: string | null;
  readonly maxRuns: number | null;
  readonly state: OwnedLoopState;
  readonly endedReason: string | null;
  readonly runs: number;
  readonly skipped: number;
  readonly lastFiredAt: string | null;
  readonly lastEventId: number | null;
  readonly lastError: string | null;
  readonly nextFireAt: string | null;
  readonly createdBy: OwnedLoopAuthor;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a create stores (the rest takes the defaults). */
export type SessionLoopCreate = Pick<SessionLoopRecord, 'id' | 'sessionId' | 'label' | 'prompt' | 'schedule' | 'expiresAt' | 'maxRuns' | 'nextFireAt' | 'createdBy'> &
  Partial<Pick<SessionLoopRecord, 'state' | 'endedReason' | 'runs' | 'skipped' | 'lastFiredAt' | 'createdAt'>>;

/** The fields an update may change. */
export type SessionLoopPatch = Partial<Omit<SessionLoopRecord, 'id' | 'createdAt' | 'updatedAt'>>;

interface Row {
  readonly id: string;
  readonly session_id: string;
  readonly label: string | null;
  readonly prompt: string;
  readonly schedule_kind: string;
  readonly schedule_value: string;
  readonly expires_at: string | null;
  readonly max_runs: number | null;
  readonly state: string;
  readonly ended_reason: string | null;
  readonly runs: number;
  readonly skipped: number;
  readonly last_fired_at: string | null;
  readonly last_event_id: number | null;
  readonly last_error: string | null;
  readonly next_fire_at: string | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

function scheduleOf(kind: string, value: string): OwnedLoopSchedule {
  if (kind === 'every') return { kind: 'every', minutes: Number(value) };
  if (kind === 'at') return { kind: 'at', at: value };
  return { kind: 'cron', cron: value };
}

function scheduleValue(schedule: OwnedLoopSchedule): string {
  return schedule.kind === 'every' ? String(schedule.minutes) : schedule.kind === 'at' ? schedule.at : schedule.cron;
}

function record(row: Row): SessionLoopRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    label: row.label,
    prompt: row.prompt,
    schedule: scheduleOf(row.schedule_kind, row.schedule_value),
    expiresAt: row.expires_at,
    maxRuns: row.max_runs === null ? null : Number(row.max_runs),
    state: row.state as OwnedLoopState,
    endedReason: row.ended_reason,
    runs: Number(row.runs),
    skipped: Number(row.skipped),
    lastFiredAt: row.last_fired_at,
    lastEventId: row.last_event_id === null ? null : Number(row.last_event_id),
    lastError: row.last_error,
    nextFireAt: row.next_fire_at,
    createdBy: row.created_by as OwnedLoopAuthor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Record field → column. */
const COLUMNS: Readonly<Record<string, string>> = {
  sessionId: 'session_id',
  label: 'label',
  prompt: 'prompt',
  expiresAt: 'expires_at',
  maxRuns: 'max_runs',
  state: 'state',
  endedReason: 'ended_reason',
  runs: 'runs',
  skipped: 'skipped',
  lastFiredAt: 'last_fired_at',
  lastEventId: 'last_event_id',
  lastError: 'last_error',
  nextFireAt: 'next_fire_at',
  createdBy: 'created_by',
};

/** D94: the Switchboard loops (`session_loops`, `docs/loops.md`). Removed with their session (`ON DELETE CASCADE`). */
export class SessionLoopRepository {
  readonly #ctx: RepoContext;
  readonly #statements = new Map<string, StatementSync>();

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
  }

  #statement(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#ctx.db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  /** The session's loops, oldest first. */
  async list(sessionId: string): Promise<SessionLoopRecord[]> {
    return (this.#statement('SELECT * FROM session_loops WHERE session_id = ? ORDER BY created_at, rowid').all(sessionId) as unknown as Row[]).map(record);
  }

  /** Every loop (all sessions), oldest first. */
  async listAll(): Promise<SessionLoopRecord[]> {
    return (this.#statement('SELECT * FROM session_loops ORDER BY created_at, rowid').all() as unknown as Row[]).map(record);
  }

  /** The loops that may fire (state `active`). */
  async listActive(): Promise<SessionLoopRecord[]> {
    return (this.#statement("SELECT * FROM session_loops WHERE state = 'active' ORDER BY created_at, rowid").all() as unknown as Row[]).map(record);
  }

  async get(id: string): Promise<SessionLoopRecord | null> {
    const row = this.#statement('SELECT * FROM session_loops WHERE id = ?').get(id) as unknown as Row | undefined;
    return row ? record(row) : null;
  }

  /** How many loops of the session have not ended. */
  async countLive(sessionId: string): Promise<number> {
    const row = this.#statement("SELECT COUNT(*) AS n FROM session_loops WHERE session_id = ? AND state != 'ended'").get(sessionId) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  async create(input: SessionLoopCreate): Promise<SessionLoopRecord> {
    const now = this.#ctx.now();
    this.#statement(
      `INSERT INTO session_loops (id, session_id, label, prompt, schedule_kind, schedule_value, expires_at, max_runs, state, ended_reason, runs, skipped, last_fired_at, next_fire_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.sessionId,
      input.label,
      input.prompt,
      input.schedule.kind,
      scheduleValue(input.schedule),
      input.expiresAt,
      input.maxRuns,
      input.state ?? 'active',
      input.endedReason ?? null,
      input.runs ?? 0,
      input.skipped ?? 0,
      input.lastFiredAt ?? null,
      input.nextFireAt,
      input.createdBy,
      input.createdAt ?? now,
      now,
    );
    return (await this.get(input.id)) as SessionLoopRecord;
  }

  /** Changes the given fields; `null` when there is no such loop. */
  async update(id: string, patch: SessionLoopPatch): Promise<SessionLoopRecord | null> {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (key === 'schedule') {
        const schedule = value as OwnedLoopSchedule;
        sets.push('schedule_kind = ?', 'schedule_value = ?');
        values.push(schedule.kind, scheduleValue(schedule));
        continue;
      }
      const column = COLUMNS[key];
      if (!column) continue;
      sets.push(`${column} = ?`);
      values.push(value as string | number | null);
    }
    sets.push('updated_at = ?');
    values.push(this.#ctx.now());
    this.#ctx.db.prepare(`UPDATE session_loops SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return this.get(id);
  }

  /** Removes the loop; `true` when there was one. */
  async delete(id: string): Promise<boolean> {
    return Number(this.#statement('DELETE FROM session_loops WHERE id = ?').run(id).changes) > 0;
  }

  /** D83: the session's loops become another session's; returns how many moved. */
  async moveAll(fromSessionId: string, toSessionId: string): Promise<number> {
    return Number(this.#statement('UPDATE session_loops SET session_id = ?, updated_at = ? WHERE session_id = ?').run(toSessionId, this.#ctx.now(), fromSessionId).changes);
  }

  /** Removes ended loops last changed before `before` (ISO); returns how many. */
  async pruneEnded(before: string): Promise<number> {
    return Number(this.#statement("DELETE FROM session_loops WHERE state = 'ended' AND updated_at < ?").run(before).changes);
  }
}
