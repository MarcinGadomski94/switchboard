import type { StatementSync } from 'node:sqlite';
import type { RepoContext } from '../context.ts';

/** D88 (0038): one stored draft (`session_drafts`); `value` is the parsed JSON. */
export interface DraftRecord {
  readonly sessionId: string;
  readonly field: string;
  readonly value: unknown;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

interface DraftRow {
  readonly session_id: string;
  readonly field: string;
  readonly value: string;
  readonly updated_at: string;
  readonly updated_by: string;
}

function record(row: DraftRow): DraftRecord {
  let value: unknown = null;
  try {
    value = JSON.parse(row.value) as unknown;
  } catch {
    value = null;
  }
  return { sessionId: row.session_id, field: row.field, value, updatedAt: row.updated_at, updatedBy: row.updated_by };
}

/** D88: the sessions' drafts (`docs/chat.md` → *Drafts*). Removed with their session (`ON DELETE CASCADE`). */
export class DraftRepository {
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

  /** The session's drafts, by field. */
  async list(sessionId: string): Promise<DraftRecord[]> {
    const rows = this.#statement('SELECT * FROM session_drafts WHERE session_id = ? ORDER BY field').all(sessionId) as unknown as DraftRow[];
    return rows.map(record);
  }

  async get(sessionId: string, field: string): Promise<DraftRecord | null> {
    const row = this.#statement('SELECT * FROM session_drafts WHERE session_id = ? AND field = ?').get(sessionId, field) as unknown as DraftRow | undefined;
    return row ? record(row) : null;
  }

  /** How many drafts the session has. */
  async count(sessionId: string): Promise<number> {
    const row = this.#statement('SELECT COUNT(*) AS n FROM session_drafts WHERE session_id = ?').get(sessionId) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** Inserts or replaces the draft (last write wins). */
  async put(sessionId: string, field: string, value: unknown, updatedBy: string): Promise<DraftRecord> {
    const updatedAt = this.#ctx.now();
    this.#statement(
      'INSERT INTO session_drafts (session_id, field, value, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT (session_id, field) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
    ).run(sessionId, field, JSON.stringify(value), updatedAt, updatedBy);
    return { sessionId, field, value, updatedAt, updatedBy };
  }

  /** Removes the draft; `true` when there was one. */
  async delete(sessionId: string, field: string): Promise<boolean> {
    return Number(this.#statement('DELETE FROM session_drafts WHERE session_id = ? AND field = ?').run(sessionId, field).changes) > 0;
  }
}
