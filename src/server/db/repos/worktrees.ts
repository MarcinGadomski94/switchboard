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
  /** D47 (0013): the parent task branch this worktree is stacked on in its repo; `null` = not stacked here. */
  readonly parentBranch: string | null;
  /** D47: the parent's PR as gh last reported it. */
  readonly parentPrNumber: number | null;
  readonly parentPrUrl: string | null;
  /** D47: verbatim (`OPEN`, `CLOSED`, `MERGED`). */
  readonly parentPrState: string | null;
  /** D47: the parent PR's base branch (`baseRefName`). */
  readonly parentBase: string | null;
  /** D47: the parent's last known tip (gh's `headRefOid`, else the commit the worktree was cut from). */
  readonly parentHeadOid: string | null;
  /** D47: `merge` / `squash` / `unknown`, set when the parent's merge was seen. */
  readonly parentMerge: string | null;
  /** D47: when the parent's PR was seen `MERGED` (the Inbox item and the session message follow once). */
  readonly parentMergedAt: string | null;
  /** D47 ruling (0014): when the parent's PR was seen turning `CLOSED` without a merge (the "Parent … closed" Inbox item follows once). */
  readonly parentClosedAt: string | null;
}

/** Input of {@link WorktreeRepository.create}. */
export type WorktreeCreate = CreateInput<WorktreeRecord, 'repo' | 'repoPath' | 'branch' | 'path', 'createdAt' | 'updatedAt'>;

/** The D47 parent fields of a record. */
export type WorktreeParentFields = Pick<
  WorktreeRecord,
  'parentBranch' | 'parentPrNumber' | 'parentPrUrl' | 'parentPrState' | 'parentBase' | 'parentHeadOid' | 'parentMerge' | 'parentMergedAt' | 'parentClosedAt'
>;

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
    parentBranch: ['parent_branch', 'text'],
    parentPrNumber: ['parent_pr_number', 'int'],
    parentPrUrl: ['parent_pr_url', 'text'],
    parentPrState: ['parent_pr_state', 'text'],
    parentBase: ['parent_base', 'text'],
    parentHeadOid: ['parent_head_oid', 'text'],
    parentMerge: ['parent_merge', 'text'],
    parentMergedAt: ['parent_merged_at', 'text'],
    parentClosedAt: ['parent_closed_at', 'text'],
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
