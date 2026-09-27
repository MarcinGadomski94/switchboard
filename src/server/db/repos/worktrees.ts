import { randomUUID } from 'node:crypto';
import type { CreateInput, Patch, RepoContext } from '../context.ts';
import { Table, type TableSpec, defined } from '../table.ts';

/** A git worktree Switchboard created (gap #1) and tracks until it is removed (gap #3). */
export interface WorktreeRecord {
  readonly id: string;
  /** Solution / repo name, e.g. `acme-app-front`. */
  readonly repo: string;
  /** Absolute path of the repo's main checkout. */
  readonly repoPath: string;
  readonly branch: string;
  /** What the Diff compares against (gap #10), when known. */
  readonly baseRef: string | null;
  /** Absolute worktree path; unique among worktrees that are not removed. */
  readonly path: string;
  readonly sessionId: string | null;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  /** Verbatim from gh (`OPEN`, `MERGED`, `CLOSED`, …). */
  readonly prState: string | null;
  readonly prCheckedAt: string | null;
  readonly removable: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set once the worktree folder is removed (the branch is kept). */
  readonly removedAt: string | null;
}

/** Input of {@link WorktreeRepository.create}. */
export type WorktreeCreate = CreateInput<WorktreeRecord, 'repo' | 'repoPath' | 'branch' | 'path', 'createdAt' | 'updatedAt'>;

/** Input of {@link WorktreeRepository.update}. */
export type WorktreePatch = Patch<WorktreeRecord, 'id' | 'createdAt' | 'updatedAt'>;

/** Filter of {@link WorktreeRepository.list}. */
export interface WorktreeFilter {
  readonly sessionId?: string;
  readonly repo?: string;
  /** Include removed worktrees (default: only live ones). */
  readonly includeRemoved?: boolean;
}

const SPEC: TableSpec<WorktreeRecord> = {
  table: 'worktrees',
  key: 'id',
  fields: {
    id: ['id', 'text'],
    repo: ['repo', 'text'],
    repoPath: ['repo_path', 'text'],
    branch: ['branch', 'text'],
    baseRef: ['base_ref', 'text'],
    path: ['path', 'text'],
    sessionId: ['session_id', 'text'],
    prNumber: ['pr_number', 'int'],
    prUrl: ['pr_url', 'text'],
    prState: ['pr_state', 'text'],
    prCheckedAt: ['pr_checked_at', 'text'],
    removable: ['removable', 'bool'],
    createdAt: ['created_at', 'text'],
    updatedAt: ['updated_at', 'text'],
    removedAt: ['removed_at', 'text'],
  },
};

/** The worktree registry. */
export class WorktreeRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<WorktreeRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  async create(input: WorktreeCreate): Promise<WorktreeRecord> {
    const ts = this.#ctx.now();
    return this.#table.insert({ ...defined(input), id: input.id ?? randomUUID(), createdAt: ts, updatedAt: ts });
  }

  async get(id: string): Promise<WorktreeRecord | null> {
    return this.#table.get(id);
  }

  /** The live (not removed) worktree at `path`, or `null`. */
  async getLiveByPath(path: string): Promise<WorktreeRecord | null> {
    return this.#table.first('path = ? AND removed_at IS NULL', [path]);
  }

  /** Worktrees, oldest first. */
  async list(filter: WorktreeFilter = {}): Promise<WorktreeRecord[]> {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.sessionId !== undefined) {
      where.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.repo !== undefined) {
      where.push('repo = ?');
      params.push(filter.repo);
    }
    if (!filter.includeRemoved) where.push('removed_at IS NULL');
    return this.#table.select(where.join(' AND '), params, 'created_at, rowid');
  }

  async update(id: string, patch: WorktreePatch): Promise<WorktreeRecord | null> {
    return this.#table.update(id, { ...patch, updatedAt: this.#ctx.now() });
  }

  /** Records that the worktree folder was removed. */
  async markRemoved(id: string): Promise<WorktreeRecord | null> {
    const ts = this.#ctx.now();
    return this.#table.update(id, { removedAt: ts, removable: false, updatedAt: ts });
  }
}
