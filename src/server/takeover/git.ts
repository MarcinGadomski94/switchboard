import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rm, rmdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type CapturedRepo, REMOTE_CHECK_TIMEOUT_MS, type SourceRepo, type WorktreeEntry, type WorktreeSlot, gitErrorSummary, nonInteractiveGitEnv, normalizeRemoteUrl, parseWorktreeList, redactUrl, tempBranchName } from '../../core/takeover.ts';
import { TARGET_CHANGES_LISTED, type TargetChanges, type WorktreeCarryFacts } from '../../core/move-worktrees.ts';
import { DIVERGED_LISTED, type TargetDiverged, backupBranchName, cleanSubject } from '../../core/move-overwrite.ts';
import { failureText, runCommand, succeeded } from '../exec.ts';

/**
 * D65 (`docs/peers.md` → *Taking a session over* → *Code travels through git*):
 * the git side of a take-over. Every call is argv-only (`shell: false`) and is
 * written to the take-over log (`git -C <dir> <args>`, never a credential: URLs
 * are logged without their userinfo). Nothing here pushes a real branch, forces
 * anything outside the `switchboard/takeover/` namespace, or touches a branch
 * other than the session's.
 */

/** A git failure with the command that failed. */
export class TakeoverGitError extends Error {
  override name = 'TakeoverGitError';
}

/** Collects the commands a take-over ran. */
export type GitLog = (line: string) => void;

/** The identity of the throw-away WIP commit (the user's own `user.name` may be unset on the machine). */
const WIP_IDENTITY = {
  GIT_AUTHOR_NAME: 'Switchboard',
  GIT_AUTHOR_EMAIL: 'switchboard@localhost',
  GIT_COMMITTER_NAME: 'Switchboard',
  GIT_COMMITTER_EMAIL: 'switchboard@localhost',
} as const;

/** One git runner with a log. */
export class TakeoverGit {
  readonly #log: GitLog;
  readonly #env: NodeJS.ProcessEnv;
  readonly #timeoutMs: number;

  constructor(options: { readonly log: GitLog; readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number }) {
    this.#log = options.log;
    this.#env = options.env ?? process.env;
    this.#timeoutMs = options.timeoutMs ?? 180_000;
  }

  /** Runs `git -C <cwd> <args>`; the text of its stdout (trimmed) on success, else throws {@link TakeoverGitError}. */
  async run(cwd: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
    const result = await this.try(cwd, args, extraEnv);
    if (!result.ok) throw new TakeoverGitError(`git ${redactArgs(args).join(' ')} failed in ${cwd}: ${result.error}`);
    return result.out;
  }

  /** Like {@link run}, but the outcome as a value (for probes whose failure is an answer). */
  async try(cwd: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}, timeoutMs: number = this.#timeoutMs): Promise<{ readonly ok: boolean; readonly out: string; readonly error: string; readonly stderr: string; readonly code: number | null; readonly timedOut: boolean }> {
    const shown = `git -C ${cwd} ${redactArgs(args).join(' ')}`;
    const result = await runCommand(['git'], args, { cwd, env: { ...this.#env, GIT_TERMINAL_PROMPT: '0', ...extraEnv }, timeoutMs });
    const ok = succeeded(result);
    this.#log(ok ? shown : `${shown}  → failed: ${failureText(result)}`);
    return { ok, out: result.stdout.trim(), error: failureText(result), stderr: result.stderr, code: result.code, timedOut: result.timedOut };
  }

  // ── talking to a remote (never a prompt) ─────────────────────────────

  /**
   * The environment of a call that talks to a remote ({@link nonInteractiveGitEnv}):
   * no terminal, askpass or Credential Manager prompt, and ssh in batch mode, so a
   * key that needs a passphrase or an unknown host key fails at once instead of
   * hanging the background service. Read fresh for every call (the repo's
   * `core.sshCommand` where it runs).
   */
  async #remoteEnv(cwd: string): Promise<Record<string, string>> {
    const configured = await runCommand(['git'], ['config', '--get', 'core.sshCommand'], { cwd, env: { ...this.#env, GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 10_000 });
    return nonInteractiveGitEnv(this.#env, succeeded(configured) ? configured.stdout.trim() || null : null);
  }

  /** {@link try} for a call that talks to a remote (fetch, push, clone, ls-remote): never waits for a prompt. */
  async tryRemote(cwd: string, args: readonly string[], timeoutMs: number = this.#timeoutMs): ReturnType<TakeoverGit['try']> {
    return this.try(cwd, args, await this.#remoteEnv(cwd), timeoutMs);
  }

  /** {@link run} for a call that talks to a remote: never waits for a prompt. */
  async runRemote(cwd: string, args: readonly string[]): Promise<string> {
    const result = await this.tryRemote(cwd, args);
    // The reason (e.g. "Permission denied (publickey)"), not git's closing "make sure you have the correct access rights".
    if (!result.ok) throw new TakeoverGitError(`git ${redactArgs(args).join(' ')} failed in ${cwd}: ${(result.stderr && gitErrorSummary(result.stderr)) || result.error}`);
    return result.out;
  }

  /**
   * Whether this machine (this process: the background service, with its own
   * environment, keys and credential helpers) can read `remote` (a remote's name in
   * `cwd`, or a URL): `git ls-remote <remote> HEAD`, read-only, non-interactive,
   * at most {@link REMOTE_CHECK_TIMEOUT_MS}. The failure carries git's reason
   * ({@link gitErrorSummary}, credentials removed). Never cached: every check asks again.
   */
  async reachable(cwd: string, remote: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string; readonly timedOut: boolean }> {
    const result = await this.tryRemote(cwd, ['ls-remote', remote, 'HEAD'], REMOTE_CHECK_TIMEOUT_MS);
    if (result.ok) return { ok: true };
    return { ok: false, reason: gitErrorSummary(result.stderr || result.error), timedOut: result.timedOut };
  }

  /** The raw stdout (not trimmed: `-z` output), or `null` when it failed. */
  async raw(cwd: string, args: readonly string[]): Promise<string | null> {
    const shown = `git -C ${cwd} ${redactArgs(args).join(' ')}`;
    const result = await runCommand(['git'], args, { cwd, env: { ...this.#env, GIT_TERMINAL_PROMPT: '0' }, timeoutMs: this.#timeoutMs });
    this.#log(succeeded(result) ? shown : `${shown}  → failed: ${failureText(result)}`);
    return succeeded(result) ? result.stdout : null;
  }

  // ── reading a repo (the source side) ────────────────────────────────

  /** `true` when `dir` is inside a git work tree. */
  async isRepo(dir: string): Promise<boolean> {
    return (await this.try(dir, ['rev-parse', '--is-inside-work-tree'])).out === 'true';
  }

  /**
   * The repo's main checkout (`git rev-parse --git-common-dir`'s work tree) for any checkout or worktree of it,
   * as a real native path: git says `C:/Users/…` on Windows, and callers compare it with `realpath`'d folders.
   */
  async mainCheckout(dir: string): Promise<string | null> {
    const common = await this.try(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!common.ok || common.out === '') return null;
    // A normal repo: `<repo>/.git`; a bare repo or a worktree's common dir `…/.git` as well.
    if (path.basename(common.out) !== '.git') return null;
    const main = path.resolve(path.dirname(common.out));
    return realpath(main).catch(() => main);
  }

  /** The checked-out branch of `dir`; `null` for a detached HEAD or when git cannot tell. */
  async currentBranch(dir: string): Promise<string | null> {
    const result = await this.try(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return result.ok && result.out !== '' ? result.out : null;
  }

  /** What `dir` has checked out: the branch name, else the detached commit; `null` when it has no commit. */
  async headRef(dir: string): Promise<string | null> {
    return (await this.currentBranch(dir)) ?? (await this.sha(dir, 'HEAD'));
  }

  /** The commit `ref` names, or `null`. */
  async sha(dir: string, ref: string): Promise<string | null> {
    const result = await this.try(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return result.ok && result.out !== '' ? result.out : null;
  }

  /** The remote the branch pushes to: its configured remote, else `origin`, else the only remote; `null` when there is none. */
  async remoteOf(dir: string, branch: string): Promise<{ readonly name: string; readonly url: string } | null> {
    const configured = await this.try(dir, ['config', '--get', `branch.${branch}.remote`]);
    const listed = (await this.try(dir, ['remote'])).out.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    let name = configured.ok && configured.out !== '' && configured.out !== '.' ? configured.out : null;
    if (name === null) name = listed.includes('origin') ? 'origin' : listed.length === 1 ? (listed[0] as string) : null;
    if (name === null) return null;
    const url = await this.try(dir, ['remote', 'get-url', name]);
    return url.ok && url.out !== '' ? { name, url: url.out } : null;
  }

  /** The remote of `dir` whose URL matches `remoteKey` ({@link normalizeRemoteUrl}); `null` when none does. */
  async remoteByKey(dir: string, remoteKey: string): Promise<{ readonly name: string; readonly url: string } | null> {
    const names = (await this.try(dir, ['remote'])).out.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    for (const name of names) {
      const url = await this.try(dir, ['remote', 'get-url', name]);
      if (url.ok && normalizeRemoteUrl(url.out) === remoteKey) return { name, url: url.out };
    }
    return null;
  }

  /** The uncommitted files of `dir`: modified (or deleted, renamed) tracked ones and untracked ones; ignored files are not counted. */
  async dirtyCounts(dir: string): Promise<{ readonly modified: number; readonly untracked: number; readonly total: number }> {
    const out = await this.raw(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (out === null) return { modified: 0, untracked: 0, total: 0 };
    const entries = out.split('\0').filter((entry) => entry !== '');
    let untracked = 0;
    let modified = 0;
    // A rename has a second `\0` field (the old path) without a status: it starts with a path, so count by the status column's shape.
    for (const entry of entries) {
      if (entry.startsWith('?? ')) untracked += 1;
      else if (/^[ MADRCU?!]{2} /.test(entry)) modified += 1;
    }
    return { modified, untracked, total: modified + untracked };
  }

  /** Describes one checkout as a {@link SourceRepo} (`null` + the reason when it cannot be handed over). */
  async describe(input: {
    readonly key: string;
    readonly name: string;
    readonly kind: 'main' | 'worktree';
    readonly dir: string;
    readonly baseRef: string | null;
    readonly parentBranch: string | null;
  }): Promise<{ readonly repo: SourceRepo } | { readonly blocker: string }> {
    const { dir } = input;
    if (!(await this.isRepo(dir))) return { blocker: `${dir} is not a git repository any more` };
    const branch = await this.currentBranch(dir);
    if (branch === null) return { blocker: `${input.name} has a detached HEAD: check a branch out first (a take-over carries a branch)` };
    const head = await this.sha(dir, 'HEAD');
    if (head === null) return { blocker: `${input.name} has no commit yet` };
    const remote = await this.remoteOf(dir, branch);
    if (remote === null) return { blocker: `${input.name} has no remote: its work can only travel through a shared remote` };
    const main = input.kind === 'worktree' ? ((await this.mainCheckout(dir)) ?? dir) : dir;
    const upstream = await this.try(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`]);
    let ahead: number | null = null;
    if (upstream.ok && upstream.out !== '') {
      const count = await this.try(dir, ['rev-list', '--count', `${upstream.out}..HEAD`]);
      ahead = count.ok ? Number(count.out) : null;
    }
    return {
      repo: {
        key: input.key,
        name: input.name,
        kind: input.kind,
        path: dir,
        mainPath: main,
        branch,
        remoteName: remote.name,
        remoteUrl: redactUrl(remote.url),
        remoteKey: normalizeRemoteUrl(remote.url),
        headSha: head,
        upstream: upstream.ok && upstream.out !== '' ? upstream.out : null,
        ahead,
        dirty: await this.dirtyCounts(dir),
        baseRef: input.baseRef,
        parentBranch: input.parentBranch,
      },
    };
  }

  // ── the source: the WIP commit and its temp branch ──────────────────

  /**
   * Makes the WIP commit of `repo` **without touching the repo**: a throw-away
   * index is filled from HEAD, `git add -A` adds everything uncommitted (untracked
   * files included, ignored ones not), and `git commit-tree` writes a commit on
   * top of the branch's tip. The branch, HEAD, the real index and the working
   * tree stay exactly as they were, so nothing needs undoing on the source.
   * `null` when nothing is uncommitted (no WIP commit).
   */
  async makeWipCommit(repo: Pick<SourceRepo, 'path' | 'branch'>): Promise<string | null> {
    const index = path.join(os.tmpdir(), `switchboard-takeover-${randomUUID()}.index`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await this.run(repo.path, ['read-tree', 'HEAD'], env);
      await this.run(repo.path, ['add', '-A'], env);
      const tree = await this.run(repo.path, ['write-tree'], env);
      const headTree = await this.run(repo.path, ['rev-parse', 'HEAD^{tree}']);
      if (tree === headTree) return null;
      return await this.run(repo.path, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', 'HEAD', '-m', `Switchboard take-over: work in progress on ${repo.branch}`], { ...env, ...WIP_IDENTITY });
    } finally {
      await rm(index, { force: true }).catch(() => undefined);
    }
  }

  /**
   * D156: the tree of `dir`'s current state (HEAD plus every uncommitted change,
   * untracked files included, ignored ones not), made the way {@link makeWipCommit}
   * makes the WIP commit's tree, with a throw-away index (nothing in the repo
   * changes). `null` when git cannot tell.
   */
  async workingTree(dir: string): Promise<string | null> {
    const index = path.join(os.tmpdir(), `switchboard-cleanup-${randomUUID()}.index`);
    const env = { GIT_INDEX_FILE: index };
    try {
      if (!(await this.try(dir, ['read-tree', 'HEAD'], env)).ok) return null;
      if (!(await this.try(dir, ['add', '-A'], env)).ok) return null;
      const tree = await this.try(dir, ['write-tree'], env);
      return tree.ok && tree.out !== '' ? tree.out : null;
    } finally {
      await rm(index, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Captures `repo` for a take-over: the WIP commit (when something is
   * uncommitted) and the push of its tip (else of the branch's tip) to the temporary
   * remote branch `switchboard/takeover/<session short id>/<branch>`. The push is
   * the only thing that leaves the machine; it never names the real branch.
   */
  async capture(repo: SourceRepo, sessionId: string): Promise<CapturedRepo> {
    const baseSha = await this.run(repo.path, ['rev-parse', 'HEAD']);
    const wipSha = await this.makeWipCommit(repo);
    const tipSha = wipSha ?? baseSha;
    const tempBranch = tempBranchName(sessionId, repo.branch);
    // `+`: the namespace is ours; a leftover of an earlier attempt is replaced, never a real branch.
    await this.runRemote(repo.path, ['push', repo.remoteName, `+${tipSha}:refs/heads/${tempBranch}`]);
    return {
      key: repo.key,
      branch: repo.branch,
      remoteName: repo.remoteName,
      remoteUrl: repo.remoteUrl,
      remoteKey: repo.remoteKey,
      tempBranch,
      baseSha,
      wipSha,
      tipSha,
      uncommitted: repo.dirty.total,
    };
  }

  /** Deletes a temporary remote branch (`git push <remote> --delete`); only ever a name in the take-over namespace. */
  async deleteTempBranch(repoPath: string, remoteName: string, tempBranch: string): Promise<void> {
    if (!tempBranch.startsWith('switchboard/takeover/')) throw new TakeoverGitError(`refusing to delete ${tempBranch}: not a take-over branch`);
    const exists = await this.tryRemote(repoPath, ['ls-remote', '--exit-code', '--heads', remoteName, `refs/heads/${tempBranch}`]);
    // 2 = no such ref: already gone.
    if (!(!exists.ok && exists.code === 2)) await this.runRemote(repoPath, ['push', remoteName, '--delete', `refs/heads/${tempBranch}`]);
    await this.forgetTrackingRef(repoPath, remoteName, tempBranch);
  }

  /**
   * The push that made the temp branch also made a remote-tracking ref for it in
   * the pushing repo (`refs/remotes/<remote>/switchboard/takeover/…`): removed, so
   * the source repo ends as it was.
   */
  async forgetTrackingRef(repoPath: string, remoteName: string, tempBranch: string): Promise<void> {
    if (!tempBranch.startsWith('switchboard/takeover/')) return;
    await this.try(repoPath, ['update-ref', '-d', `refs/remotes/${remoteName}/${tempBranch}`]);
  }

  // ── the target ───────────────────────────────────────────────────────

  /** `git clone <url> <dir>` (the folder must not exist, or be empty). */
  async clone(url: string, dir: string): Promise<void> {
    await mkdir(path.dirname(dir), { recursive: true });
    await this.runRemote(path.dirname(dir), ['clone', '--quiet', '--', url, dir]);
  }

  /** Fetches the temp branch into a private ref and returns its commit. */
  async fetchTemp(repoPath: string, remoteName: string, tempBranch: string, privateRef: string): Promise<string> {
    await this.runRemote(repoPath, ['fetch', '--quiet', remoteName, `+refs/heads/${tempBranch}:${privateRef}`]);
    const sha = await this.sha(repoPath, privateRef);
    if (sha === null) throw new TakeoverGitError(`the temporary branch ${tempBranch} did not arrive from ${remoteName}`);
    return sha;
  }

  /** The repo's worktrees (`git worktree list --porcelain`, the main checkout first); `null` when git cannot list them. */
  async worktreeEntries(repoPath: string): Promise<WorktreeEntry[] | null> {
    const listed = await this.try(repoPath, ['worktree', 'list', '--porcelain']);
    return listed.ok ? parseWorktreeList(listed.out) : null;
  }

  /**
   * The branches checked out in any worktree of the repo, branch → path (for the
   * plan). A stale entry whose folder is gone is left out: the restore removes that
   * entry before it checks the branch out ({@link clearWorktreeSlot}).
   */
  async checkedOutBranches(repoPath: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const entry of (await this.worktreeEntries(repoPath)) ?? []) {
      if (!entry.branch || (await isStaleGone(entry))) continue;
      map.set(entry.branch, entry.path);
    }
    return map;
  }

  /**
   * What is at `worktreePath`, where the restore will create a worktree of the repo
   * at `repoPath` (`null`: a repo the restore will clone, so it has no worktrees yet).
   * Read-only. Whether the path is a worktree is read from `git worktree list`
   * (paths compared by {@link comparablePath}: Windows' `D:/x` and `d:\X`), never
   * from a folder's name or a `.git` file.
   */
  async worktreeSlot(repoPath: string | null, worktreePath: string): Promise<WorktreeSlot> {
    const entries = repoPath === null ? [] : await this.worktreeEntries(repoPath);
    const wanted = await comparablePath(worktreePath);
    let registered: WorktreeEntry | null = null;
    for (const entry of entries ?? []) if ((await comparablePath(entry.path)) === wanted) registered = entry;
    if (registered !== null && (registered.locked || !registered.prunable)) return { kind: 'worktree', branch: registered.branch, locked: registered.locked };
    let facts: Awaited<ReturnType<typeof lstat>>;
    try {
      facts = await lstat(worktreePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return registered !== null ? { kind: 'stale-entry' } : { kind: 'free' };
      return { kind: 'unreadable', error: error instanceof Error ? error.message : String(error) };
    }
    if (!facts.isDirectory()) return { kind: 'file' };
    const inside = await readdir(worktreePath).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    if (inside instanceof Error) return { kind: 'unreadable', error: inside.message };
    if (inside.length > 0) return { kind: 'folder' };
    return registered !== null ? { kind: 'stale-entry' } : { kind: 'empty-folder' };
  }

  /**
   * Before the restore creates the worktree at `worktreePath` (`null` for a main
   * checkout) or checks `branch` out (`docs/peers.md` → *A worktree folder in the
   * way*): an **empty** folder at the path is removed (`rmdir`, which fails on
   * anything else), then each stale entry that is in the way (git still lists it
   * there or on that branch, its folder is gone, it is not locked) is removed with
   * `git worktree remove <its path>`, that entry only and without `--force`, so git
   * itself refuses if the folder came back with files. Never `git worktree prune`
   * (it would drop other worktrees' entries too: `docs/cleanup.md`). Returns what it did.
   */
  async clearWorktreeSlot(repoPath: string, worktreePath: string | null, branch: string): Promise<{ readonly removedEntries: readonly string[]; readonly removedEmptyFolder: boolean }> {
    let removedEmptyFolder = false;
    if (worktreePath !== null) {
      const inside = await readdir(worktreePath).catch(() => null);
      if (inside !== null && inside.length === 0) {
        await rmdir(worktreePath);
        this.#log(`removed the empty folder ${worktreePath}`);
        removedEmptyFolder = true;
      }
    }
    const wanted = worktreePath === null ? null : await comparablePath(worktreePath);
    const removedEntries: string[] = [];
    for (const entry of (await this.worktreeEntries(repoPath)) ?? []) {
      if (!(await isStaleGone(entry))) continue;
      if (entry.branch !== branch && (wanted === null || (await comparablePath(entry.path)) !== wanted)) continue;
      await this.run(repoPath, ['worktree', 'remove', entry.path]);
      removedEntries.push(entry.path);
    }
    return { removedEntries, removedEmptyFolder };
  }

  /**
   * Undoes a worktree the take-over planned at `worktreePath` (the target's undo,
   * `docs/peers.md` → *Rollback*). `made`: this restore's `git worktree add`
   * succeeded, so the worktree holds only the restored work and is removed with
   * `git worktree remove --force`. Anything else is never forced: a worktree this
   * restore did not make is left as it is; a stale entry at the path (its folder
   * gone) is removed with `git worktree remove <path>`, that entry only and never
   * `git worktree prune` (developer 2026-10-28: prune would drop other worktrees'
   * entries too); a path that is not a worktree was never made, so there is nothing
   * to undo, except an **empty** folder a half-made `worktree add` may have left,
   * which is removed. A non-empty folder that is not a worktree is never deleted:
   * it is reported as a leftover. Whether the path is a worktree is read from
   * `git worktree list`, not from git's possibly translated messages.
   */
  async removePlannedWorktree(repoPath: string, worktreePath: string, made: boolean): Promise<{ readonly outcome: 'removed' | 'not-created' | 'removed-empty-folder' } | { readonly outcome: 'left'; readonly note: string }> {
    let forced: string | null = null;
    if (made) {
      const removal = await this.try(repoPath, ['worktree', 'remove', '--force', worktreePath]);
      if (removal.ok) return { outcome: 'removed' };
      forced = removal.error;
    }
    const wanted = await comparablePath(worktreePath);
    // A repo that is not there (its clone failed) has no worktrees at all.
    const entries = (await this.worktreeEntries(repoPath)) ?? ((await pathExists(repoPath)) ? null : []);
    if (entries === null) return { outcome: 'left', note: `could not remove the worktree ${worktreePath}: git could not list the worktrees of ${repoPath}${forced ? ` (git worktree remove --force failed: ${forced})` : ''}` };
    let registered: WorktreeEntry | null = null;
    for (const entry of entries) if ((await comparablePath(entry.path)) === wanted) registered = entry;
    if (registered !== null) {
      if (!(await isStaleGone(registered))) {
        return {
          outcome: 'left',
          note: forced !== null ? `could not remove the worktree ${worktreePath}: git worktree remove --force failed: ${forced}` : `${worktreePath} was left as it is: it is a worktree of ${repoPath} this move did not make`,
        };
      }
      // Its folder is gone: only git's entry is left; that one entry goes (no --force, no prune).
      const stale = await this.try(repoPath, ['worktree', 'remove', registered.path]);
      if (!stale.ok) return { outcome: 'left', note: `could not remove git's entry of the worktree ${worktreePath}: ${stale.error}` };
      return made ? { outcome: 'removed' } : { outcome: 'not-created' };
    }
    // Not a worktree: nothing to undo, except an empty folder a half-made `worktree add` left; anything else is left alone.
    const inside = await readdir(worktreePath).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : error));
    if (inside === null) return made ? { outcome: 'removed' } : { outcome: 'not-created' };
    if (inside instanceof Error) return { outcome: 'left', note: `${worktreePath} was left behind: it is not a worktree of ${repoPath} and could not be read (${inside.message})` };
    if (inside.length > 0) return { outcome: 'left', note: `${worktreePath} was left behind: it is not a worktree of ${repoPath} and is not empty, so it was not deleted` };
    try {
      await rmdir(worktreePath);
      return { outcome: 'removed-empty-folder' };
    } catch (error) {
      return { outcome: 'left', note: `${worktreePath} was left behind (an empty folder): ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** `true` when `ancestor` is an ancestor of (or equal to) `descendant`. */
  async isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
    return (await this.try(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant])).ok;
  }

  // ── D153: the agent's own worktrees (source) ─────────────────────────

  /**
   * What decides whether one of the agent's own worktrees is carried (read-only, no
   * network: what this machine last fetched): its branch, its upstream when one is
   * configured **and** that remote-tracking branch exists, and what it is merged
   * into. "Merged" follows D145's auto-clean: the branch's tip is contained in a
   * base, here the upstream remote's default branch (`<remote>/HEAD`, else
   * `<remote>/main` / `master`) and the worktree's recorded base with its
   * remote-tracking copy; or its pull request was seen merged (`prState`). The
   * upstream itself is never a base (a pushed branch is always in its own upstream).
   */
  async worktreeCarryFacts(dir: string, input: { readonly baseRef: string | null; readonly prState: string | null }): Promise<WorktreeCarryFacts & { readonly uncommitted: number }> {
    const branch = await this.currentBranch(dir);
    const uncommitted = (await this.dirtyCounts(dir)).total;
    if (branch === null) return { branch, upstream: null, mergedInto: null, uncommitted };
    const full = await this.try(dir, ['rev-parse', '--symbolic-full-name', `${branch}@{upstream}`]);
    const upstreamRef = full.ok && full.out.startsWith('refs/remotes/') ? full.out : null;
    const upstream = upstreamRef !== null && (await this.sha(dir, upstreamRef)) !== null ? upstreamRef.slice('refs/remotes/'.length) : null;
    if (upstream === null) return { branch, upstream: null, mergedInto: null, uncommitted };
    if (input.prState === 'MERGED') return { branch, upstream, mergedInto: 'its pull request (merged)', uncommitted };
    const head = await this.sha(dir, 'HEAD');
    const remote = (await this.try(dir, ['config', '--get', `branch.${branch}.remote`])).out || (upstream.split('/')[0] as string);
    const bases: string[] = [];
    const add = (ref: string): void => {
      if (ref !== '' && ref !== upstream && !bases.includes(ref)) bases.push(ref);
    };
    const remoteHead = await this.try(dir, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
    if (remoteHead.ok && remoteHead.out !== '') add(remoteHead.out);
    else for (const name of ['main', 'master']) if ((await this.sha(dir, `refs/remotes/${remote}/${name}`)) !== null) add(`${remote}/${name}`);
    if (input.baseRef) {
      add(input.baseRef);
      if (!input.baseRef.includes('/')) add(`${remote}/${input.baseRef}`);
    }
    let mergedInto: string | null = null;
    if (head !== null) {
      for (const base of bases) {
        const tip = await this.sha(dir, base);
        if (tip !== null && (await this.isAncestor(dir, head, tip))) {
          mergedInto = base;
          break;
        }
      }
    }
    return { branch, upstream, mergedInto, uncommitted };
  }

  // ── D153: a target checkout with uncommitted changes ─────────────────

  /** The checkout's uncommitted changes: names (at most {@link TARGET_CHANGES_LISTED}) and counts (untracked included, ignored not). */
  async targetChanges(dir: string): Promise<TargetChanges> {
    const out = await this.raw(dir, ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const files: string[] = [];
    let modified = 0;
    let untracked = 0;
    const entries = (out ?? '').split('\0');
    for (let at = 0; at < entries.length; at++) {
      const entry = entries[at] as string;
      if (entry === '') continue;
      if (!/^[ MADRCU?!]{2} /.test(entry)) continue;
      const status = entry.slice(0, 2);
      if (status === '??') untracked += 1;
      else modified += 1;
      // A rename / copy carries the old name in the next field.
      if (status[0] === 'R' || status[0] === 'C') at++;
      if (files.length < TARGET_CHANGES_LISTED) files.push(entry.slice(3));
    }
    const total = modified + untracked;
    return { files, modified, untracked, total, truncated: total > files.length };
  }

  // ── D157: a target branch with commits the source does not have ──────

  /**
   * The commits of `localTip` that `base` does not contain (newest first, at most
   * {@link DIVERGED_LISTED} listed, all counted); `null` when there are none or git
   * cannot tell. Read-only.
   */
  async divergedCommits(dir: string, branch: string, localTip: string, base: string): Promise<TargetDiverged | null> {
    const counted = await this.try(dir, ['rev-list', '--count', localTip, `^${base}`]);
    const count = counted.ok ? Number.parseInt(counted.out, 10) : Number.NaN;
    if (!Number.isFinite(count) || count <= 0) return null;
    const listed = await this.try(dir, ['-c', 'core.quotePath=false', 'log', '--no-color', `--max-count=${DIVERGED_LISTED}`, '--format=%h%x1f%s', localTip, `^${base}`]);
    const commits = (listed.ok ? listed.out.split('\n') : [])
      .filter((line) => line.includes('\x1f'))
      .map((line) => {
        const [sha = '', subject = ''] = line.split('\x1f');
        return { sha: sha.trim(), subject: cleanSubject(subject) };
      });
    return { branch, count, commits, truncated: count > commits.length };
  }

  /**
   * D157: a new branch at `tip` that keeps the commits an overwrite replaces:
   * `switchboard/backup/<branch>-<YYYYMMDD-HHMM>` (`-2`, `-3`… when taken). Made with
   * `git update-ref <ref> <tip> ""`, which refuses a ref that exists, so it never
   * overwrites anything. Never pushed. Returns the branch name.
   */
  async createBackupBranch(dir: string, branch: string, tip: string, at: Date): Promise<string> {
    let last = '';
    for (let attempt = 1; attempt <= 20; attempt++) {
      const name = backupBranchName(branch, at, attempt);
      if ((await this.sha(dir, `refs/heads/${name}`)) !== null) continue;
      const made = await this.try(dir, ['update-ref', '-m', 'switchboard: backup before a move overwrote the branch', `refs/heads/${name}`, tip, '']);
      if (made.ok) return name;
      last = made.error;
    }
    throw new TakeoverGitError(`could not create a backup branch for ${branch} in ${dir}${last ? `: ${last}` : ''}`);
  }

  /**
   * D153: `git stash push --include-untracked -m <message>` in a target checkout,
   * after the developer confirmed it (never otherwise). Non-interactive (the
   * take-over's env), with Switchboard's identity only when the checkout has none
   * (a stash is a commit). Afterwards the tree must be clean; the stash is never
   * dropped or popped here. Returns the stash commit.
   */
  async stashPush(dir: string, message: string): Promise<string | null> {
    const email = await this.try(dir, ['config', '--get', 'user.email']);
    const name = await this.try(dir, ['config', '--get', 'user.name']);
    const identity = email.ok && email.out !== '' && name.ok && name.out !== '' ? {} : WIP_IDENTITY;
    const env = { ...(await this.#remoteEnv(dir)), ...identity, GIT_EDITOR: 'true' };
    const result = await this.try(dir, ['stash', 'push', '--include-untracked', '-m', message], env);
    if (!result.ok) throw new TakeoverGitError(`git stash push failed in ${dir}: ${(result.stderr && gitErrorSummary(result.stderr)) || result.error}`);
    const left = await this.dirtyCounts(dir);
    if (left.total > 0) throw new TakeoverGitError(`git stash push left ${left.total} uncommitted file${left.total === 1 ? '' : 's'} in ${dir}`);
    return this.sha(dir, 'refs/stash');
  }
}


/** Arguments for the log: a URL's credentials never appear. */
function redactArgs(args: readonly string[]): string[] {
  return args.map((arg) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg) ? redactUrl(arg) : arg));
}

/**
 * A path in a form two spellings of one folder share: links resolved when it exists
 * (macOS' `/var` → `/private/var`), absolute; on Windows forward slashes and lower
 * case (git lists `D:/code/x`, a plan may say `D:\\Code\\x`).
 */
export async function comparablePath(target: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  // A path that is gone (a stale worktree entry) still gets its parent's links resolved: git lists `/private/var/…`.
  const resolved = await realpath(target).catch(() =>
    realpath(path.dirname(path.resolve(target)))
      .then((parent) => path.join(parent, path.basename(target)))
      .catch(() => path.resolve(target)),
  );
  return comparablePathText(resolved, platform);
}

/** {@link comparablePath} without the file system: the text only. */
export function comparablePathText(target: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return target.replace(/\/+$/, '') || '/';
  return target.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** A stale worktree entry the restore may remove: prunable, not locked, and its folder is gone. */
async function isStaleGone(entry: WorktreeEntry): Promise<boolean> {
  if (!entry.prunable || entry.locked) return false;
  return lstat(entry.path).then(
    () => false,
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
  );
}

/** `true` when `target` exists (file or folder). */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
