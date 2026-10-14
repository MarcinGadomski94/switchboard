import type { CiStopReason, IssueSource, PrChecksState, PrReviewDecision } from '../../../core/ci.ts';
import type { RepoContext } from '../context.ts';
import { Table, type TableSpec } from '../table.ts';

/** D109 (0046): one PR the PR watcher follows (`pr_watch`), keyed by its worktree. */
export interface PrWatchRecord {
  readonly worktreeId: string;
  readonly sessionId: string | null;
  readonly prNumber: number;
  readonly prUrl: string | null;
  /** `OPEN`, `MERGED`, `CLOSED`. */
  readonly prState: string;
  readonly checks: PrChecksState;
  readonly summary: string | null;
  readonly headSha: string | null;
  readonly review: PrReviewDecision;
  readonly ready: boolean;
  readonly attempts: number;
  readonly failureSha: string | null;
  readonly signature: string | null;
  readonly stopped: CiStopReason | null;
  readonly checkedAt: string | null;
  readonly nextAt: string | null;
  readonly updatedAt: string;
}

/** The writable fields of a {@link PrWatchRecord}. */
export type PrWatchPatch = Partial<Omit<PrWatchRecord, 'worktreeId' | 'updatedAt'>>;

const WATCH: TableSpec<PrWatchRecord> = {
  table: 'pr_watch',
  key: 'worktreeId',
  fields: {
    worktreeId: ['worktree_id', 'text'],
    sessionId: ['session_id', 'text'],
    prNumber: ['pr_number', 'int'],
    prUrl: ['pr_url', 'text'],
    prState: ['pr_state', 'text'],
    checks: ['checks', 'text'],
    summary: ['summary', 'text'],
    headSha: ['head_sha', 'text'],
    review: ['review', 'text'],
    ready: ['ready', 'bool'],
    attempts: ['attempts', 'int'],
    failureSha: ['failure_sha', 'text'],
    signature: ['signature', 'text'],
    stopped: ['stopped', 'text'],
    checkedAt: ['checked_at', 'text'],
    nextAt: ['next_at', 'text'],
    updatedAt: ['updated_at', 'text'],
  },
};

/** D109: the PRs the watcher follows (`docs/ci.md`). A row goes with its worktree record. */
export class PrWatchRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<PrWatchRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, WATCH);
  }

  async get(worktreeId: string): Promise<PrWatchRecord | null> {
    return this.#table.get(worktreeId);
  }

  /** Every row (`open`: only the PRs still open). */
  async list(options: { readonly open?: boolean } = {}): Promise<PrWatchRecord[]> {
    return options.open ? this.#table.select("pr_state = 'OPEN'", [], 'worktree_id') : this.#table.select('', [], 'worktree_id');
  }

  /** A session's rows, newest first. */
  async forSession(sessionId: string): Promise<PrWatchRecord[]> {
    return this.#table.select('session_id = ?', [sessionId], 'updated_at DESC');
  }

  /** Writes the row of `worktreeId` (created with `prNumber` / `prState` when missing); answers the stored row. */
  async upsert(worktreeId: string, patch: PrWatchPatch & Pick<PrWatchRecord, 'prNumber' | 'prState'>): Promise<PrWatchRecord> {
    const ts = this.#ctx.now();
    const existing = this.#table.get(worktreeId);
    if (existing) return this.#table.update(worktreeId, { ...patch, updatedAt: ts }) as PrWatchRecord;
    return this.#table.insert({ worktreeId, ...patch, updatedAt: ts });
  }

  /** Changes an existing row; `null` when there is none. */
  async update(worktreeId: string, patch: PrWatchPatch): Promise<PrWatchRecord | null> {
    return this.#table.update(worktreeId, { ...patch, updatedAt: this.#ctx.now() });
  }
}

/** D109 (0046): an issue imported into a session's todo list. */
export interface TodoImportRecord {
  readonly sessionId: string;
  readonly source: IssueSource;
  readonly externalKey: string;
  readonly url: string | null;
  readonly todoId: string | null;
  readonly importedAt: string;
}

interface ImportRow {
  readonly session_id: string;
  readonly source: string;
  readonly external_key: string;
  readonly url: string | null;
  readonly todo_id: string | null;
  readonly imported_at: string;
}

/** D109: which issues a session's todo list already took in (a re-import skips them). */
export class TodoImportRepository {
  readonly #ctx: RepoContext;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
  }

  /** The keys of `source` already imported into the session. */
  async keys(sessionId: string, source: IssueSource): Promise<Set<string>> {
    const rows = this.#ctx.db.prepare('SELECT external_key FROM todo_imports WHERE session_id = ? AND source = ?').all(sessionId, source) as unknown as Array<{ external_key: string }>;
    return new Set(rows.map((row) => row.external_key));
  }

  /** Every import of the session (oldest first). */
  async list(sessionId: string): Promise<TodoImportRecord[]> {
    const rows = this.#ctx.db.prepare('SELECT * FROM todo_imports WHERE session_id = ? ORDER BY imported_at, external_key').all(sessionId) as unknown as ImportRow[];
    return rows.map((row) => ({ sessionId: row.session_id, source: row.source as IssueSource, externalKey: row.external_key, url: row.url, todoId: row.todo_id, importedAt: row.imported_at }));
  }

  /** Records an import; `false` when the issue was already recorded for the session (nothing written). */
  async record(input: Omit<TodoImportRecord, 'importedAt'>): Promise<boolean> {
    const result = this.#ctx.db
      .prepare('INSERT OR IGNORE INTO todo_imports (session_id, source, external_key, url, todo_id, imported_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.sessionId, input.source, input.externalKey, input.url, input.todoId, this.#ctx.now());
    return Number(result.changes) > 0;
  }

  /** Sets the todo an import became. */
  async setTodo(sessionId: string, source: IssueSource, externalKey: string, todoId: string): Promise<void> {
    this.#ctx.db.prepare('UPDATE todo_imports SET todo_id = ? WHERE session_id = ? AND source = ? AND external_key = ?').run(todoId, sessionId, source, externalKey);
  }

  /** Drops a recorded import (its todo could not be added after all). */
  async forget(sessionId: string, source: IssueSource, externalKey: string): Promise<void> {
    this.#ctx.db.prepare('DELETE FROM todo_imports WHERE session_id = ? AND source = ? AND external_key = ?').run(sessionId, source, externalKey);
  }

  /** D83: a continued session's imports follow its todos to the fresh one. */
  async moveAll(fromSessionId: string, toSessionId: string): Promise<void> {
    this.#ctx.db.prepare('UPDATE OR IGNORE todo_imports SET session_id = ? WHERE session_id = ?').run(toSessionId, fromSessionId);
  }
}
