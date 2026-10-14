import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryAuthorKind, MemoryEntry, MemoryStatus } from '../../core/memory.ts';
import { openDatabase } from '../db/database.ts';
import { type Migration, makeMigration, migrate } from '../db/migrate.ts';

/**
 * D107 · Project memory's own SQLite file (`docs/memory.md` → *Storage*): `<dataDir>/memory.db`,
 * separate from `switchboard.db` so the feature can be removed by deleting the file
 * (`docs/memory-removal.md`). Opened (and created) only while Project memory is switched on; its
 * own migration list runs through the main database's runner (`db/migrate.ts`, as Team's
 * `team.db` and Plans' `plans.db` do). Sessions are plain ids here (no foreign key across files).
 */

/** The file inside the data folder. */
export const MEMORY_DB_FILE = 'memory.db';

/** Project memory's migrations (never edited once released; add a new one). */
export const MEMORY_MIGRATIONS: readonly Migration[] = [
  makeMigration(
    1,
    'memory',
    `-- D107: Project memory (docs/memory.md): facts and conventions per folder that agents propose and
-- the developer approves; only approved entries reach a session.
-- memory_entries:
--   id                 10 hex characters (the service makes them).
--   scope              the folder (a session's canonical root: a workspace or a repo).
--   title, text        as approved (the developer's edit is the approved version).
--   tags               JSON list of short words.
--   author_kind        agent (proposed with memory_propose) | developer (added by hand: approved at once).
--   author_session_id  the proposing session (switchboard.db), NULL for the developer.
--   author_label       the proposing session's title when it proposed.
--   status             proposed | approved | rejected (only approved is ever injected or listed to agents).
--   pinned             0 | 1 (pinned first in the block).
--   decided_at / decided_by  when the developer approved or rejected it ('developer'), NULL while proposed.
--   proposed_title / proposed_text  the agent's own words when the developer changed them, else NULL.
-- memory_meta: key / value settings of the feature (cap: the block's size in characters).
CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  author_kind TEXT NOT NULL CHECK (author_kind IN ('agent', 'developer')),
  author_session_id TEXT,
  author_label TEXT,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected')),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT CHECK (decided_by IS NULL OR decided_by = 'developer'),
  proposed_title TEXT,
  proposed_text TEXT
) STRICT;
CREATE INDEX memory_entries_scope ON memory_entries (scope, status);
CREATE INDEX memory_entries_author ON memory_entries (author_session_id, created_at);
CREATE TABLE memory_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
`,
  ),
];

interface Row {
  id: string;
  scope: string;
  title: string;
  text: string;
  tags: string;
  author_kind: string;
  author_session_id: string | null;
  author_label: string | null;
  status: string;
  pinned: number;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  decided_by: string | null;
  proposed_title: string | null;
  proposed_text: string | null;
}

function toEntry(row: Row): MemoryEntry {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags) as unknown;
    if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === 'string');
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    scope: row.scope,
    title: row.title,
    text: row.text,
    tags,
    authorKind: row.author_kind as MemoryAuthorKind,
    authorSessionId: row.author_session_id,
    authorLabel: row.author_label,
    status: row.status as MemoryStatus,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by === 'developer' ? 'developer' : null,
    proposedTitle: row.proposed_title,
    proposedText: row.proposed_text,
  };
}

/** A row patch (only the fields given change). */
export type MemoryPatch = Partial<Pick<MemoryEntry, 'title' | 'text' | 'tags' | 'pinned' | 'status' | 'decidedAt' | 'decidedBy' | 'proposedTitle' | 'proposedText' | 'updatedAt'>>;

const COLUMNS: Readonly<Record<keyof MemoryPatch, string>> = {
  title: 'title',
  text: 'text',
  tags: 'tags',
  pinned: 'pinned',
  status: 'status',
  decidedAt: 'decided_at',
  decidedBy: 'decided_by',
  proposedTitle: 'proposed_title',
  proposedText: 'proposed_text',
  updatedAt: 'updated_at',
};

/** The Project memory database: one connection, its entries and its settings. */
export class MemoryDb {
  readonly #db: DatabaseSync;
  readonly file: string;
  #closed = false;

  private constructor(db: DatabaseSync, file: string) {
    this.#db = db;
    this.file = file;
  }

  /**
   * Opens (creating when missing) `<dataDir>/memory.db` and brings it up to date.
   * @throws when the file cannot be opened or a migration fails: Project memory then answers 503 and injects nothing.
   */
  static async open(dataDir: string, migrations: readonly Migration[] = MEMORY_MIGRATIONS): Promise<MemoryDb> {
    const file = path.join(dataDir, MEMORY_DB_FILE);
    const db = await openDatabase(file);
    try {
      migrate(db, migrations);
      for (const table of ['memory_entries', 'memory_meta']) db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    } catch (error) {
      db.close();
      throw error;
    }
    return new MemoryDb(db, file);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  get closed(): boolean {
    return this.#closed;
  }

  insert(entry: MemoryEntry): MemoryEntry {
    this.#db
      .prepare(
        `INSERT INTO memory_entries (id, scope, title, text, tags, author_kind, author_session_id, author_label, status, pinned, created_at, updated_at, decided_at, decided_by, proposed_title, proposed_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.scope,
        entry.title,
        entry.text,
        JSON.stringify(entry.tags),
        entry.authorKind,
        entry.authorSessionId,
        entry.authorLabel,
        entry.status,
        entry.pinned ? 1 : 0,
        entry.createdAt,
        entry.updatedAt,
        entry.decidedAt,
        entry.decidedBy,
        entry.proposedTitle,
        entry.proposedText,
      );
    return entry;
  }

  get(id: string): MemoryEntry | null {
    const row = this.#db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(id) as Row | undefined;
    return row ? toEntry(row) : null;
  }

  /** Entries, oldest first; filtered by folder and / or states. */
  list(filter: { readonly scope?: string; readonly statuses?: readonly MemoryStatus[] } = {}): MemoryEntry[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.scope !== undefined) {
      where.push('scope = ?');
      args.push(filter.scope);
    }
    if (filter.statuses && filter.statuses.length > 0) {
      where.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`);
      args.push(...filter.statuses);
    }
    const sql = `SELECT * FROM memory_entries${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, id`;
    return (this.#db.prepare(sql).all(...args) as unknown as Row[]).map(toEntry);
  }

  /** Per folder: how many approved and proposed entries. */
  counts(): Array<{ scope: string; approved: number; proposed: number }> {
    const rows = this.#db
      .prepare(
        `SELECT scope, SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved, SUM(CASE WHEN status = 'proposed' THEN 1 ELSE 0 END) AS proposed
         FROM memory_entries GROUP BY scope ORDER BY scope`,
      )
      .all() as unknown as Array<{ scope: string; approved: number | null; proposed: number | null }>;
    return rows.map((row) => ({ scope: row.scope, approved: Number(row.approved ?? 0), proposed: Number(row.proposed ?? 0) }));
  }

  /** Proposals session `sessionId` made since `sinceIso` (the rate limit; every state counts). */
  proposalsSince(sessionId: string, sinceIso: string): number {
    const row = this.#db.prepare(`SELECT COUNT(*) AS n FROM memory_entries WHERE author_session_id = ? AND author_kind = 'agent' AND created_at >= ?`).get(sessionId, sinceIso) as { n: number };
    return Number(row.n);
  }

  update(id: string, patch: MemoryPatch): MemoryEntry | null {
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    for (const [key, column] of Object.entries(COLUMNS) as Array<[keyof MemoryPatch, string]>) {
      if (!(key in patch)) continue;
      const value = patch[key];
      sets.push(`${column} = ?`);
      if (key === 'tags') args.push(JSON.stringify(value ?? []));
      else if (key === 'pinned') args.push(value ? 1 : 0);
      else args.push((value ?? null) as string | null);
    }
    if (sets.length > 0) this.#db.prepare(`UPDATE memory_entries SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    return this.get(id);
  }

  delete(id: string): boolean {
    return Number(this.#db.prepare('DELETE FROM memory_entries WHERE id = ?').run(id).changes) > 0;
  }

  meta(key: string): string | null {
    const row = this.#db.prepare('SELECT value FROM memory_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.#db.prepare('INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}
