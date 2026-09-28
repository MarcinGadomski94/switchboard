import { lstat, open, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FileDiff, Worktree } from '../../core/api.ts';
import type { UserMessageOrigin } from '../../core/event-payload.ts';
import {
  PR_VIEW_FIELDS,
  type PatchFile,
  type PullRequestInfo,
  isNoPullRequest,
  moveToWorktreeMessage,
  parsePatch,
  parsePullRequest,
  solutionCandidates,
  splitNulList,
  toFileDiff,
  untrackedFileDiff,
  worktreeBranch,
  worktreePath,
} from '../../core/worktrees.ts';
import type { WorktreePatch, WorktreeRecord } from '../db/repos/worktrees.ts';
import type { Store } from '../db/store.ts';
import { type RunOptions, type RunResult, failureText, runCommand, succeeded } from '../exec.ts';
import type { DiffProvider } from '../providers.ts';
import { isReadOnlyByLayout } from '../sessions/validate.ts';
import { toWorktree } from './wire.ts';

/** Why the worktree manager refused a call. `code` maps to an HTTP status in the routes. */
export type WorktreeErrorCode =
  | 'workspace-not-configured'
  | 'workspace-missing'
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
  | 'git-failed';

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

/** Options for {@link WorktreeManager}. */
export interface WorktreeManagerOptions {
  readonly store: Store;
  /** `SWITCHBOARD_WORKSPACE_ROOT`; nothing can be created while it is `null`. */
  readonly workspaceRoot: string | null;
  /** `SWITCHBOARD_GH_BIN` argv prefix. */
  readonly ghCommand: readonly string[];
  /** git argv prefix (default `["git"]`; tests wrap it to log every call). */
  readonly gitCommand?: readonly string[];
  /** Base environment of git / gh (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** The supervisor, for isolate (gap #2). */
  readonly sessions?: SessionControl;
  /** ms before a git (default 120 s) or gh (default 30 s) call is killed. */
  readonly timeouts?: { readonly git?: number; readonly gh?: number };
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

/** Result of {@link WorktreeManager.isolate}. */
export interface IsolateResult {
  readonly worktree: WorktreeRecord;
  /** `false` when the session already had a worktree for that repo (nothing was done). */
  readonly created: boolean;
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

interface DiffTarget {
  readonly solution: string;
  readonly dir: string;
  readonly branch: string | null;
  /** `null` = diff against HEAD (in place); else the merge-base with this ref (worktree). */
  readonly mergeBaseWith: string | null;
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
async function isMainCheckout(dir: string): Promise<boolean> {
  try {
    return (await lstat(path.join(dir, '.git'))).isDirectory();
  } catch {
    return false;
  }
}

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
  #root: string | null;
  readonly #gh: readonly string[];
  readonly #git: readonly string[];
  readonly #env: NodeJS.ProcessEnv;
  readonly #sessions: SessionControl | null;
  readonly #gitTimeout: number;
  readonly #ghTimeout: number;
  readonly #onError: (error: unknown) => void;
  readonly #listeners = new Set<Listener>();
  #checking: Promise<PullRequestCheck[]> | null = null;
  #timer: NodeJS.Timeout | undefined;
  #polling = false;

  constructor(options: WorktreeManagerOptions) {
    this.#store = options.store;
    this.#root = options.workspaceRoot;
    this.#gh = options.ghCommand;
    this.#git = options.gitCommand ?? ['git'];
    this.#env = options.env ?? process.env;
    this.#sessions = options.sessions ?? null;
    this.#gitTimeout = options.timeouts?.git ?? 120_000;
    this.#ghTimeout = options.timeouts?.gh ?? 30_000;
    this.#onError = options.onError ?? ((error) => console.error('switchboard worktrees:', error));
  }

  /** Subscribes to `worktreeRemovable`; returns the unsubscribe function. */
  on(name: keyof WorktreeEvents, listener: Listener): () => void {
    void name;
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The workspace root solutions resolve in, as the setup wizard changed it (M5.3, `docs/setup.md`). Registered worktrees keep their paths. */
  setWorkspaceRoot(root: string | null): void {
    this.#root = root;
  }

  // ── solutions ─────────────────────────────────────────────────────────

  /**
   * The main checkout a solution name means (router layout: `mobile`,
   * `<group>/<name>`, or a relative path). Read-only folders are refused.
   */
  async resolveRepo(solution: string): Promise<RepoLocation> {
    const root = await this.#workspaceRoot();
    if (isReadOnlyByLayout(solution)) throw new WorktreeError('read-only', `"${solution}" is read-only and cannot get a worktree`);
    const candidates = solutionCandidates(root, solution);
    if (candidates === null) throw new WorktreeError('solution-not-found', `"${solution}" is not a workspace solution`);
    const found: string[] = [];
    for (const candidate of candidates) if (await isMainCheckout(candidate)) found.push(candidate);
    if (found.length === 0) throw new WorktreeError('solution-not-found', `no git repository for "${solution}" in the workspace`);
    if (found.length > 1) {
      throw new WorktreeError('solution-ambiguous', `"${solution}" matches several repositories: ${found.map((f) => path.relative(root, f)).join(', ')}`);
    }
    return { solution, repoPath: await realpath(found[0] as string) };
  }

  // ── create (gap #1) ───────────────────────────────────────────────────

  /**
   * Creates one worktree per solution (gap #1: branch `session/{name}` from the
   * repo's current HEAD, folder `../{repo}-wt-{name}`) and registers it. All or
   * nothing: every precondition is checked first, and a failure part-way removes
   * the worktrees this call made. `sessionId` may be set later with {@link assign}.
   */
  async createForSession(sessionName: string, solutions: readonly string[], sessionId: string | null = null): Promise<WorktreeRecord[]> {
    const plans: Plan[] = [];
    for (const solution of solutions) {
      const plan = await this.#plan(solution, sessionName);
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
   * of the branch it just made (never `-D`), then the row is marked removed.
   */
  async discard(records: readonly WorktreeRecord[]): Promise<void> {
    for (const record of [...records].reverse()) {
      const removed = await this.#runGit(record.repoPath, ['worktree', 'remove', record.path]);
      if (!succeeded(removed)) this.#onError(new Error(`could not discard ${record.path}: ${failureText(removed)}`));
      else {
        const branch = await this.#runGit(record.repoPath, ['branch', '-d', record.branch]);
        if (!succeeded(branch)) this.#onError(new Error(`kept branch ${record.branch}: ${failureText(branch)}`));
      }
      await this.#store.worktrees.markRemoved(record.id);
    }
  }

  async #plan(solution: string, sessionName: string): Promise<Plan> {
    const { repoPath } = await this.resolveRepo(solution);
    const branch = worktreeBranch(sessionName);
    const target = worktreePath(repoPath, sessionName);
    if ((await pathExists(target)) || (await this.#store.worktrees.getLiveByPath(target))) {
      throw new WorktreeError('path-exists', `${target} already exists`);
    }
    const head = await this.#runGit(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (!succeeded(head) || head.stdout.trim() === '') throw new WorktreeError('no-commits', `${solution} has no commit to branch from`);
    const headSha = head.stdout.trim();
    const existing = await this.#runGit(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (existing.code === 0) throw new WorktreeError('branch-exists', `${solution} already has a branch ${branch}`);
    const symbolic = await this.#runGit(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const base = succeeded(symbolic) && symbolic.stdout.trim() !== '' ? symbolic.stdout.trim() : headSha;
    return { solution, repoPath, branch, path: target, headSha, base };
  }

  async #create(plan: Plan, sessionId: string | null): Promise<WorktreeRecord> {
    const added = await this.#runGit(plan.repoPath, ['worktree', 'add', '-b', plan.branch, plan.path, plan.headSha]);
    if (!succeeded(added)) throw new WorktreeError('git-failed', `git worktree add failed for ${plan.solution}: ${failureText(added)}`);
    try {
      return await this.#store.worktrees.create({
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
  }

  // ── isolate (gap #2) ──────────────────────────────────────────────────

  /**
   * "Move … to worktree" (gap #2): creates the session's worktree for `repo`, then
   * pauses the session (when it has a live process) and resumes it with a message
   * telling it to move its work there. The developer's working tree is never
   * stashed, reset or checked out. A session that already has a worktree for `repo`
   * gets nothing new (`created: false`). Refused while the session is detached.
   */
  async isolate(repo: string, sessionId: string): Promise<IsolateResult> {
    const session = await this.#store.sessions.get(sessionId);
    if (!session) throw new WorktreeError('session-not-found', `no session ${sessionId}`);
    const existing = (await this.#store.worktrees.list({ sessionId, repo }))[0];
    if (existing) return { worktree: existing, created: false };
    if (!session.attached) throw new WorktreeError('detached', 'the session continues in a terminal; attach it first');
    const control = this.#sessions;
    if (!control) throw new Error('isolate needs the session supervisor');
    const [worktree] = await this.createForSession(session.name, [repo], session.id);
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
      }),
      'service',
    );
    return { worktree, created: true };
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
   * allowed (gap #3); `worktreeRemovable` fires once, when that flag turns on. PR
   * artifacts with the same URL get the state as their meta (`open`, `merged`, …).
   * Concurrent calls share one run.
   */
  checkPullRequests(): Promise<PullRequestCheck[]> {
    this.#checking ??= (async () => {
      try {
        const results: PullRequestCheck[] = [];
        for (const record of await this.#store.worktrees.list()) results.push(await this.#checkOne(record));
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
    if (pr.info?.url) await this.#updatePullRequestArtifacts(pr.info);
    if (updated && removable && !record.removable) this.#emit(toWorktree(updated));
    return { worktreeId: record.id, prState, removable, error };
  }

  async #updatePullRequestArtifacts(info: PullRequestInfo): Promise<void> {
    const meta = info.state.toLowerCase();
    for (const artifact of await this.#store.artifacts.list({ types: ['PR'] })) {
      if (artifact.url === info.url && artifact.meta !== meta) await this.#store.artifacts.update(artifact.id, { meta });
    }
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
   * Changed files of a session (gap #10): each of its worktrees against the
   * merge-base with its base branch, committed and uncommitted changes and new
   * untracked files included; each solution in scope without a worktree (in
   * place) against its HEAD. `file` limits the result to that solution-relative
   * path. A solution that cannot be read is skipped (reported through `onError`).
   */
  async diff(sessionId: string, file?: string): Promise<FileDiff[]> {
    const session = await this.#store.sessions.get(sessionId);
    if (!session) return [];
    const worktrees = await this.#store.worktrees.list({ sessionId });
    const targets: DiffTarget[] = worktrees.map((w) => ({ solution: w.repo, dir: w.path, branch: w.branch, mergeBaseWith: w.baseRef ?? 'HEAD', worktree: true }));
    for (const solution of session.solutions) {
      if (worktrees.some((w) => w.repo === solution)) continue;
      let repo: RepoLocation;
      try {
        repo = await this.resolveRepo(solution);
      } catch {
        continue;
      }
      if (worktrees.some((w) => w.repoPath === repo.repoPath)) continue;
      targets.push({ solution, dir: repo.repoPath, branch: null, mergeBaseWith: null, worktree: false });
    }
    const files: FileDiff[] = [];
    for (const target of targets) {
      try {
        files.push(...(await this.#diffTarget(target, file)));
      } catch (error) {
        this.#onError(error);
      }
    }
    return files;
  }

  async #diffTarget(target: DiffTarget, file: string | undefined): Promise<FileDiff[]> {
    if (!(await isDirectory(target.dir))) return [];
    const head = await this.#runGit(target.dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (!succeeded(head) || head.stdout.trim() === '') return [];
    let base = head.stdout.trim();
    if (target.mergeBaseWith !== null) {
      const mergeBase = await this.#runGit(target.dir, ['merge-base', target.mergeBaseWith, 'HEAD']);
      if (succeeded(mergeBase) && mergeBase.stdout.trim() !== '') base = mergeBase.stdout.trim();
    }
    let branch = target.branch;
    if (branch === null) {
      const symbolic = await this.#runGit(target.dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      branch = succeeded(symbolic) && symbolic.stdout.trim() !== '' ? symbolic.stdout.trim() : null;
    }
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
    const parsed: PatchFile[] = parsePatch(patch.stdout);
    const untracked = await this.#runGit(target.dir, ['ls-files', '--others', '--exclude-standard', '-z', ...pathspec]);
    if (!succeeded(untracked)) throw new WorktreeError('git-failed', `git ls-files failed in ${target.dir}: ${failureText(untracked)}`);
    for (const relative of splitNulList(untracked.stdout)) parsed.push(await this.#untracked(target.dir, relative));
    parsed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return parsed.map((entry) => toFileDiff(target.solution, branch, entry));
  }

  async #untracked(dir: string, relative: string): Promise<PatchFile> {
    const absolute = path.join(dir, relative);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      const link = await readlink(absolute);
      return { path: relative, added: 1, removed: 0, lines: [`+${link}`], binary: false };
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

  async #workspaceRoot(): Promise<string> {
    if (!this.#root) throw new WorktreeError('workspace-not-configured', 'SWITCHBOARD_WORKSPACE_ROOT is not set');
    try {
      return await realpath(this.#root);
    } catch {
      throw new WorktreeError('workspace-missing', `the workspace root does not exist: ${this.#root}`);
    }
  }

  #runGit(cwd: string, args: readonly string[]): Promise<RunResult> {
    const options: RunOptions = {
      cwd,
      env: { ...this.#env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      timeoutMs: this.#gitTimeout,
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
