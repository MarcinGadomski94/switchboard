import { lstat, open, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { type BranchingPreflightRow, type DiffCount, type DiffScope, type DiffTargets, type FileDiff, type RepoBranches, type Worktree, offeredDiffScope } from '../../core/api.ts';
import { type SessionBranching, cutPoint, parseSymrefHead } from '../../core/branching.ts';
import {
  PARENT_PR_FIELDS,
  type MergeKind,
  type ParentRef,
  type ParentStatus,
  type RepoBase,
  effectiveParent,
  parentMatches,
  parentText,
  parseParentPullRequest,
  resolveRepoBase,
  storedParent,
} from '../../core/stacking.ts';
import type { UserMessageOrigin } from '../../core/event-payload.ts';
import {
  BRANCH_REF_FORMAT,
  type ExistingBranchNote,
  PR_VIEW_FIELDS,
  type PatchFile,
  type PullRequestInfo,
  isNoPullRequest,
  isSessionWorktree,
  moveToWorktreeMessage,
  parseBranchRefs,
  parsePatch,
  parsePullRequest,
  parseWorktreeList,
  solutionCandidates,
  splitNulList,
  toFileDiff,
  newFileHunkHeader,
  untrackedFileDiff,
  worktreeBranch,
  worktreePath,
} from '../../core/worktrees.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { WorktreeParentFields, WorktreePatch, WorktreeRecord } from '../db/repos/worktrees.ts';
import type { Store } from '../db/store.ts';
import { type FolderRef, folderOfSession, repoSolutionName } from '../folders/ref.ts';
import { type RunOptions, type RunResult, failureText, runCommand, succeeded } from '../exec.ts';
import type { DiffProvider } from '../providers.ts';
import { isReadOnlyByLayout } from '../sessions/validate.ts';
import { SessionTouchedFiles } from './touched.ts';
import { toWorktree } from './wire.ts';
import { checkoutOf, isMainCheckout } from '../solutions/checkout.ts';
import { recordCreatedBranch } from '../cleanup/created-branches.ts';

/** Why the worktree manager refused a call. `code` maps to an HTTP status in the routes. */
export type WorktreeErrorCode =
  | 'folder-missing'
  | 'solution-not-found'
  | 'solution-ambiguous'
  | 'read-only'
  | 'no-commits'
  | 'branch-exists'
  | 'path-exists'
  | 'session-not-found'
  | 'detached'
  | 'not-found'
  | 'removed'
  | 'uncommitted'
  | 'unpushed'
  | 'git-failed'
  // D40: `git fetch origin` failed; the base to cut a task worktree from is not on origin; an existing task branch is checked out elsewhere.
  | 'fetch-failed'
  | 'base-missing'
  | 'branch-checked-out'
  // D47: a typed parent key names several origin branches in a repo.
  | 'parent-ambiguous'
  // D60: the existing branch picked for isolate is not a branch of the repo.
  | 'branch-not-found';

/** A refusal of the worktree manager. Nothing was changed on disk when it is thrown. */
export class WorktreeError extends Error {
  override name = 'WorktreeError';
  readonly code: WorktreeErrorCode;
  constructor(code: WorktreeErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** What isolate needs from the supervisor (gap #2: pause + resume with a message). */
export interface SessionControl {
  isLive(sessionId: string): boolean;
  pause(sessionId: string): Promise<unknown>;
  /** Resumes a session without a live process (`--resume`) and sends `text`. */
  sendMessage(sessionId: string, text: string, origin: UserMessageOrigin): Promise<unknown>;
}

/** Notifications for the `/hub` (M2.3), same name and payload as the contract. */
export interface WorktreeEvents {
  readonly worktreeRemovable: Worktree;
}

/**
 * D47: a stacked worktree's parent PR was seen `MERGED` (once per worktree; the
 * record carries `parentBranch`, `parentBase`, `parentHeadOid`, `parentMerge`).
 * Not a `/hub` event: the system items turn it into the Inbox item and the
 * session message.
 */
export type ParentMergedListener = (worktree: WorktreeRecord) => void;

/**
 * D47 ruling D47-closed-parent: a stacked worktree's parent PR turned `CLOSED`
 * without a merge (once per worktree; `parentClosedAt` set). The system items
 * raise the "Parent … closed" Inbox item; the session gets no message.
 */
export type ParentClosedListener = (worktree: WorktreeRecord) => void;

/** Options for {@link WorktreeManager}. */
export interface WorktreeManagerOptions {
  readonly store: Store;
  /** `SWITCHBOARD_GH_BIN` argv prefix. */
  readonly ghCommand: readonly string[];
  /** git argv prefix (default `["git"]`; tests wrap it to log every call). */
  readonly gitCommand?: readonly string[];
  /** Base environment of git / gh (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** The supervisor, for isolate (gap #2). */
  readonly sessions?: SessionControl;
  /**
   * ms before a git (default 120 s) or gh (default 30 s) call is killed; D40:
   * `fetch` bounds the git calls that reach origin over the network (`git fetch`,
   * `git ls-remote`; default 60 s).
   */
  readonly timeouts?: { readonly git?: number; readonly gh?: number; readonly fetch?: number };
  /** Called when a background step fails (default: `console.error`). */
  readonly onError?: (error: unknown) => void;
}

/** A repo main checkout that a solution name resolves to. */
export interface RepoLocation {
  readonly solution: string;
  /** Canonical absolute path of the main checkout. */
  readonly repoPath: string;
}

/** What removal would lose (gap #3). */
export interface WorktreeState {
  /** `false` when the worktree folder no longer exists. */
  readonly exists: boolean;
  /** Entries of `git status --porcelain` (modified, staged, untracked). */
  readonly uncommitted: number;
  /** Commits on the worktree's HEAD / branch that no remote ref, upstream, base branch or PR head contains. */
  readonly unpushed: number;
}

/** Result of one worktree's pull request check. */
export interface PullRequestCheck {
  readonly worktreeId: string;
  readonly prState: string | null;
  readonly removable: boolean;
  /** Why the check could not finish (gh or git failed); the row keeps its previous values then. */
  readonly error: string | null;
}

/** Options of {@link WorktreeManager.createForSession} and {@link WorktreeManager.isolate}. */
export interface WorktreeBranchOptions {
  /**
   * D32: the branch the worktree(s) get, the same in every repo (a ticket branch
   * the caller validated, `checkTicketBranch`). Omitted: `session/{name}` (gap #1;
   * scheduled runs and teleports, D32 *Unchanged*).
   */
  readonly branch?: string;
  /**
   * D76: what the new branch is cut from (a branch name or a commit, as `git rev-parse`
   * reads it in the repo; a todo's run cuts from its source session's branch).
   * Omitted: the repo's current HEAD (gap #1).
   */
  readonly from?: string;
  /** D76: per solution, what its branch is cut from (wins over {@link from}; a workspace todo run cuts each repo from its own current branch). */
  readonly fromBySolution?: Readonly<Record<string, string>>;
}

/** A repository of a folder's solution that {@link WorktreeManager.adopt} looks in (D38). */
export interface AdoptionRepo {
  /** The solution's name, as `Session.solutions` and the worktree row name it (`web-front`, `mobile`). */
  readonly solution: string;
  /** Its main checkout. */
  readonly repoPath: string;
}

/**
 * The session {@link WorktreeManager.adopt} registers worktrees for (D38; D40:
 * its `branching` gives the base an agent-created worktree was cut from).
 */
export type AdoptionSession = Pick<SessionRecord, 'id' | 'name' | 'branch'> & { readonly branching?: SessionBranching | null };

/** Options of {@link WorktreeManager.createTaskWorktrees} (D40). */
export interface TaskWorktreeOptions {
  /** The task branch (D32's ticket branch the caller validated), the same in every repo. */
  readonly task: string;
  /** The session's branching (the epic, its base, per-repo overrides; D47: the parent); dropped repos must already be left out of `solutions`. */
  readonly branching: SessionBranching;
}

/** A task worktree {@link WorktreeManager.createTaskWorktrees} made (D40). */
export interface TaskWorktree {
  readonly record: WorktreeRecord;
  /** The origin branch it was cut from (`origin/dev`, `origin/<epic>`); `null` for a repo without an `origin` remote (cut from its HEAD, as before D40). */
  readonly from: string | null;
  /** The task branch: made by this call (`new`), made from `origin/<task>` and tracking it (`origin`), or the existing `local` branch. */
  readonly reuse: 'new' | 'origin' | 'local';
  /** D47: the repo's resolved base and PR target (`null` for a repo without `origin`). */
  readonly base: Extract<RepoBase, { ok: true }> | null;
  /** D47: the parent's PR in this repo when the task is stacked here (`null` otherwise). */
  readonly parentStatus: ParentStatus | null;
}

/** What {@link WorktreeManager.preflight} checks (D40, `POST /api/branching/preflight`). */
export interface PreflightInput {
  readonly solutions: readonly string[];
  /** The epic branch; `null` = a task without an epic (the rows check the origin default branch). */
  readonly epicBranch: string | null;
  /** The epic's base. */
  readonly base: string;
  /** The task branch to look for; `null` = not checked. */
  readonly taskBranch: string | null;
  /** Per-solution base overrides. */
  readonly bases: Readonly<Record<string, string>>;
  /** D47: the typed parent; `null` / omitted = not stacked. */
  readonly parent?: ParentRef | null;
}

/** Options of {@link WorktreeManager.isolate}. */
export interface IsolateOptions extends WorktreeBranchOptions {
  /**
   * D60: put the worktree on this existing branch instead of a new one: a local
   * branch (`PROJ-7-login`) or a remote one (`origin/PROJ-7-login`, a local
   * branch of that name tracking it is made unless one exists). Wins over `branch`.
   */
  readonly existingBranch?: string;
}

/** Result of {@link WorktreeManager.isolate}. */
export interface IsolateResult {
  readonly worktree: WorktreeRecord;
  /** `false` when the session already had a worktree for that repo (nothing was done). */
  readonly created: boolean;
  /** D60: how the existing branch was used; `null` for a new branch (or nothing created). */
  readonly existing: ExistingBranchNote | null;
}

/** Options of {@link WorktreeManager.listBranches} (D60). */
export interface ListBranchesOptions {
  /** Run `git fetch --all --prune` first (bounded by the fetch timeout); a failure is reported, the list still returned. */
  readonly fetch?: boolean;
}

/** Options for {@link WorktreeManager.startPolling}. */
export interface PollOptions {
  /** Between checks (default 5 min). */
  readonly intervalMs?: number;
  /** Before the first check (default 15 s). */
  readonly initialDelayMs?: number;
}

/** Default pause between pull request checks. */
export const DEFAULT_PR_POLL_MS = 5 * 60_000;
/** Untracked files bigger than this are listed without their lines. */
export const UNTRACKED_READ_LIMIT = 1024 * 1024;

interface Plan {
  readonly solution: string;
  readonly repoPath: string;
  readonly branch: string;
  readonly path: string;
  readonly headSha: string;
  readonly base: string;
}

/** One repo's D40 plan: where its task worktree comes from. */
interface TaskPlan {
  readonly solution: string;
  readonly repoPath: string;
  readonly branch: string;
  readonly path: string;
  readonly reuse: TaskWorktree['reuse'];
  /** What `git worktree add` starts from: `refs/remotes/origin/<x>`, `origin/<task>` (reuse), the HEAD commit (no origin) or the local branch. */
  readonly start: string;
  readonly from: string | null;
  /** The row's `base_ref`: `origin/<cut point>`, or the branch HEAD was on (no origin). */
  readonly base: string;
  /** D47: the resolution (`null` without origin) and the parent's status. */
  readonly resolved: Extract<RepoBase, { ok: true }> | null;
  readonly parentStatus: ParentStatus | null;
  /** D47: the parent fields the row starts with. */
  readonly parent: Partial<WorktreeParentFields>;
}

interface DiffTarget {
  readonly solution: string;
  readonly dir: string;
  readonly branch: string | null;
  /** The worktree's base (`base_ref`); `null` in place. */
  readonly baseRef: string | null;
  readonly worktree: boolean;
}

type Listener = (payload: Worktree) => void;

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** A main checkout: `.git` is a folder (a worktree or submodule has a `.git` file, gap #16). */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The WorktreeManager (M2.2, `docs/worktrees.md`): git worktrees per session and
 * solution (gap #1), their registry (`worktrees` table), pull request state via
 * `gh pr view` and the removable flag, removal with the gap #3 refusals, the gap #2
 * isolate operation and the gap #10 diff (it is the real {@link DiffProvider}).
 *
 * It never runs `git stash`, `reset`, `checkout`, `switch`, `clean`, `branch -D`
 * or any `--force` variant, and never touches the main checkout's working tree:
 * `git worktree add` only adds a folder next to it.
 */
export class WorktreeManager implements DiffProvider {
  readonly #store: Store;
  readonly #gh: readonly string[];
  readonly #git: readonly string[];
  readonly #env: NodeJS.ProcessEnv;
  readonly #sessions: SessionControl | null;
  readonly #gitTimeout: number;
  readonly #ghTimeout: number;
  readonly #onError: (error: unknown) => void;
  readonly #fetchTimeout: number;
  readonly #listeners = new Set<Listener>();
  /** D47: `parentMerged` listeners. */
  readonly #parentListeners = new Set<ParentMergedListener>();
  /** D47 ruling: `parentClosed` listeners. */
  readonly #closedListeners = new Set<ParentClosedListener>();
  /** D40: network git calls per repository, one at a time (a preflight and a Start never fetch one repo at once). */
  readonly #fetching = new Map<string, Promise<unknown>>();
  /** D40: worktrees whose branch existed before (reused): {@link discard} never deletes it. */
  readonly #keptBranches = new Set<string>();
  #checking: Promise<PullRequestCheck[]> | null = null;
  /** D90: the files a session touched in a working tree it uses in place (the Diff's default view). */
  readonly touched: SessionTouchedFiles;
  /** D38: adoptions run one at a time (two sessions may share a branch; a worktree gets one row). */
  #adopting: Promise<unknown> = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;
  #polling = false;

  constructor(options: WorktreeManagerOptions) {
    this.#store = options.store;
    this.#gh = options.ghCommand;
    this.#git = options.gitCommand ?? ['git'];
    this.#env = options.env ?? process.env;
    this.#sessions = options.sessions ?? null;
    this.#gitTimeout = options.timeouts?.git ?? 120_000;
    this.#ghTimeout = options.timeouts?.gh ?? 30_000;
    this.#fetchTimeout = options.timeouts?.fetch ?? 60_000;
    this.#onError = options.onError ?? ((error) => console.error('switchboard worktrees:', error));
    this.touched = new SessionTouchedFiles({ store: this.#store, env: this.#env, onError: this.#onError });
  }

  /** Subscribes to `worktreeRemovable`; returns the unsubscribe function. */
  on(name: keyof WorktreeEvents, listener: Listener): () => void {
    void name;
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** D47: subscribes to a stacked worktree's parent merging ({@link ParentMergedListener}); returns the unsubscribe function. */
  onParentMerged(listener: ParentMergedListener): () => void {
    this.#parentListeners.add(listener);
    return () => this.#parentListeners.delete(listener);
  }

  /** D47 ruling: subscribes to a stacked worktree's parent closing without a merge ({@link ParentClosedListener}). */
  onParentClosed(listener: ParentClosedListener): () => void {
    this.#closedListeners.add(listener);
    return () => this.#closedListeners.delete(listener);
  }

  // ── solutions ─────────────────────────────────────────────────────────

  /**
   * The main checkout a solution name means in `folder` (D14): in a workspace
   * folder the router layout (`mobile`, `<group>/<name>`, or a relative path;
   * read-only folders are refused); in a repo folder the repo itself, whose one
   * solution is its name.
   */
  async resolveRepo(solution: string, folder: FolderRef): Promise<RepoLocation> {
    const root = await this.#folderRoot(folder);
    // D59: a plain folder has no solutions, so nothing in it gets a worktree.
    if (folder.kind === 'plain') throw new WorktreeError('solution-not-found', `"${solution}" is not a solution: ${folder.path} is a plain folder (no AGENTS.md, not a git repository)`);
    if (folder.kind === 'repo') {
      const names = new Set([repoSolutionName(folder), path.basename(folder.path)]);
      if (!names.has(solution)) throw new WorktreeError('solution-not-found', `"${solution}" is not ${repoSolutionName(folder)}, the one solution of this repo folder`);
      if (!(await isMainCheckout(root))) throw new WorktreeError('solution-not-found', `${root} is not a git repository any more`);
      return { solution, repoPath: root };
    }
    if (isReadOnlyByLayout(solution)) throw new WorktreeError('read-only', `"${solution}" is read-only and cannot get a worktree`);
    const candidates = solutionCandidates(root, solution);
    if (candidates === null) throw new WorktreeError('solution-not-found', `"${solution}" is not a workspace solution`);
    const found: string[] = [];
    // A candidate that is not a checkout itself may hold exactly one (the nested mobile clone, `checkoutOf`).
    for (const candidate of candidates) {
      const checkout = await checkoutOf(candidate);
      if (checkout && !found.includes(checkout)) found.push(checkout);
    }
    if (found.length === 0) throw new WorktreeError('solution-not-found', `no git repository for "${solution}" in the workspace`);
    if (found.length > 1) {
      throw new WorktreeError('solution-ambiguous', `"${solution}" matches several repositories: ${found.map((f) => path.relative(root, f)).join(', ')}`);
    }
    return { solution, repoPath: await realpath(found[0] as string) };
  }

  // ── create (gap #1) ───────────────────────────────────────────────────

  /**
   * Creates one worktree per solution of `folder` (gap #1: branch
   * `session/{name}` from the repo's current HEAD, folder `../{repo}-wt-{name}`;
   * D32: the branch in `options`, the same in every repo, instead of
   * `session/{name}`) and registers it. All or nothing: every precondition is
   * checked first (a branch a repo has already is `branch-exists`, naming the
   * repo), and a failure part-way removes the worktrees this call made.
   * `sessionId` may be set later with {@link assign}.
   */
  async createForSession(
    sessionName: string,
    solutions: readonly string[],
    folder: FolderRef,
    sessionId: string | null = null,
    options: WorktreeBranchOptions = {},
  ): Promise<WorktreeRecord[]> {
    const plans: Plan[] = [];
    for (const solution of solutions) {
      const plan = await this.#plan(solution, sessionName, folder, options.branch ?? worktreeBranch(sessionName), options.fromBySolution?.[solution] ?? options.from);
      if (plans.some((other) => other.path === plan.path)) {
        throw new WorktreeError('path-exists', `"${solution}" names the same repository as another solution in scope`);
      }
      plans.push(plan);
    }
    const created: WorktreeRecord[] = [];
    try {
      for (const plan of plans) created.push(await this.#create(plan, sessionId));
    } catch (error) {
      await this.discard(created);
      throw error;
    }
    return created;
  }

  /** Links worktrees made by {@link createForSession} to their session. */
  async assign(records: readonly WorktreeRecord[], sessionId: string): Promise<void> {
    for (const record of records) await this.#store.worktrees.update(record.id, { sessionId });
  }

  /**
   * Undoes {@link createForSession} for worktrees nothing has used yet (the session
   * could not start): `git worktree remove` (never `--force`) and `git branch -d`
   * of the branch it just made (never `-D`; D40: a reused branch is kept), then
   * the row is marked removed.
   */
  async discard(records: readonly WorktreeRecord[]): Promise<void> {
    for (const record of [...records].reverse()) {
      const removed = await this.#runGit(record.repoPath, ['worktree', 'remove', record.path]);
      if (!succeeded(removed)) this.#onError(new Error(`could not discard ${record.path}: ${failureText(removed)}`));
      else if (this.#keptBranches.delete(record.id)) {
        // D40: the task branch was there before this session: it stays.
      } else {
        const branch = await this.#runGit(record.repoPath, ['branch', '-d', record.branch]);
        if (!succeeded(branch)) this.#onError(new Error(`kept branch ${record.branch}: ${failureText(branch)}`));
      }
      await this.#store.worktrees.markRemoved(record.id);
    }
  }

  /**
   * The branch checked out in `dir` (`git rev-parse --abbrev-ref HEAD`); `null`
   * when HEAD is detached or git cannot tell. D25 reads what a teleport checked
   * out in the worktree Switchboard made for it.
   */
  async checkedOutBranch(dir: string): Promise<string | null> {
    const result = await this.#runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = result.stdout.trim();
    return succeeded(result) && branch !== '' && branch !== 'HEAD' ? branch : null;
  }

  async #plan(solution: string, sessionName: string, folder: FolderRef, branch: string, from?: string): Promise<Plan> {
    const { repoPath } = await this.resolveRepo(solution, folder);
    const target = worktreePath(repoPath, sessionName);
    if ((await pathExists(target)) || (await this.#store.worktrees.getLiveByPath(target))) {
      throw new WorktreeError('path-exists', `${target} already exists`);
    }
    // D76: a todo's run is cut from its source session's branch (or commit).
    const head = await this.#runGit(repoPath, ['rev-parse', '--verify', '--quiet', `${from ?? 'HEAD'}^{commit}`]);
    if (!succeeded(head) || head.stdout.trim() === '') throw new WorktreeError('no-commits', from ? `${solution} has no ${from} to branch from` : `${solution} has no commit to branch from`);
    const headSha = head.stdout.trim();
    const existing = await this.#runGit(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (existing.code === 0) throw new WorktreeError('branch-exists', `${solution} already has a branch ${branch}`);
    const symbolic = from ? null : await this.#runGit(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const base = from ?? (symbolic && succeeded(symbolic) && symbolic.stdout.trim() !== '' ? symbolic.stdout.trim() : headSha);
    return { solution, repoPath, branch, path: target, headSha, base };
  }

  async #create(plan: Plan, sessionId: string | null): Promise<WorktreeRecord> {
    const added = await this.#runGit(plan.repoPath, ['worktree', 'add', '-b', plan.branch, plan.path, plan.headSha]);
    if (!succeeded(added)) throw new WorktreeError('git-failed', `git worktree add failed for ${plan.solution}: ${failureText(added)}`);
    let record: WorktreeRecord;
    try {
      record = await this.#store.worktrees.create({
        repo: plan.solution,
        repoPath: plan.repoPath,
        branch: plan.branch,
        baseRef: plan.base,
        path: await realpath(plan.path),
        sessionId,
      });
    } catch (error) {
      const removed = await this.#runGit(plan.repoPath, ['worktree', 'remove', plan.path]);
      if (succeeded(removed)) await this.#runGit(plan.repoPath, ['branch', '-d', plan.branch]);
      throw error;
    }
    // D84: Clean-up lists only the branches Switchboard made (docs/cleanup.md).
    await recordCreatedBranch(this.#store.settings, { repoPath: plan.repoPath, branch: plan.branch, kind: 'new' }).catch((error: unknown) => this.#onError(error));
    return record;
  }

  // ── epic/task branching (D40) ─────────────────────────────────────────

  /**
   * D40 (`docs/worktrees.md` → *Epic/task branching (D40)*): a new session's task
   * worktrees, one per solution of `folder`, on the task branch, at
   * `../{repo}-wt-{name}`. In each repo with an `origin` remote it first runs
   * `git fetch origin`, then cuts the worktree from `origin/<epic>` when the epic
   * is on origin, else from `origin/<base>` (the repo's override when set); without
   * an epic from the origin default branch (`origin/HEAD`, else what `git
   * ls-remote --symref origin HEAD` names), never from a local branch. An existing
   * task branch is **reused**: the local branch when there is one, else a new
   * local branch tracking `origin/<task>`; one checked out in another worktree is
   * refused (`branch-checked-out`). A new task branch has no upstream until the
   * agent pushes it (`--no-track`). A repo without an `origin` remote is cut from
   * its current HEAD as before. It never creates the epic branch, never pushes and
   * never touches the main checkout's working tree.
   *
   * All or nothing like {@link createForSession}: every repo is planned (and
   * fetched) before anything is created; a missing base is `base-missing`, a failed
   * fetch `fetch-failed`.
   */
  async createTaskWorktrees(sessionName: string, solutions: readonly string[], folder: FolderRef, options: TaskWorktreeOptions): Promise<TaskWorktree[]> {
    const plans: TaskPlan[] = [];
    for (const solution of solutions) {
      const plan = await this.#planTask(solution, sessionName, folder, options);
      if (plans.some((other) => other.path === plan.path)) {
        throw new WorktreeError('path-exists', `"${solution}" names the same repository as another solution in scope`);
      }
      plans.push(plan);
    }
    const created: TaskWorktree[] = [];
    try {
      for (const plan of plans) created.push({ record: await this.#createTask(plan), from: plan.from, reuse: plan.reuse, base: plan.resolved, parentStatus: plan.parentStatus });
    } catch (error) {
      await this.discard(created.map((worktree) => worktree.record));
      throw error;
    }
    return created;
  }

  async #planTask(solution: string, sessionName: string, folder: FolderRef, options: TaskWorktreeOptions): Promise<TaskPlan> {
    const { repoPath } = await this.resolveRepo(solution, folder);
    const target = worktreePath(repoPath, sessionName);
    if ((await pathExists(target)) || (await this.#store.worktrees.getLiveByPath(target))) {
      throw new WorktreeError('path-exists', `${target} already exists`);
    }
    const task = options.task;
    const local = await this.#refExists(repoPath, `refs/heads/${task}`);
    if (local) {
      const elsewhere = await this.#checkedOutAt(repoPath, task);
      if (elsewhere !== null) throw new WorktreeError('branch-checked-out', `${solution}: ${task} is checked out at ${elsewhere}`);
    }
    if (!(await this.#hasOrigin(repoPath))) {
      // No origin to cut from: the repo's current HEAD, as before D40 (an existing task branch is still reused).
      const head = await this.#runGit(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
      if (!succeeded(head) || head.stdout.trim() === '') throw new WorktreeError('no-commits', `${solution} has no commit to branch from`);
      const headSha = head.stdout.trim();
      const symbolic = await this.#runGit(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      const base = succeeded(symbolic) && symbolic.stdout.trim() !== '' ? symbolic.stdout.trim() : headSha;
      return { solution, repoPath, branch: task, path: target, reuse: local ? 'local' : 'new', start: local ? task : headSha, from: null, base, resolved: null, parentStatus: null, parent: {} };
    }
    const { branching } = options;
    const parent = effectiveParent(storedParent(branching), branching.epic?.branch ?? null);
    // D47: a stacked task prunes, so a parent deleted on origin (merged) is not taken for present.
    const fetched = await this.#fetch(repoPath, parent ? ['fetch', 'origin', '--prune'] : ['fetch', 'origin']);
    if (!succeeded(fetched)) throw new WorktreeError('fetch-failed', `git fetch origin failed in ${solution}: ${failureText(fetched)}`);
    const epicOnOrigin = branching.epic !== null && (await this.#refExists(repoPath, `refs/remotes/origin/${branching.epic.branch}`));
    const matches = parent ? parentMatches(parent, await this.#originBranches(repoPath), task) : null;
    const needsDefault = branching.epic === null && branching.bases[solution] === undefined && !(matches !== null && matches.length > 0);
    const resolved = resolveRepoBase(branching, solution, { parentMatches: matches, epicOnOrigin, defaultBranch: needsDefault ? await this.#originDefault(repoPath) : null });
    if (!resolved.ok) throw new WorktreeError('parent-ambiguous', `${solution}: ${resolved.message}`);
    const cut = resolved.cut;
    if (cut === null) throw new WorktreeError('base-missing', `${solution}: origin has no default branch (origin/HEAD): use another base for it`);
    if (!(await this.#refExists(repoPath, `refs/remotes/origin/${cut}`))) {
      throw new WorktreeError('base-missing', `${solution}: origin/${cut} does not exist: drop it from the task or use another base`);
    }
    const from = `origin/${cut}`;
    // D47: the parent's PR now (the hand-off's status, the watcher's first state); gh failing never blocks the start.
    let parentStatus: ParentStatus | null = null;
    let parentFields: Partial<WorktreeParentFields> = {};
    if (resolved.parent !== null) {
      parentStatus = await this.#parentStatus(repoPath, resolved.parent);
      const cutOid = await this.#runGit(repoPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${resolved.parent}^{commit}`]);
      parentFields = {
        parentBranch: resolved.parent,
        parentHeadOid: (parentStatus.kind === 'pr' ? parentStatus.pr.headRefOid : null) ?? (succeeded(cutOid) && cutOid.stdout.trim() !== '' ? cutOid.stdout.trim() : null),
        ...(parentStatus.kind === 'pr'
          ? { parentPrNumber: parentStatus.pr.number, parentPrUrl: parentStatus.pr.url, parentPrState: parentStatus.pr.state, parentBase: parentStatus.pr.baseRefName }
          : {}),
      };
    }
    const plan = { solution, repoPath, branch: task, path: target, from, base: from, resolved, parentStatus, parent: parentFields };
    if (local) return { ...plan, reuse: 'local', start: task };
    if (await this.#refExists(repoPath, `refs/remotes/origin/${task}`)) return { ...plan, reuse: 'origin', start: `origin/${task}` };
    return { ...plan, reuse: 'new', start: `refs/remotes/origin/${cut}` };
  }

  async #createTask(plan: TaskPlan): Promise<WorktreeRecord> {
    const args =
      plan.reuse === 'local'
        ? ['worktree', 'add', plan.path, plan.start]
        : plan.reuse === 'origin'
          ? ['worktree', 'add', '--track', '-b', plan.branch, plan.path, plan.start]
          : plan.from === null
            ? ['worktree', 'add', '-b', plan.branch, plan.path, plan.start]
            : ['worktree', 'add', '--no-track', '-b', plan.branch, plan.path, plan.start];
    const added = await this.#runGit(plan.repoPath, args);
    if (!succeeded(added)) throw new WorktreeError('git-failed', `git worktree add failed for ${plan.solution}: ${failureText(added)}`);
    try {
      const record = await this.#store.worktrees.create({
        repo: plan.solution,
        repoPath: plan.repoPath,
        branch: plan.branch,
        baseRef: plan.base,
        path: await realpath(plan.path),
        sessionId: null,
        ...plan.parent,
      });
      if (plan.reuse === 'local') this.#keptBranches.add(record.id);
      // D84: Clean-up lists only the branches Switchboard made (docs/cleanup.md); a reused local branch is not one.
      else await recordCreatedBranch(this.#store.settings, { repoPath: plan.repoPath, branch: plan.branch, kind: plan.reuse === 'origin' ? 'tracking' : 'new' }).catch((error: unknown) => this.#onError(error));
      return record;
    } catch (error) {
      const removed = await this.#runGit(plan.repoPath, ['worktree', 'remove', plan.path]);
      if (succeeded(removed) && plan.reuse !== 'local') await this.#runGit(plan.repoPath, ['branch', '-d', plan.branch]);
      throw error;
    }
  }

  /**
   * D40 (`POST /api/branching/preflight`): for each solution of `folder` (in
   * parallel), `git fetch origin --prune`, then what the task worktree would be
   * cut from: `origin/<base>` present (the override, the epic's base, or without
   * an epic the origin default branch), the epic on origin and how many commits of
   * `origin/<base>` it lacks (`git rev-list --count origin/<epic>..origin/<base>`),
   * the task branch on origin and locally. Nothing is created; a repo that cannot
   * be read, has no `origin` or cannot be fetched is a row with its `error`.
   */
  async preflight(folder: FolderRef, input: PreflightInput): Promise<BranchingPreflightRow[]> {
    return Promise.all(input.solutions.map((solution) => this.#preflightRow(solution, folder, input)));
  }

  async #preflightRow(solution: string, folder: FolderRef, input: PreflightInput): Promise<BranchingPreflightRow> {
    const override = input.bases[solution];
    const epicBranch = input.epicBranch;
    const parent = effectiveParent(input.parent ?? null, epicBranch);
    const baseSource: BranchingPreflightRow['baseSource'] = override !== undefined ? 'override' : epicBranch !== null ? 'epic' : 'default';
    const unknown = (repoPath: string | null, error: string): BranchingPreflightRow => ({
      solution,
      repoPath,
      error,
      base: override ?? (epicBranch !== null ? input.base : null),
      baseSource,
      baseExists: null,
      epic: epicBranch !== null ? { branch: epicBranch, exists: null, behind: null } : null,
      task: input.taskBranch !== null ? { branch: input.taskBranch, exists: null, local: null } : null,
      cutFrom: null,
      parent: null,
      prTarget: null,
    });
    let repoPath: string;
    try {
      repoPath = (await this.resolveRepo(solution, folder)).repoPath;
    } catch (error) {
      return unknown(null, errorText(error));
    }
    if (!(await this.#hasOrigin(repoPath))) return unknown(repoPath, "no origin remote: the worktree starts from the repo's current HEAD");
    const fetched = await this.#fetch(repoPath, ['fetch', 'origin', '--prune']);
    if (!succeeded(fetched)) return unknown(repoPath, `git fetch origin failed: ${failureText(fetched)}`);
    const base = override ?? (epicBranch !== null ? input.base : await this.#originDefault(repoPath));
    const baseExists = base !== null && (await this.#refExists(repoPath, `refs/remotes/origin/${base}`));
    let epic: BranchingPreflightRow['epic'] = null;
    if (epicBranch !== null) {
      const exists = await this.#refExists(repoPath, `refs/remotes/origin/${epicBranch}`);
      let behind: number | null = null;
      if (exists && baseExists) {
        const count = await this.#runGit(repoPath, ['rev-list', '--count', `refs/remotes/origin/${epicBranch}..refs/remotes/origin/${base}`, '--']);
        behind = succeeded(count) ? Number.parseInt(count.stdout.trim(), 10) : null;
        if (behind !== null && !Number.isFinite(behind)) behind = null;
      }
      epic = { branch: epicBranch, exists, behind };
    }
    const task =
      input.taskBranch !== null
        ? {
            branch: input.taskBranch,
            exists: await this.#refExists(repoPath, `refs/remotes/origin/${input.taskBranch}`),
            local: await this.#refExists(repoPath, `refs/heads/${input.taskBranch}`),
          }
        : null;
    // D47: the typed parent in this repo (after the prune), its PR (gh), and the resolved base / PR target.
    let parentRow: BranchingPreflightRow['parent'] = null;
    let resolved: RepoBase | null = null;
    const branching = { epic: epicBranch !== null ? { key: '', summary: '', branch: epicBranch } : null, base: input.base, bases: input.bases };
    const matches = parent ? parentMatches(parent, await this.#originBranches(repoPath), input.taskBranch) : null;
    resolved = resolveRepoBase(branching, solution, { parentMatches: matches, epicOnOrigin: epic?.exists === true, defaultBranch: epicBranch === null ? base : null });
    if (parent) {
      const found = resolved.ok ? resolved.parent : null;
      const status = found !== null ? await this.#parentStatus(repoPath, found) : null;
      parentRow = {
        typed: parentText(parent),
        branch: found,
        matches: matches ?? [],
        error: resolved.ok ? null : resolved.message,
        pr: status?.kind === 'pr' ? { number: status.pr.number, state: status.pr.state, url: status.pr.url, baseRefName: status.pr.baseRefName } : null,
        noPr: status?.kind === 'none',
        prError: status?.kind === 'unknown' ? status.error : null,
      };
    }
    let cutFrom: string | null;
    if (resolved.ok && resolved.via === 'parent') cutFrom = `origin/${resolved.cut as string}`;
    else if (resolved.ok === false) cutFrom = null;
    else cutFrom = epic?.exists ? `origin/${epic.branch}` : baseExists ? `origin/${base as string}` : null;
    const prTarget = resolved.ok && cutFrom !== null ? resolved.prTarget : null;
    return { solution, repoPath, error: null, base, baseSource, baseExists, epic, task, cutFrom, parent: parentRow, prTarget };
  }

  /** D47: the branch names under `refs/remotes/origin/` (without `origin/`; `HEAD` left out). */
  async #originBranches(repoPath: string): Promise<string[]> {
    const listed = await this.#runGit(repoPath, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/']);
    if (!succeeded(listed)) return [];
    const prefix = 'refs/remotes/origin/';
    return listed.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((ref) => ref.startsWith(prefix) && ref !== `${prefix}HEAD`)
      .map((ref) => ref.slice(prefix.length));
  }

  /** D47: `gh pr view <branch> --json number,state,url,baseRefName,headRefOid` in `cwd`: its PR, `none`, or `unknown` (gh failed). */
  async #parentStatus(cwd: string, branch: string): Promise<ParentStatus> {
    const result = await this.#runGh(cwd, ['pr', 'view', branch, '--json', PARENT_PR_FIELDS]);
    if (succeeded(result)) {
      const pr = parseParentPullRequest(result.stdout);
      return pr ? { kind: 'pr', pr } : { kind: 'unknown', error: `gh pr view printed an unexpected shape: ${result.stdout.slice(0, 200)}` };
    }
    if (result.error === null && isNoPullRequest(result.stderr)) return { kind: 'none' };
    return { kind: 'unknown', error: `gh pr view failed: ${failureText(result)}` };
  }

  /** `true` when the repo has an `origin` remote (its config; no network). */
  async #hasOrigin(repoPath: string): Promise<boolean> {
    const url = await this.#runGit(repoPath, ['remote', 'get-url', 'origin']);
    return succeeded(url) && url.stdout.trim() !== '';
  }

  /** `true` when `ref` (a full ref name) resolves to a commit. */
  /** D76: `true` when repo `repoPath` has local branch `branch` (a todo's run picks a free `todo/<slug>`). */
  async hasLocalBranch(repoPath: string, branch: string): Promise<boolean> {
    const result = await this.#runGit(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return result.code === 0;
  }

  /** D76: the commit checked out in `dir` (`git rev-parse HEAD`); `null` when git cannot tell. */
  async headCommit(dir: string): Promise<string | null> {
    const result = await this.#runGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    return succeeded(result) && result.stdout.trim() !== '' ? result.stdout.trim() : null;
  }

  async #refExists(repoPath: string, ref: string): Promise<boolean> {
    const result = await this.#runGit(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return succeeded(result) && result.stdout.trim() !== '';
  }

  /**
   * The origin default branch (without `origin/`): `refs/remotes/origin/HEAD`
   * (a fetch sets it), else what `git ls-remote --symref origin HEAD` names; `null`
   * when neither says.
   */
  async #originDefault(repoPath: string): Promise<string | null> {
    const symbolic = await this.#runGit(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    const local = symbolic.stdout.trim();
    if (succeeded(symbolic) && local.startsWith('origin/') && local.length > 'origin/'.length) return local.slice('origin/'.length);
    const remote = await this.#fetch(repoPath, ['ls-remote', '--symref', 'origin', 'HEAD']);
    return succeeded(remote) ? parseSymrefHead(remote.stdout) : null;
  }

  /** Where `branch` is checked out in a worktree of `repoPath` (the main checkout included), else `null`. */
  async #checkedOutAt(repoPath: string, branch: string): Promise<string | null> {
    const listed = await this.#runGit(repoPath, ['worktree', 'list', '--porcelain']);
    if (!succeeded(listed)) return null;
    return parseWorktreeList(listed.stdout).find((entry) => entry.branch === branch && !entry.prunable)?.path ?? null;
  }

  /** A git call that reaches origin (`fetch`, `ls-remote`): bounded by the fetch timeout, one at a time per repository. */
  #fetch(repoPath: string, args: readonly string[]): Promise<RunResult> {
    const previous = this.#fetching.get(repoPath) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.#runGit(repoPath, args, this.#fetchTimeout));
    this.#fetching.set(repoPath, run);
    void run.finally(() => {
      if (this.#fetching.get(repoPath) === run) this.#fetching.delete(repoPath);
    });
    return run;
  }

  // ── adopt (D38) ───────────────────────────────────────────────────────

  /**
   * D38 (`docs/worktrees.md` → *Adopted worktrees*): registers the worktrees the
   * session's agent created itself as the session's, exactly like the ones
   * {@link createForSession} makes (same rows, `sessionId` set: the Diff tab, PR
   * checks, removal and the Solutions chips follow). For each repository (each
   * once) it runs `git worktree list --porcelain` in the main checkout, the only
   * git call made there (read-only), and adopts every other worktree on a branch
   * whose branch is the session's (`sessions.branch`) or whose folder is
   * `<repo>-wt-<name>` ({@link isSessionWorktree}). A worktree that already has a
   * live row (the session's own, or another session's) is left alone, so a call
   * is idempotent. The base the Diff compares against is the main worktree's
   * branch (else its commit) at the time of adoption. A repository git cannot
   * list is skipped (reported through `onError`). Calls run one at a time.
   * @returns the rows created by this call.
   */
  adopt(session: AdoptionSession, repos: readonly AdoptionRepo[]): Promise<WorktreeRecord[]> {
    const run = this.#adopting.catch(() => undefined).then(() => this.#adoptNow(session, repos));
    this.#adopting = run;
    return run;
  }

  async #adoptNow(session: AdoptionSession, repos: readonly AdoptionRepo[]): Promise<WorktreeRecord[]> {
    const adopted: WorktreeRecord[] = [];
    const seen = new Set<string>();
    for (const repo of repos) {
      let repoPath: string;
      try {
        repoPath = await realpath(repo.repoPath);
      } catch {
        continue;
      }
      if (seen.has(repoPath)) continue;
      seen.add(repoPath);
      const listed = await this.#runGit(repoPath, ['worktree', 'list', '--porcelain']);
      if (!succeeded(listed)) {
        this.#onError(new Error(`git worktree list failed in ${repoPath}: ${failureText(listed)}`));
        continue;
      }
      const [main, ...others] = parseWorktreeList(listed.stdout);
      for (const entry of others) {
        if (!isSessionWorktree(entry, { sessionName: session.name, branch: session.branch, repoPath, solution: repo.solution })) continue;
        let worktreePath: string;
        try {
          worktreePath = await realpath(entry.path);
        } catch {
          continue;
        }
        if (worktreePath === repoPath || (await this.#store.worktrees.getLiveByPath(worktreePath))) continue;
        // D40: a branching session's worktree is compared with the origin branch it was cut from (D47: the parent when stacked there).
        const cutFrom = session.branching ? await this.#adoptedBase(worktreePath, session.branching, repo.solution, entry.branch as string) : null;
        adopted.push(
          await this.#store.worktrees.create({
            repo: repo.solution,
            repoPath,
            branch: entry.branch as string,
            baseRef: cutFrom?.base ?? main?.branch ?? main?.head ?? null,
            path: worktreePath,
            sessionId: session.id,
            ...(cutFrom?.parent ?? {}),
          }),
        );
      }
    }
    return adopted;
  }

  /**
   * D40: the origin branch an agent-created worktree of a branching session was
   * cut from, by the session's rule (`origin/<epic>` when it is on origin, else
   * `origin/<base>` or the repo's override; without an epic, the override or
   * `origin/HEAD`), read in the worktree itself (no fetch, nothing run in the main
   * checkout); `null` when that ref does not resolve. D47: a stacked session's
   * worktree whose repo has the parent on origin is cut from `origin/<parent>`
   * and watches it (the parent fields; its PR is read by the next poll).
   */
  async #adoptedBase(
    worktreePath: string,
    branching: SessionBranching,
    solution: string,
    task: string,
  ): Promise<{ readonly base: string | null; readonly parent: Partial<WorktreeParentFields> } | null> {
    const parent = effectiveParent(storedParent(branching), branching.epic?.branch ?? null);
    if (parent) {
      const matches = parentMatches(parent, await this.#originBranches(worktreePath), task);
      if (matches.length === 1) {
        const name = matches[0] as string;
        const oid = await this.#runGit(worktreePath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}^{commit}`]);
        const tip = succeeded(oid) && oid.stdout.trim() !== '' ? oid.stdout.trim() : null;
        return { base: `origin/${name}`, parent: { parentBranch: name, parentHeadOid: tip } };
      }
    }
    const epicOnOrigin = branching.epic !== null && (await this.#refExists(worktreePath, `refs/remotes/origin/${branching.epic.branch}`));
    let defaultBranch: string | null = null;
    if (branching.epic === null && branching.bases[solution] === undefined) {
      const symbolic = await this.#runGit(worktreePath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
      const ref = symbolic.stdout.trim();
      if (succeeded(symbolic) && ref.startsWith('origin/')) defaultBranch = ref.slice('origin/'.length);
    }
    const cut = cutPoint(branching, solution, { epicOnOrigin, defaultBranch });
    return { base: cut !== null && (await this.#refExists(worktreePath, `refs/remotes/origin/${cut}`)) ? `origin/${cut}` : null, parent: {} };
  }

  // ── isolate (gap #2) ──────────────────────────────────────────────────

  /**
   * "Move … to worktree" (gap #2): creates the session's worktree for `repo`, then
   * pauses the session (when it has a live process) and resumes it with a message
   * telling it to move its work there. The developer's working tree is never
   * stashed, reset or checked out. A session that already has a worktree for `repo`
   * gets nothing new (`created: false`). Refused while the session is detached.
   * `repo` resolves in the session's own folder (D14). D32: the worktree is on
   * `options.branch` (the route requires it), else `session/{name}`. D60:
   * `options.existingBranch` puts it on an existing local or remote branch
   * instead ({@link #planExisting}), and the move message says so.
   */
  async isolate(repo: string, sessionId: string, options: IsolateOptions = {}): Promise<IsolateResult> {
    const session = await this.#store.sessions.get(sessionId);
    if (!session) throw new WorktreeError('session-not-found', `no session ${sessionId}`);
    const existing = (await this.#store.worktrees.list({ sessionId, repo }))[0];
    if (existing) return { worktree: existing, created: false, existing: null };
    if (!session.attached) throw new WorktreeError('detached', 'the session continues in a terminal; attach it first');
    const control = this.#sessions;
    if (!control) throw new Error('isolate needs the session supervisor');
    const folder = folderOfSession(session);
    if (!folder) throw new WorktreeError('folder-missing', `the session ${session.name} has no folder`);
    let worktree: WorktreeRecord | undefined;
    let note: ExistingBranchNote | null = null;
    if (options.existingBranch !== undefined) {
      const plan = await this.#planExisting(repo, session.name, folder, options.existingBranch);
      worktree = await this.#createTask(plan.task);
      try {
        worktree = (await this.#store.worktrees.update(worktree.id, { sessionId: session.id })) ?? worktree;
      } catch (error) {
        await this.discard([worktree]);
        throw error;
      }
      note = plan.note;
      if (plan.task.reuse === 'origin') {
        // The new local branch tracks the remote one (`--track`): its upstream is what the message names.
        const upstream = await this.#upstreamOf(worktree.path, worktree.branch);
        note = { ...note, upstream: upstream ?? note.upstream };
      }
    } else {
      [worktree] = await this.createForSession(session.name, [repo], folder, session.id, options);
    }
    if (!worktree) throw new Error('no worktree was created');
    if (control.isLive(sessionId)) await control.pause(sessionId);
    await control.sendMessage(
      sessionId,
      moveToWorktreeMessage({
        repo,
        repoPath: worktree.repoPath,
        worktreePath: worktree.path,
        branch: worktree.branch,
        base: worktree.baseRef ?? 'HEAD',
        existing: note,
      }),
      'service',
    );
    return { worktree, created: true, existing: note };
  }

  /**
   * D60 (`GET /api/solutions/{repo}/branches`): the branches of `repo` as the
   * session sees it (resolved in the session's folder, D14), for the conflict
   * card's "Existing branch" picker: local branches, then remote ones (every
   * remote, its `HEAD` left out), each newest first, with the tip's subject and
   * date and where the branch the worktree would be on is checked out (`git
   * worktree list --porcelain`: the main checkout or another worktree). With
   * `fetch`, `git fetch --all --prune` runs first (the fetch timeout, one network
   * call per repo at a time); when it fails the list is what git knew before and
   * `fetchError` says why. Read-only: nothing is created or checked out.
   */
  async listBranches(repo: string, sessionId: string, options: ListBranchesOptions = {}): Promise<RepoBranches> {
    const session = await this.#store.sessions.get(sessionId);
    if (!session) throw new WorktreeError('session-not-found', `no session ${sessionId}`);
    const folder = folderOfSession(session);
    if (!folder) throw new WorktreeError('folder-missing', `the session ${session.name} has no folder`);
    const { repoPath } = await this.resolveRepo(repo, folder);
    const remotes = await this.#remotes(repoPath);
    let fetched: boolean | null = null;
    let fetchError: string | null = null;
    if (options.fetch && remotes.length > 0) {
      const result = await this.#fetch(repoPath, ['fetch', '--all', '--prune']);
      fetched = succeeded(result);
      if (!fetched) fetchError = `git fetch failed: ${failureText(result)}`;
    }
    const refs = await this.#runGit(repoPath, ['for-each-ref', '--sort=-committerdate', `--format=${BRANCH_REF_FORMAT}`, 'refs/heads', 'refs/remotes']);
    if (!succeeded(refs)) throw new WorktreeError('git-failed', `git for-each-ref failed in ${repo}: ${failureText(refs)}`);
    const branches = parseBranchRefs(refs.stdout, remotes, await this.#checkedOutBranches(repoPath));
    return { repo, repoPath, branches, fetched, fetchError };
  }

  /**
   * D60: where an isolate onto an existing branch comes from. A local branch is
   * checked out as it is (`git worktree add <path> <branch>`, never deleted by
   * {@link discard}); a remote branch `origin/foo` gets a new local `foo`
   * tracking it (`git worktree add --track -b foo <path> origin/foo`), unless a
   * local `foo` exists: then the worktree is on the local one (`pickedRemote`
   * says so). A branch checked out anywhere (the main checkout, another
   * worktree) is `branch-checked-out`; an unknown name `branch-not-found`. The
   * row's base (the Diff's merge-base) is the origin default branch when git
   * knows it locally (`origin/HEAD`), else the main checkout's branch (or commit).
   */
  async #planExisting(solution: string, sessionName: string, folder: FolderRef, picked: string): Promise<{ readonly task: TaskPlan; readonly note: ExistingBranchNote }> {
    const { repoPath } = await this.resolveRepo(solution, folder);
    const target = worktreePath(repoPath, sessionName);
    if ((await pathExists(target)) || (await this.#store.worktrees.getLiveByPath(target))) {
      throw new WorktreeError('path-exists', `${target} already exists`);
    }
    let branch: string;
    let reuse: 'local' | 'origin';
    let pickedRemote: string | null = null;
    if (await this.#refExists(repoPath, `refs/heads/${picked}`)) {
      branch = picked;
      reuse = 'local';
    } else if (!picked.endsWith('/HEAD') && (await this.#refExists(repoPath, `refs/remotes/${picked}`))) {
      const remote = (await this.#remotes(repoPath)).sort((a, b) => b.length - a.length).find((name) => picked.startsWith(`${name}/`)) ?? picked.split('/')[0] ?? '';
      branch = picked.slice(remote.length + 1);
      if (branch === '') throw new WorktreeError('branch-not-found', `${solution} has no branch ${picked}`);
      if (await this.#refExists(repoPath, `refs/heads/${branch}`)) {
        // ASSUMED D60-local-wins: the local branch of that name is used, never moved to the remote's commit.
        reuse = 'local';
        pickedRemote = picked;
      } else {
        reuse = 'origin';
      }
    } else {
      throw new WorktreeError('branch-not-found', `${solution} has no branch ${picked}`);
    }
    const elsewhere = (await this.#checkedOutBranches(repoPath)).get(branch);
    if (elsewhere !== undefined) throw new WorktreeError('branch-checked-out', `${solution}: ${branch} is checked out at ${elsewhere}`);
    const base = await this.#existingBase(repoPath);
    const upstream = reuse === 'origin' ? picked : await this.#upstreamOf(repoPath, branch);
    const task: TaskPlan = {
      solution,
      repoPath,
      branch,
      path: target,
      reuse,
      start: reuse === 'origin' ? picked : branch,
      from: null,
      base,
      resolved: null,
      parentStatus: null,
      parent: {},
    };
    return { task, note: { upstream, createdFromRemote: reuse === 'origin', pickedRemote } };
  }

  /** D60: the Diff base of a worktree on an existing branch: `origin/<default>` when `origin/HEAD` is known locally, else the main checkout's branch or commit. */
  async #existingBase(repoPath: string): Promise<string> {
    const symbolic = await this.#runGit(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    const origin = symbolic.stdout.trim();
    if (succeeded(symbolic) && origin.startsWith('origin/') && (await this.#refExists(repoPath, `refs/remotes/${origin}`))) return origin;
    const head = await this.#runGit(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (succeeded(head) && head.stdout.trim() !== '') return head.stdout.trim();
    const sha = await this.#runGit(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    return succeeded(sha) && sha.stdout.trim() !== '' ? sha.stdout.trim() : 'HEAD';
  }

  /** D60: a local branch's upstream (`origin/foo`), `null` when it tracks nothing. */
  async #upstreamOf(cwd: string, branch: string): Promise<string | null> {
    const result = await this.#runGit(cwd, ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`]);
    const upstream = result.stdout.trim();
    return succeeded(result) && upstream !== '' ? upstream : null;
  }

  /** D60: the repo's remote names (`git remote`, config only). */
  async #remotes(repoPath: string): Promise<string[]> {
    const result = await this.#runGit(repoPath, ['remote']);
    if (!succeeded(result)) return [];
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }

  /** D60: every checked-out branch of the repo and the worktree it is in (the main checkout included; `prunable` ones left out). */
  async #checkedOutBranches(repoPath: string): Promise<Map<string, string>> {
    const listed = await this.#runGit(repoPath, ['worktree', 'list', '--porcelain']);
    const map = new Map<string, string>();
    if (!succeeded(listed)) return map;
    for (const entry of parseWorktreeList(listed.stdout)) {
      if (entry.branch !== null && !entry.prunable && !map.has(entry.branch)) map.set(entry.branch, entry.path);
    }
    return map;
  }

  // ── remove (gap #3) ───────────────────────────────────────────────────

  /** Uncommitted and unpushed work in a worktree (what gap #3 refuses to remove). */
  async inspect(worktreeId: string): Promise<WorktreeState> {
    const record = await this.#live(worktreeId);
    return this.#inspect(record, []);
  }

  /**
   * Removes the worktree folder (gap #3): refused with `uncommitted` or `unpushed`
   * when it holds work that is not on a remote, never `--force`, and the branch
   * is kept. A folder that is already gone just leaves the registry.
   */
  async remove(worktreeId: string): Promise<WorktreeRecord> {
    const record = await this.#live(worktreeId);
    let state = await this.#inspect(record, []);
    if (state.exists && state.uncommitted === 0 && state.unpushed > 0 && record.prNumber !== null) {
      // A squash-merged PR whose remote branch was deleted: its head commit is still "pushed".
      const pr = await this.#viewPullRequest(record, String(record.prNumber));
      if (pr.info?.headRefOid) state = await this.#inspect(record, [pr.info.headRefOid]);
    }
    if (state.exists) {
      if (state.uncommitted > 0) {
        throw new WorktreeError('uncommitted', `${record.path} has ${state.uncommitted} uncommitted change${state.uncommitted === 1 ? '' : 's'}`);
      }
      if (state.unpushed > 0) {
        throw new WorktreeError('unpushed', `${record.branch} has ${state.unpushed} commit${state.unpushed === 1 ? '' : 's'} that are not pushed`);
      }
      const removed = await this.#runGit(record.repoPath, ['worktree', 'remove', record.path]);
      if (!succeeded(removed)) throw new WorktreeError('git-failed', `git worktree remove failed: ${failureText(removed)}`);
    }
    return (await this.#store.worktrees.markRemoved(record.id)) ?? record;
  }

  async #live(worktreeId: string): Promise<WorktreeRecord> {
    const record = await this.#store.worktrees.get(worktreeId);
    if (!record) throw new WorktreeError('not-found', `no worktree ${worktreeId}`);
    if (record.removedAt) throw new WorktreeError('removed', `${record.path} was already removed`);
    return record;
  }

  async #inspect(record: WorktreeRecord, pushedOids: readonly string[]): Promise<WorktreeState> {
    if (!(await isDirectory(record.path))) return { exists: false, uncommitted: 0, unpushed: 0 };
    const status = await this.#runGit(record.path, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (!succeeded(status)) throw new WorktreeError('git-failed', `git status failed in ${record.path}: ${failureText(status)}`);
    const uncommitted = status.stdout.split('\n').filter((line) => line.trim() !== '').length;
    const tips = ['HEAD'];
    const branch = await this.#runGit(record.path, ['show-ref', '--verify', '--quiet', `refs/heads/${record.branch}`]);
    if (branch.code === 0) tips.push(`refs/heads/${record.branch}`);
    const exclude = ['--remotes'];
    for (const ref of [record.baseRef, '@{upstream}', ...pushedOids]) {
      if (!ref) continue;
      const resolved = await this.#runGit(record.path, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      if (succeeded(resolved) && resolved.stdout.trim() !== '') exclude.push(resolved.stdout.trim());
    }
    const count = await this.#runGit(record.path, ['rev-list', '--count', ...tips, '--not', ...exclude, '--']);
    if (!succeeded(count)) throw new WorktreeError('git-failed', `git rev-list failed in ${record.path}: ${failureText(count)}`);
    return { exists: true, uncommitted, unpushed: Number.parseInt(count.stdout.trim(), 10) || 0 };
  }

  // ── pull requests ─────────────────────────────────────────────────────

  /**
   * Checks every live worktree's pull request with `gh pr view <branch> --json
   * number,state,url,headRefOid` and stores number, URL and state (verbatim). A
   * worktree becomes `removable` when its PR is `MERGED` and removal would be
   * allowed (gap #3); `worktreeRemovable` fires once, when that flag turns on.
   * D47: a stacked worktree's parent PR is checked too ({@link #checkParent}).
   * Concurrent calls share one run.
   */
  checkPullRequests(): Promise<PullRequestCheck[]> {
    this.#checking ??= (async () => {
      try {
        const results: PullRequestCheck[] = [];
        for (const record of await this.#store.worktrees.list()) {
          results.push(await this.#checkOne(record));
          // D47: a stacked worktree also watches its parent's PR (once merged, never again).
          if (record.parentBranch !== null && record.parentMergedAt === null) {
            try {
              await this.#checkParent(record);
            } catch (error) {
              this.#onError(error);
            }
          }
        }
        return results;
      } finally {
        this.#checking = null;
      }
    })();
    return this.#checking;
  }

  /** Runs {@link checkPullRequests} on a timer until {@link stopPolling}. */
  startPolling(options: PollOptions = {}): void {
    if (this.#polling) return;
    this.#polling = true;
    const interval = options.intervalMs ?? DEFAULT_PR_POLL_MS;
    const tick = async (): Promise<void> => {
      this.#timer = undefined;
      if (!this.#polling) return;
      try {
        await this.checkPullRequests();
      } catch (error) {
        this.#onError(error);
      }
      if (this.#polling) {
        this.#timer = setTimeout(() => void tick(), interval);
        this.#timer.unref();
      }
    };
    this.#timer = setTimeout(() => void tick(), options.initialDelayMs ?? 15_000);
    this.#timer.unref();
  }

  /** Stops the timer and waits for a check that is still running. */
  async stopPolling(): Promise<void> {
    this.#polling = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#checking) await this.#checking.catch(() => undefined);
  }

  async #viewPullRequest(record: WorktreeRecord, selector: string): Promise<{ info: PullRequestInfo | null; none: boolean; error: string | null }> {
    const cwd = (await isDirectory(record.path)) ? record.path : record.repoPath;
    const result = await this.#runGh(cwd, ['pr', 'view', selector, '--json', PR_VIEW_FIELDS]);
    if (succeeded(result)) {
      const info = parsePullRequest(result.stdout);
      return info ? { info, none: false, error: null } : { info: null, none: false, error: `gh pr view printed an unexpected shape: ${result.stdout.slice(0, 200)}` };
    }
    if (result.error === null && isNoPullRequest(result.stderr)) return { info: null, none: true, error: null };
    return { info: null, none: false, error: `gh pr view failed: ${failureText(result)}` };
  }

  async #checkOne(record: WorktreeRecord): Promise<PullRequestCheck> {
    const pr = await this.#viewPullRequest(record, record.branch);
    if (pr.error) return { worktreeId: record.id, prState: record.prState, removable: record.removable, error: pr.error };
    const patch: { -readonly [K in keyof WorktreePatch]: WorktreePatch[K] } = { prCheckedAt: new Date().toISOString() };
    if (pr.info) {
      patch.prNumber = pr.info.number;
      patch.prUrl = pr.info.url;
      patch.prState = pr.info.state;
    }
    const prState = pr.info?.state ?? record.prState;
    let removable = false;
    let error: string | null = null;
    if (prState === 'MERGED') {
      try {
        const state = await this.#inspect(record, pr.info?.headRefOid ? [pr.info.headRefOid] : []);
        removable = !state.exists || (state.uncommitted === 0 && state.unpushed === 0);
      } catch (inspectError) {
        error = errorText(inspectError);
        removable = false;
      }
    }
    patch.removable = removable;
    const updated = await this.#store.worktrees.update(record.id, patch);
    if (updated && removable && !record.removable) this.#emit(toWorktree(updated));
    return { worktreeId: record.id, prState, removable, error };
  }

  /**
   * D47 (rule 5): `gh pr view <parent> --json number,state,url,baseRefName,headRefOid`
   * for a stacked worktree. The PR's number, URL, state, base and head are stored;
   * no PR or a gh failure changes nothing. When it is `MERGED` (and its base is
   * known): `git fetch origin --prune` in the repo, then how it merged (its last
   * head is an ancestor of `origin/<base>`: `merge`, else `squash`; `unknown` when
   * the fetch fails or the head is not known), `parent_merged_at`, and the row's
   * `base_ref` becomes `origin/<base>` (where the branch goes after its rebase);
   * then `parentMerged` fires, once per worktree. D47 ruling D47-closed-parent:
   * a PR that turns `CLOSED` (from any other reported state, or none) sets
   * `parent_closed_at` and `parentClosed` fires, once per worktree (a parent
   * already closed when the worktree was made does not). Switchboard never
   * retargets, rebases or pushes anything itself.
   */
  async #checkParent(record: WorktreeRecord): Promise<void> {
    const parent = record.parentBranch;
    if (parent === null) return;
    const cwd = (await isDirectory(record.path)) ? record.path : record.repoPath;
    const status = await this.#parentStatus(cwd, parent);
    if (status.kind !== 'pr') {
      if (status.kind === 'unknown') this.#onError(new Error(`parent ${parent} of ${record.branch}: ${status.error}`));
      return;
    }
    const { pr } = status;
    const parentBase = pr.baseRefName ?? record.parentBase;
    const parentHeadOid = pr.headRefOid ?? record.parentHeadOid;
    const patch: { -readonly [K in keyof WorktreePatch]: WorktreePatch[K] } = {
      parentPrNumber: pr.number,
      parentPrUrl: pr.url,
      parentPrState: pr.state,
      parentBase,
      parentHeadOid,
    };
    const merged = pr.state === 'MERGED' && parentBase !== null;
    const closed = pr.state === 'CLOSED' && record.parentPrState !== 'CLOSED' && record.parentClosedAt === null;
    if (closed) patch.parentClosedAt = new Date().toISOString();
    if (merged) {
      patch.parentMerge = await this.#mergeKind(record.repoPath, parentHeadOid, parentBase);
      patch.parentMergedAt = new Date().toISOString();
      patch.baseRef = `origin/${parentBase}`;
    }
    const updated = await this.#store.worktrees.update(record.id, patch);
    if (closed && updated) {
      for (const listener of this.#closedListeners) {
        try {
          listener(updated);
        } catch (error) {
          this.#onError(error);
        }
      }
    }
    if (merged && updated) {
      for (const listener of this.#parentListeners) {
        try {
          listener(updated);
        } catch (error) {
          this.#onError(error);
        }
      }
    }
  }

  /** D47: how a merged parent reached `origin/<base>` (after a fetch): its last head an ancestor → `merge`, not → `squash`, else `unknown`. */
  async #mergeKind(repoPath: string, head: string | null, base: string): Promise<MergeKind> {
    if (head === null) return 'unknown';
    const fetched = await this.#fetch(repoPath, ['fetch', 'origin', '--prune']);
    if (!succeeded(fetched)) return 'unknown';
    if (!(await this.#refExists(repoPath, `refs/remotes/origin/${base}`)) || !(await this.#refExists(repoPath, head))) return 'unknown';
    const ancestor = await this.#runGit(repoPath, ['merge-base', '--is-ancestor', head, `refs/remotes/origin/${base}`]);
    if (ancestor.error !== null) return 'unknown';
    return ancestor.code === 0 ? 'merge' : ancestor.code === 1 ? 'squash' : 'unknown';
  }

  #emit(worktree: Worktree): void {
    for (const listener of this.#listeners) {
      try {
        listener(worktree);
      } catch (error) {
        this.#onError(error);
      }
    }
  }

  // ── diff (gap #10) ────────────────────────────────────────────────────

  /**
   * Changed files of a session (gap #10; D90 `scope`, `docs/worktrees.md` → *Diff*):
   * - `branch` (the default here, as before D90): each of its worktrees against the
   *   merge-base with its base branch (committed and uncommitted changes, new
   *   untracked files); each solution in scope without a worktree (in place)
   *   against its HEAD, resolved in the session's own folder (D14);
   * - `head`: every working tree against HEAD (uncommitted changes only); in place
   *   only the files the session touched ({@link SessionTouchedFiles});
   * - `repo`: every working tree against HEAD, every file.
   *
   * `file` limits the result to that solution-relative path. Each file says
   * whether it still has uncommitted changes (`FileDiff.uncommitted`). A solution
   * that cannot be read is skipped (reported through `onError`).
   */
  async diff(sessionId: string, file?: string, scope: DiffScope = 'branch'): Promise<FileDiff[]> {
    const session = await this.#store.sessions.get(sessionId);
    if (!session) return [];
    const files: FileDiff[] = [];
    for (const target of await this.#diffTargets(session)) {
      try {
        const touched = scope === 'head' && !target.worktree ? await this.touched.paths(session, target.dir) : null;
        files.push(...(await this.#diffTarget(target, file, scope === 'branch' && target.worktree, touched)));
      } catch (error) {
        this.#onError(error);
      }
    }
    return files;
  }

  /**
   * D90: the working trees the session's diff reads: its worktrees (branch, base,
   * commits since the merge-base) and the solutions it works on in place (their
   * checked-out branch). Unreadable ones are left out.
   */
  async targets(sessionId: string): Promise<DiffTargets> {
    const session = await this.#store.sessions.get(sessionId);
    if (!session) return { worktrees: [], inPlace: [] };
    const worktrees: Array<DiffTargets['worktrees'][number]> = [];
    const inPlace: Array<DiffTargets['inPlace'][number]> = [];
    for (const target of await this.#diffTargets(session)) {
      try {
        if (!(await isDirectory(target.dir))) continue;
        if (target.worktree) {
          const base = target.baseRef === null ? null : await this.#mergeBase(target.dir, target.baseRef);
          const count = base === null ? null : await this.#runGit(target.dir, ['rev-list', '--count', `${base}..HEAD`]);
          const commits = count !== null && succeeded(count) ? Number.parseInt(count.stdout.trim(), 10) || 0 : 0;
          worktrees.push({ solution: target.solution, branch: target.branch ?? '', base: target.baseRef, commits });
        } else {
          inPlace.push({ solution: target.solution, branch: await this.#currentBranch(target.dir) });
        }
      } catch (error) {
        this.#onError(error);
      }
    }
    return { worktrees, inPlace };
  }

  /**
   * D90 ruling (2026-10-09): how many files the Diff tab's view lists for `scope`
   * (the session tab's "Diff · n"), from file names only (`git diff --name-only` and
   * the untracked files; no patches). `branch` without a worktree and `repo` without
   * an in-place solution count `head`, as the tab shows then ({@link offeredDiffScope}).
   * The count is the same as `diff(sessionId, undefined, answer.scope).length`.
   */
  async count(sessionId: string, scope: DiffScope): Promise<DiffCount> {
    const session = await this.#store.sessions.get(sessionId);
    if (!session) return { scope: 'head', files: 0 };
    // The working trees that exist, as `targets()` lists them (so the view is the tab's).
    const targets: DiffTarget[] = [];
    for (const target of await this.#diffTargets(session)) if (await isDirectory(target.dir)) targets.push(target);
    const shown = offeredDiffScope(scope, { worktrees: targets.filter((t) => t.worktree), inPlace: targets.filter((t) => !t.worktree) });
    let files = 0;
    for (const target of targets) {
      try {
        const touched = shown === 'head' && !target.worktree ? await this.touched.paths(session, target.dir) : null;
        files += await this.#countTarget(target, shown === 'branch' && target.worktree, touched);
      } catch (error) {
        this.#onError(error);
      }
    }
    return { scope: shown, files };
  }

  /** {@link #diffTarget}'s file count from names only. */
  async #countTarget(target: DiffTarget, wholeBranch: boolean, touched: ReadonlySet<string> | null): Promise<number> {
    if (!(await isDirectory(target.dir))) return 0;
    const head = await this.#runGit(target.dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (!succeeded(head) || head.stdout.trim() === '') return 0;
    if (touched !== null && touched.size === 0) return 0;
    let base = head.stdout.trim();
    if (wholeBranch && target.baseRef !== null) base = (await this.#mergeBase(target.dir, target.baseRef)) ?? base;
    const names = await this.#runGit(target.dir, ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', base, '--']);
    if (!succeeded(names)) throw new WorktreeError('git-failed', `git diff --name-only failed in ${target.dir}: ${failureText(names)}`);
    const untracked = await this.#runGit(target.dir, ['ls-files', '--others', '--exclude-standard', '-z', '--']);
    if (!succeeded(untracked)) throw new WorktreeError('git-failed', `git ls-files failed in ${target.dir}: ${failureText(untracked)}`);
    const keep = (relative: string): boolean => touched === null || touched.has(relative);
    return new Set([...splitNulList(names.stdout), ...splitNulList(untracked.stdout)].filter(keep)).size;
  }

  /** The session's diff targets: its worktrees, then its in-place solutions (D14: resolved in its folder). */
  async #diffTargets(session: SessionRecord): Promise<DiffTarget[]> {
    const worktrees = await this.#store.worktrees.list({ sessionId: session.id });
    const targets: DiffTarget[] = worktrees.map((w) => ({ solution: w.repo, dir: w.path, branch: w.branch, baseRef: w.baseRef ?? null, worktree: true }));
    const folder = folderOfSession(session);
    for (const solution of folder ? session.solutions : []) {
      if (worktrees.some((w) => w.repo === solution)) continue;
      let repo: RepoLocation;
      try {
        repo = await this.resolveRepo(solution, folder as FolderRef);
      } catch {
        continue;
      }
      if (worktrees.some((w) => w.repoPath === repo.repoPath)) continue;
      targets.push({ solution, dir: repo.repoPath, branch: null, baseRef: null, worktree: false });
    }
    return targets;
  }

  /** The merge-base of `ref` and HEAD, `null` when it does not resolve. */
  async #mergeBase(dir: string, ref: string): Promise<string | null> {
    const mergeBase = await this.#runGit(dir, ['merge-base', ref, 'HEAD']);
    return succeeded(mergeBase) && mergeBase.stdout.trim() !== '' ? mergeBase.stdout.trim() : null;
  }

  /** The checked-out branch, `null` when detached. */
  async #currentBranch(dir: string): Promise<string | null> {
    const symbolic = await this.#runGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return succeeded(symbolic) && symbolic.stdout.trim() !== '' ? symbolic.stdout.trim() : null;
  }

  /**
   * One working tree's files: against the merge-base of its base and HEAD when
   * `wholeBranch`, else against HEAD; `touched` (a set of relative paths) keeps only
   * those files (D90, in place).
   */
  async #diffTarget(target: DiffTarget, file: string | undefined, wholeBranch: boolean, touched: ReadonlySet<string> | null): Promise<FileDiff[]> {
    if (!(await isDirectory(target.dir))) return [];
    const head = await this.#runGit(target.dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (!succeeded(head) || head.stdout.trim() === '') return [];
    if (touched !== null && touched.size === 0) return [];
    const headSha = head.stdout.trim();
    let base = headSha;
    if (wholeBranch && target.baseRef !== null) base = (await this.#mergeBase(target.dir, target.baseRef)) ?? headSha;
    const branch = target.branch ?? (await this.#currentBranch(target.dir));
    const pathspec = file === undefined ? ['--'] : ['--', `:(literal)${file}`];
    const patch = await this.#runGit(target.dir, [
      '-c',
      'core.quotePath=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      base,
      ...pathspec,
    ]);
    if (!succeeded(patch)) throw new WorktreeError('git-failed', `git diff failed in ${target.dir}: ${failureText(patch)}`);
    const keep = (relative: string): boolean => touched === null || touched.has(relative);
    const parsed: PatchFile[] = parsePatch(patch.stdout).filter((entry) => keep(entry.path));
    const untracked = await this.#runGit(target.dir, ['ls-files', '--others', '--exclude-standard', '-z', ...pathspec]);
    if (!succeeded(untracked)) throw new WorktreeError('git-failed', `git ls-files failed in ${target.dir}: ${failureText(untracked)}`);
    const untrackedPaths = new Set(splitNulList(untracked.stdout).filter(keep));
    for (const relative of untrackedPaths) parsed.push(await this.#untracked(target.dir, relative));
    parsed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // Against HEAD every listed change is uncommitted; against a merge-base, only the files that still differ from HEAD (or are untracked).
    const dirty = base === headSha ? null : await this.#changedSinceHead(target.dir, pathspec);
    return parsed.map((entry) => toFileDiff(target.solution, branch, entry, dirty === null || dirty.has(entry.path) || untrackedPaths.has(entry.path)));
  }

  /** Tracked files whose working tree or index differs from HEAD (`FileDiff.uncommitted`). */
  async #changedSinceHead(dir: string, pathspec: readonly string[]): Promise<Set<string>> {
    const changed = await this.#runGit(dir, ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', 'HEAD', ...pathspec]);
    if (!succeeded(changed)) throw new WorktreeError('git-failed', `git diff --name-only failed in ${dir}: ${failureText(changed)}`);
    return new Set(splitNulList(changed.stdout));
  }

  async #untracked(dir: string, relative: string): Promise<PatchFile> {
    const absolute = path.join(dir, relative);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      const link = await readlink(absolute);
      return { path: relative, added: 1, removed: 0, lines: [newFileHunkHeader(1), `+${link}`], binary: false };
    }
    if (info.size > UNTRACKED_READ_LIMIT) return { path: relative, added: 0, removed: 0, lines: [], binary: true };
    const handle = await open(absolute, 'r');
    try {
      const buffer = Buffer.alloc(info.size);
      const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
      return untrackedFileDiff(relative, buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  // ── processes ─────────────────────────────────────────────────────────

  /** The folder resolved on disk. @throws {WorktreeError} `folder-missing`. */
  async #folderRoot(folder: FolderRef): Promise<string> {
    try {
      return await realpath(folder.root);
    } catch {
      throw new WorktreeError('folder-missing', `the folder does not exist: ${folder.path}`);
    }
  }

  #runGit(cwd: string, args: readonly string[], timeoutMs: number = this.#gitTimeout): Promise<RunResult> {
    const options: RunOptions = {
      cwd,
      env: { ...this.#env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      timeoutMs,
    };
    return runCommand(this.#git, args, options);
  }

  #runGh(cwd: string, args: readonly string[]): Promise<RunResult> {
    return runCommand(this.#gh, args, {
      cwd,
      env: { ...this.#env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      timeoutMs: this.#ghTimeout,
    });
  }
}
