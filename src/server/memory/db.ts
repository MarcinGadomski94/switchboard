import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { type MemoryAuthorKind, type MemoryEntry, type MemoryScopeKind, type MemoryStatus, readScopeKind } from '../../core/memory.ts';
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
  makeMigration(
    2,
    'memory_scopes',
    `-- D107 follow-up 2026-10-15: scopes on every entry (docs/memory.md -> Scopes) and the
-- "Draft memory from this session" asks.
-- memory_entries.scope_kind   workspace (every session of the folder: every entry made before this) |
--                             repo (sessions working in one repository) | member (one Team member).
-- memory_entries.scope_key    repo: the repository's normalized remote key, else its main checkout's path;
--                             member: the member id; NULL for workspace.
-- memory_entries.scope_label  repo: the repository's name; member: the role name; NULL for workspace.
-- memory_draft_asks: the last time each session was asked to draft memory (one ask per 24 hours).
ALTER TABLE memory_entries ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'workspace' CHECK (scope_kind IN ('workspace', 'repo', 'member'));
ALTER TABLE memory_entries ADD COLUMN scope_key TEXT;
ALTER TABLE memory_entries ADD COLUMN scope_label TEXT;
CREATE INDEX memory_entries_scope_key ON memory_entries (scope_kind, scope_key, status);
CREATE TABLE memory_draft_asks (
  session_id TEXT PRIMARY KEY,
  asked_at TEXT NOT NULL
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
  scope_kind: string;
  scope_key: string | null;
  scope_label: string | null;
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
    scopeKind: readScopeKind(row.scope_kind) ?? 'workspace',
    scopeKey: row.scope_key,
    scopeLabel: row.scope_label,
  };
}

/** A row patch (only the fields given change). */
export type MemoryPatch = Partial<Pick<MemoryEntry, 'title' | 'text' | 'tags' | 'pinned' | 'status' | 'decidedAt' | 'decidedBy' | 'proposedTitle' | 'proposedText' | 'updatedAt' | 'scopeKind' | 'scopeKey' | 'scopeLabel' | 'scope'>>;

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
  scopeKind: 'scope_kind',
  scopeKey: 'scope_key',
  scopeLabel: 'scope_label',
  scope: 'scope',
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
      for (const table of ['memory_entries', 'memory_meta', 'memory_draft_asks']) db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
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
        `INSERT INTO memory_entries (id, scope, title, text, tags, author_kind, author_session_id, author_label, status, pinned, created_at, updated_at, decided_at, decided_by, proposed_title, proposed_text, scope_kind, scope_key, scope_label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        entry.scopeKind,
        entry.scopeKind === 'workspace' ? null : entry.scopeKey,
        entry.scopeKind === 'workspace' ? null : entry.scopeLabel,
      );
    return this.get(entry.id) ?? entry;
  }

  get(id: string): MemoryEntry | null {
    const row = this.#db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(id) as Row | undefined;
    return row ? toEntry(row) : null;
  }

  /**
   * Entries, oldest first; filtered by folder and / or states. `visibleTo` (D107 follow-up
   * 2026-10-15) keeps the entries a session sees: the folder's workspace entries, its
   * repositories' and its member's (any folder); it replaces `scope`.
   */
  list(
    filter: {
      readonly scope?: string;
      readonly statuses?: readonly MemoryStatus[];
      readonly scopeKind?: MemoryScopeKind;
      readonly scopeKey?: string;
      readonly visibleTo?: { readonly folder: string; readonly repoKeys: readonly string[]; readonly memberId: string | null };
    } = {},
  ): MemoryEntry[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.visibleTo !== undefined) {
      const { folder, repoKeys, memberId } = filter.visibleTo;
      const any = ["(scope_kind = 'workspace' AND scope = ?)"];
      args.push(folder);
      if (repoKeys.length > 0) {
        any.push(`(scope_kind = 'repo' AND scope_key IN (${repoKeys.map(() => '?').join(', ')}))`);
        args.push(...repoKeys);
      }
      if (memberId !== null) {
        any.push("(scope_kind = 'member' AND scope_key = ?)");
        args.push(memberId);
      }
      where.push(`(${any.join(' OR ')})`);
    } else if (filter.scope !== undefined) {
      where.push('scope = ?');
      args.push(filter.scope);
    }
    if (filter.scopeKind !== undefined) {
      where.push('scope_kind = ?');
      args.push(filter.scopeKind);
    }
    if (filter.scopeKey !== undefined) {
      where.push('scope_key = ?');
      args.push(filter.scopeKey);
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

  /** D107 follow-up 2026-10-15: when `sessionId` was last asked to draft memory (`null`: never). */
  draftAskedAt(sessionId: string): string | null {
    const row = this.#db.prepare('SELECT asked_at FROM memory_draft_asks WHERE session_id = ?').get(sessionId) as { asked_at: string } | undefined;
    return row?.asked_at ?? null;
  }

  setDraftAsked(sessionId: string, at: string | null): void {
    if (at === null) this.#db.prepare('DELETE FROM memory_draft_asks WHERE session_id = ?').run(sessionId);
    else this.#db.prepare('INSERT INTO memory_draft_asks (session_id, asked_at) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET asked_at = excluded.asked_at').run(sessionId, at);
  }

  meta(key: string): string | null {
    const row = this.#db.prepare('SELECT value FROM memory_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.#db.prepare('INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}
