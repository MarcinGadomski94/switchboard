import { createHash } from 'node:crypto';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ReviewBaseSource, ReviewCommit, ReviewFile, ReviewMode } from '../../core/reviews.ts';
import { splitNulList } from '../../core/worktrees.ts';
import { type RunResult, failureText, runCommand, succeeded } from '../exec.ts';

/**
 * D79 (`docs/reviews.md`): the git and gh work behind review cards: reading a
 * repository's change set (files, stats, commits, a fingerprint) and the card's
 * actions (Merge locally, Commit, Discard, Clean up, Open PR). Every command is an
 * argv (`shell: false`); nothing here ever pushes except Open PR's explicit push of
 * the session's own branch, and nothing is ever forced (`--force`, `push -f`).
 */

/** Why an action was refused. `status` is the HTTP status the route answers. */
export type ReviewGitErrorCode = 'conflicts' | 'uncommitted' | 'base-missing' | 'base-dirty' | 'no-branch' | 'no-remote' | 'not-merged' | 'gone' | 'git-failed' | 'gh-failed';

/** A refused git / gh step. */
export class ReviewGitError extends Error {
  override name = 'ReviewGitError';
  readonly code: ReviewGitErrorCode;
  /** Conflicting files (`conflicts`). */
  readonly conflicts: readonly string[];
  constructor(code: ReviewGitErrorCode, message: string, conflicts: readonly string[] = []) {
    super(message);
    this.code = code;
    this.conflicts = conflicts;
  }
}

/** One repository a review covers. */
export interface ReviewTarget {
  readonly repo: string;
  /** The worktree (`branch` mode) or the folder's checkout (`folder` mode). */
  readonly dir: string;
  readonly mode: ReviewMode;
  /** `branch` mode: the worktree row's id, its main checkout and its recorded base (`worktrees.base_ref`). */
  readonly worktreeId: string | null;
  readonly repoPath: string;
  readonly baseRef: string | null;
}

/** A branch session's base as found now. */
export interface ResolvedBase {
  /** The local branch it merges into. */
  readonly branch: string;
  /** The commit it is at: the local branch's tip, else `origin/<branch>`'s (the local branch is then created by Merge). */
  readonly tip: string;
  /** `true` when `refs/heads/<branch>` exists. */
  readonly local: boolean;
  readonly source: Exclude<ReviewBaseSource, null>;
}

/** A repository's change set as read now. */
export interface RepoReading {
  readonly target: ReviewTarget;
  readonly head: string;
  readonly branch: string | null;
  readonly base: ResolvedBase | null;
  /** `folder` mode: the branch's upstream (shown as the base), else `null`. */
  readonly upstream: string | null;
  readonly files: ReviewFile[];
  readonly added: number;
  readonly removed: number;
  readonly uncommitted: number;
  readonly commits: ReviewCommit[];
  /** This repo's part of the review's fingerprint. */
  readonly fingerprint: string;
}

/** Most commits a card lists per repo. */
export const MAX_COMMITS = 50;

/** Untracked files larger than this count as binary (not read). */
const UNTRACKED_READ_LIMIT = 1024 * 1024;

/** Most untracked files whose content goes into the fingerprint. */
const FINGERPRINT_UNTRACKED_MAX = 500;

/** Options of {@link ReviewGit}. */
export interface ReviewGitOptions {
  readonly git?: readonly string[];
  readonly gh: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** The git / gh steps of review cards. */
export class ReviewGit {
  readonly #git: readonly string[];
  readonly #gh: readonly string[];
  readonly #env: NodeJS.ProcessEnv;
  readonly #timeout: number;

  constructor(options: ReviewGitOptions) {
    this.#git = options.git ?? ['git'];
    this.#gh = options.gh;
    this.#env = options.env ?? process.env;
    this.#timeout = options.timeoutMs ?? 120_000;
  }

  // ── reading ───────────────────────────────────────────────────────────

  /**
   * Reads `target`'s change set, or `null` when it cannot be read (the folder is gone,
   * not a repository, or has no commit). `since` (`folder` mode): the session's start;
   * its commits are those made since then that are on no remote.
   */
  async read(target: ReviewTarget, since: string | null): Promise<RepoReading | null> {
    if (!(await isDirectory(target.dir))) return null;
    const headResult = await this.#run(target.dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    const head = headResult.stdout.trim();
    if (!succeeded(headResult) || head === '') return null;
    const branch = await this.#branchOf(target.dir);
    const base = target.mode === 'branch' && branch !== null ? await this.resolveBase(target, branch) : null;
    const upstream = target.mode === 'folder' && branch !== null ? await this.#upstreamOf(target.dir) : null;
    const commits = target.mode === 'branch' ? (base ? await this.#commitsNotIn(target.dir, base.tip) : []) : await this.#commitsSince(target.dir, since);
    // The diff's starting point: the merge-base with the base (branch), the commit before the oldest listed one (folder), else HEAD.
    let from = head;
    if (target.mode === 'branch' && base) {
      const mergeBase = await this.#run(target.dir, ['merge-base', base.tip, 'HEAD']);
      if (succeeded(mergeBase) && mergeBase.stdout.trim() !== '') from = mergeBase.stdout.trim();
    } else if (target.mode === 'folder' && commits.length > 0) {
      const oldest = commits[commits.length - 1] as ReviewCommit;
      const parent = await this.#run(target.dir, ['rev-parse', '--verify', '--quiet', `${oldest.sha}^{commit}^`]);
      from = succeeded(parent) && parent.stdout.trim() !== '' ? parent.stdout.trim() : EMPTY_TREE;
    }
    const numstat = await this.#run(target.dir, ['-c', 'core.quotePath=false', 'diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', from, '--']);
    if (!succeeded(numstat)) throw new ReviewGitError('git-failed', `git diff failed in ${target.dir}: ${failureText(numstat)}`);
    const dirty = await this.#run(target.dir, ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-renames', 'HEAD', '--']);
    const dirtySet = new Set(succeeded(dirty) ? splitNulList(dirty.stdout) : []);
    const untrackedResult = await this.#run(target.dir, ['ls-files', '--others', '--exclude-standard', '-z']);
    const untracked = succeeded(untrackedResult) ? splitNulList(untrackedResult.stdout) : [];
    const files: ReviewFile[] = parseNumstat(numstat.stdout).map((entry) => ({ repo: target.repo, ...entry, uncommitted: dirtySet.has(entry.path) }));
    for (const relative of untracked) files.push({ repo: target.repo, ...(await countUntracked(target.dir, relative)), uncommitted: true });
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const uncommitted = files.filter((file) => file.uncommitted).length;
    const fingerprint = await this.#fingerprint(target, head, untracked);
    return {
      target,
      head,
      branch,
      base,
      upstream,
      files,
      added: files.reduce((sum, file) => sum + file.added, 0),
      removed: files.reduce((sum, file) => sum + file.removed, 0),
      uncommitted,
      commits,
      fingerprint,
    };
  }

  /**
   * A branch session's base (`docs/reviews.md` → *Base*): from the worktree's recorded
   * base (`base_ref`, what it was created from): `origin/<b>` → the local branch `<b>`
   * (at `origin/<b>` while it has none); a local branch name → itself; nothing recorded →
   * the repo's default branch (`origin/HEAD`), else the branch its main checkout is on.
   * `null` when none resolves (a worktree cut from a detached commit).
   */
  async resolveBase(target: Pick<ReviewTarget, 'dir' | 'repoPath' | 'baseRef'>, branch: string): Promise<ResolvedBase | null> {
    const recorded = target.baseRef;
    let name: string | null = null;
    let source: ResolvedBase['source'] = 'local';
    if (recorded) {
      if (recorded.startsWith('origin/') && (await this.#sha(target.dir, `refs/remotes/${recorded}`))) {
        name = recorded.slice('origin/'.length);
        source = 'origin';
      } else if (await this.#sha(target.dir, `refs/heads/${recorded}`)) {
        name = recorded;
        source = 'local';
      }
    } else {
      const symbolic = await this.#run(target.dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
      const ref = symbolic.stdout.trim();
      if (succeeded(symbolic) && ref.startsWith('origin/')) name = ref.slice('origin/'.length);
      else name = await this.#branchOf(target.repoPath);
      source = 'default';
    }
    if (name === null || name === branch) return null;
    const localTip = await this.#sha(target.dir, `refs/heads/${name}`);
    if (localTip) return { branch: name, tip: localTip, local: true, source };
    const originTip = await this.#sha(target.dir, `refs/remotes/origin/${name}`);
    return originTip ? { branch: name, tip: originTip, local: false, source } : null;
  }

  // ── actions ───────────────────────────────────────────────────────────

  /**
   * Checks that `reading`'s branch merges into its base without conflicts (no
   * working tree touched: `git merge-tree --write-tree`). Refused with the
   * conflicting files, with uncommitted changes in the worktree (they would not be
   * merged), without a base or branch, or when the base is checked out somewhere
   * with uncommitted changes.
   */
  async checkMerge(reading: RepoReading): Promise<MergePlan> {
    const { target } = reading;
    if (reading.branch === null) throw new ReviewGitError('no-branch', `${target.repo}: the worktree is not on a branch`);
    if (reading.base === null) throw new ReviewGitError('base-missing', `${target.repo}: no base branch to merge ${reading.branch} into (the worktree was not cut from a branch)`);
    if (reading.uncommitted > 0) {
      throw new ReviewGitError('uncommitted', `${target.repo}: ${reading.uncommitted} file${reading.uncommitted === 1 ? ' has' : 's have'} uncommitted changes in the worktree; they would not be merged. Send it back to commit them, or commit them yourself.`);
    }
    const base = reading.base;
    const checkedOutAt = await this.#checkedOutAt(target.repoPath, base.branch);
    if (checkedOutAt !== null) {
      const status = await this.#run(checkedOutAt, ['status', '--porcelain=v1', '--untracked-files=no']);
      if (!succeeded(status)) throw new ReviewGitError('git-failed', `git status failed in ${checkedOutAt}: ${failureText(status)}`);
      if (status.stdout.trim() !== '') throw new ReviewGitError('base-dirty', `${base.branch} is checked out at ${checkedOutAt} with uncommitted changes; commit or stash them there first`);
    }
    // Already in the base: nothing to merge.
    if (await this.#isAncestor(target.dir, reading.head, base.tip)) return { reading, base, checkedOutAt, kind: 'up-to-date', tree: null };
    if (await this.#isAncestor(target.dir, base.tip, reading.head)) return { reading, base, checkedOutAt, kind: 'fast-forward', tree: null };
    const tree = await this.#run(target.dir, ['merge-tree', '--write-tree', '--name-only', '--no-messages', base.tip, reading.head]);
    if (tree.code === 1) {
      const lines = tree.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      throw new ReviewGitError('conflicts', `${target.repo}: ${reading.branch} conflicts with ${base.branch}`, lines.slice(1));
    }
    if (!succeeded(tree)) throw new ReviewGitError('git-failed', `git merge-tree failed in ${target.dir}: ${failureText(tree)}`);
    return { reading, base, checkedOutAt, kind: 'merge', tree: tree.stdout.split('\n')[0]?.trim() ?? null };
  }

  /**
   * Merges a checked plan locally: in the checkout the base is on (`git merge
   * --no-edit`, hooks run), else by moving the base ref (a fast-forward, or a merge
   * commit made from the conflict-free tree). Never pushes. Returns a one-line note.
   */
  async merge(plan: MergePlan): Promise<string> {
    const { reading, base } = plan;
    const branch = reading.branch as string;
    const { target } = reading;
    if (plan.kind === 'up-to-date') return `${target.repo}: ${branch} is already in ${base.branch}`;
    if (plan.checkedOutAt !== null) {
      const merged = await this.#run(plan.checkedOutAt, ['merge', '--no-edit', '--no-stat', branch]);
      if (!succeeded(merged)) {
        const unmerged = await this.#run(plan.checkedOutAt, ['diff', '--name-only', '--diff-filter=U']);
        await this.#run(plan.checkedOutAt, ['merge', '--abort']);
        const conflicts = succeeded(unmerged) ? unmerged.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : [];
        if (conflicts.length > 0) throw new ReviewGitError('conflicts', `${target.repo}: ${branch} conflicts with ${base.branch}`, conflicts);
        throw new ReviewGitError('git-failed', `git merge failed in ${plan.checkedOutAt}: ${failureText(merged)}`);
      }
      return `${target.repo}: merged ${branch} into ${base.branch} (in ${plan.checkedOutAt})`;
    }
    const ref = `refs/heads/${base.branch}`;
    // `update-ref <ref> <new> <old>` only moves the ref while it is still at <old> (an empty old = it must not exist yet).
    const old = base.local ? base.tip : '';
    if (plan.kind === 'fast-forward') {
      await this.#updateRef(target.dir, ref, reading.head, old);
      return `${target.repo}: fast-forwarded ${base.branch} to ${branch}`;
    }
    if (plan.tree === null) throw new ReviewGitError('git-failed', `${target.repo}: git merge-tree wrote no tree`);
    const commit = await this.#run(target.dir, ['commit-tree', plan.tree, '-p', base.tip, '-p', reading.head, '-m', `Merge branch '${branch}' into ${base.branch}`]);
    if (!succeeded(commit) || commit.stdout.trim() === '') throw new ReviewGitError('git-failed', `git commit-tree failed in ${target.dir}: ${failureText(commit)}`);
    await this.#updateRef(target.dir, ref, commit.stdout.trim(), old);
    return `${target.repo}: merged ${branch} into ${base.branch}`;
  }

  /** Commits every current change of a folder repo (`git add -A`, then `git commit`; hooks run). Never pushes. */
  async commitAll(dir: string, message: string): Promise<string> {
    const added = await this.#run(dir, ['add', '-A', '--', '.']);
    if (!succeeded(added)) throw new ReviewGitError('git-failed', `git add failed in ${dir}: ${failureText(added)}`);
    const committed = await this.#run(dir, ['commit', '-q', '-m', message]);
    if (!succeeded(committed)) throw new ReviewGitError('git-failed', `git commit failed in ${dir}: ${failureText(committed)}`);
    const head = await this.#run(dir, ['rev-parse', '--short', 'HEAD']);
    return head.stdout.trim();
  }

  /**
   * Discards a folder repo's uncommitted changes to `files` (the card's files):
   * tracked ones are restored from HEAD (index and working tree), new ones deleted.
   */
  async discardFolder(dir: string, files: readonly ReviewFile[]): Promise<void> {
    const tracked: string[] = [];
    const created: string[] = [];
    for (const file of files) {
      if (!file.uncommitted) continue;
      const known = await this.#run(dir, ['cat-file', '-e', `HEAD:${file.path}`]);
      (known.code === 0 ? tracked : created).push(file.path);
    }
    if (tracked.length > 0) {
      const restored = await this.#run(dir, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked.map((file) => `:(literal)${file}`)]);
      if (!succeeded(restored)) throw new ReviewGitError('git-failed', `git restore failed in ${dir}: ${failureText(restored)}`);
    }
    if (created.length > 0) {
      // New files: out of the index first (when staged), then deleted.
      await this.#run(dir, ['rm', '-q', '--cached', '--ignore-unmatch', '--', ...created.map((file) => `:(literal)${file}`)]);
      const cleaned = await this.#run(dir, ['clean', '-q', '-f', '--', ...created.map((file) => `:(literal)${file}`)]);
      if (!succeeded(cleaned)) throw new ReviewGitError('git-failed', `git clean failed in ${dir}: ${failureText(cleaned)}`);
    }
  }

  /**
   * Discards a branch session's changes: the worktree is reset to its base (its
   * commits and uncommitted changes, new files included, are dropped; ignored files
   * stay). The branch then points at the base; Clean up deletes it with the worktree.
   */
  async discardBranch(reading: RepoReading): Promise<void> {
    if (reading.base === null) throw new ReviewGitError('base-missing', `${reading.target.repo}: no base branch to reset to`);
    const reset = await this.#run(reading.target.dir, ['reset', '-q', '--hard', reading.base.tip]);
    if (!succeeded(reset)) throw new ReviewGitError('git-failed', `git reset failed in ${reading.target.dir}: ${failureText(reset)}`);
    const cleaned = await this.#run(reading.target.dir, ['clean', '-q', '-f', '-d']);
    if (!succeeded(cleaned)) throw new ReviewGitError('git-failed', `git clean failed in ${reading.target.dir}: ${failureText(cleaned)}`);
  }

  /**
   * Clean up after Merge / Discard: removes the worktree folder (`git worktree remove`,
   * never forced: refused while it holds uncommitted changes) and its local branch
   * (only when it is contained in the base, so nothing is lost).
   */
  async cleanup(target: ReviewTarget, branch: string, baseTip: string | null): Promise<void> {
    if (await isDirectory(target.dir)) {
      const status = await this.#run(target.dir, ['status', '--porcelain=v1', '--untracked-files=all']);
      if (succeeded(status) && status.stdout.trim() !== '') throw new ReviewGitError('uncommitted', `${target.dir} has uncommitted changes again; nothing was removed`);
    }
    const tip = await this.#sha(target.repoPath, `refs/heads/${branch}`);
    if (tip && (baseTip === null || !(await this.#isAncestor(target.repoPath, tip, baseTip)))) {
      throw new ReviewGitError('not-merged', `${branch} has commits that are not in its base; nothing was removed`);
    }
    if (await isDirectory(target.dir)) {
      const removed = await this.#run(target.repoPath, ['worktree', 'remove', target.dir]);
      if (!succeeded(removed)) throw new ReviewGitError('git-failed', `git worktree remove failed: ${failureText(removed)}`);
    } else {
      await this.#run(target.repoPath, ['worktree', 'prune']);
    }
    if (tip) {
      // Contained in the base (checked above), so -D drops nothing; -d would only look at HEAD / the upstream.
      const deleted = await this.#run(target.repoPath, ['branch', '-D', branch]);
      if (!succeeded(deleted)) throw new ReviewGitError('git-failed', `git branch -D ${branch} failed: ${failureText(deleted)}`);
    }
  }

  /**
   * Open PR: pushes the session's branch to `origin` (`git push -u origin <branch>`,
   * never forced) and opens a pull request into the base with gh. An existing PR for
   * the branch is reused. Returns its URL.
   */
  async openPullRequest(reading: RepoReading, title: string, body: string): Promise<string> {
    const { target } = reading;
    const branch = reading.branch;
    if (branch === null) throw new ReviewGitError('no-branch', `${target.repo}: the worktree is not on a branch`);
    if (reading.base === null) throw new ReviewGitError('base-missing', `${target.repo}: no base branch for the pull request`);
    const remote = await this.#run(target.dir, ['remote', 'get-url', 'origin']);
    if (!succeeded(remote)) throw new ReviewGitError('no-remote', `${target.repo} has no origin remote to open a pull request on`);
    const pushed = await this.#run(target.dir, ['push', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
    if (!succeeded(pushed)) throw new ReviewGitError('git-failed', `git push failed in ${target.dir}: ${failureText(pushed)}`);
    const existing = await this.#runGh(target.dir, ['pr', 'view', branch, '--json', 'url,state']);
    if (succeeded(existing)) {
      try {
        const parsed = JSON.parse(existing.stdout) as { url?: unknown; state?: unknown };
        if (typeof parsed.url === 'string' && parsed.state === 'OPEN') return parsed.url;
      } catch {
        // Fall through: create one.
      }
    }
    const created = await this.#runGh(target.dir, ['pr', 'create', '--base', reading.base.branch, '--head', branch, '--title', title, '--body', body]);
    if (!succeeded(created)) throw new ReviewGitError('gh-failed', `gh pr create failed: ${failureText(created)}`);
    const url = created.stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /^https?:\/\//.test(line));
    if (!url) throw new ReviewGitError('gh-failed', `gh pr create printed no URL: ${created.stdout.trim().slice(0, 200)}`);
    return url;
  }

  /** The top folder of the repository `dir` is in (canonical), or `null` outside one. */
  async topLevel(dir: string): Promise<string | null> {
    if (!(await isDirectory(dir))) return null;
    const top = await this.#run(dir, ['rev-parse', '--show-toplevel']);
    const value = top.stdout.trim();
    if (!succeeded(top) || value === '') return null;
    try {
      return await realpath(value);
    } catch {
      return null;
    }
  }

  /** The commit of `ref` in `dir`, or `null`. */
  async tipOf(dir: string, ref: string): Promise<string | null> {
    return this.#sha(dir, ref);
  }

  // ── helpers ───────────────────────────────────────────────────────────

  async #fingerprint(target: ReviewTarget, head: string, untracked: readonly string[]): Promise<string> {
    const hash = createHash('sha256');
    hash.update(`${target.repo}\u0000${target.dir}\u0000${head}\u0000`);
    const diff = await this.#run(target.dir, ['diff', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD', '--']);
    hash.update(diff.stdout);
    const listed = [...untracked].sort().slice(0, FINGERPRINT_UNTRACKED_MAX);
    if (listed.length > 0) {
      const objects = await this.#run(target.dir, ['hash-object', '--', ...listed]);
      hash.update(`\u0000${listed.join('\u0000')}\u0000${objects.stdout}`);
    }
    return hash.digest('hex');
  }

  async #branchOf(dir: string): Promise<string | null> {
    const symbolic = await this.#run(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const name = symbolic.stdout.trim();
    return succeeded(symbolic) && name !== '' ? name : null;
  }

  async #upstreamOf(dir: string): Promise<string | null> {
    const upstream = await this.#run(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    const name = upstream.stdout.trim();
    return succeeded(upstream) && name !== '' ? name : null;
  }

  async #sha(dir: string, ref: string): Promise<string | null> {
    const result = await this.#run(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    const sha = result.stdout.trim();
    return succeeded(result) && sha !== '' ? sha : null;
  }

  async #isAncestor(dir: string, ancestor: string, of: string): Promise<boolean> {
    const result = await this.#run(dir, ['merge-base', '--is-ancestor', ancestor, of]);
    return result.code === 0;
  }

  async #commitsNotIn(dir: string, base: string): Promise<ReviewCommit[]> {
    const log = await this.#run(dir, ['log', `--max-count=${MAX_COMMITS}`, '--format=%H%x1f%s', `${base}..HEAD`, '--']);
    return succeeded(log) ? parseLog(log.stdout) : [];
  }

  async #commitsSince(dir: string, since: string | null): Promise<ReviewCommit[]> {
    if (since === null) return [];
    // Commit times have whole seconds: from a second before the session started (a commit in its first second counts).
    const start = Date.parse(since);
    const from = Number.isFinite(start) ? new Date(Math.floor(start / 1000) * 1000 - 1000).toISOString().replace('.000Z', 'Z') : since;
    const log = await this.#run(dir, ['log', `--max-count=${MAX_COMMITS}`, '--format=%H%x1f%s', `--since=${from}`, 'HEAD', '--not', '--remotes', '--']);
    return succeeded(log) ? parseLog(log.stdout) : [];
  }

  /** The worktree (main checkout included) that has `branch` checked out, or `null`. */
  async #checkedOutAt(repoPath: string, branch: string): Promise<string | null> {
    const list = await this.#run(repoPath, ['worktree', 'list', '--porcelain']);
    if (!succeeded(list)) return null;
    let current: string | null = null;
    for (const line of list.stdout.split('\n')) {
      if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
      else if (line === `branch refs/heads/${branch}` && current !== null) return current;
    }
    return null;
  }

  async #updateRef(dir: string, ref: string, value: string, old: string): Promise<void> {
    const updated = await this.#run(dir, ['update-ref', '-m', 'switchboard: review merge', ref, value, old]);
    if (!succeeded(updated)) throw new ReviewGitError('git-failed', `git update-ref ${ref} failed: ${failureText(updated)}`);
  }

  #run(cwd: string, args: readonly string[]): Promise<RunResult> {
    return runCommand(this.#git, args, { cwd, env: { ...this.#env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, timeoutMs: this.#timeout });
  }

  #runGh(cwd: string, args: readonly string[]): Promise<RunResult> {
    return runCommand(this.#gh, args, { cwd, env: { ...this.#env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' }, timeoutMs: this.#timeout });
  }
}

/** A checked Merge of one repo ({@link ReviewGit.checkMerge}). */
export interface MergePlan {
  readonly reading: RepoReading;
  readonly base: ResolvedBase;
  /** Where the base is checked out (merged there), else `null` (the ref is moved). */
  readonly checkedOutAt: string | null;
  readonly kind: 'up-to-date' | 'fast-forward' | 'merge';
  /** `merge` without a checkout: the conflict-free tree. */
  readonly tree: string | null;
}

/** git's empty tree (the "before" of a repo's first commit). */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** `git diff --numstat -z --no-renames`: `<added>\t<removed>\t<path>\0` per file (`-\t-` for binary). */
export function parseNumstat(text: string): Array<Pick<ReviewFile, 'path' | 'added' | 'removed' | 'binary'>> {
  const out: Array<Pick<ReviewFile, 'path' | 'added' | 'removed' | 'binary'>> = [];
  for (const entry of text.split('\u0000')) {
    if (entry === '') continue;
    const first = entry.indexOf('\t');
    const second = first < 0 ? -1 : entry.indexOf('\t', first + 1);
    if (second < 0) continue;
    const added = entry.slice(0, first);
    const removed = entry.slice(first + 1, second);
    const file = entry.slice(second + 1).replace(/^\n+/, '');
    const binary = added === '-' || removed === '-';
    out.push({ path: file, added: binary ? 0 : Number(added) || 0, removed: binary ? 0 : Number(removed) || 0, binary });
  }
  return out;
}

/** `git log --format=%H%x1f%s`: one commit per line. */
export function parseLog(text: string): ReviewCommit[] {
  return text
    .split('\n')
    .filter((line) => line.includes('\u001f'))
    .map((line) => {
      const [sha, ...rest] = line.split('\u001f');
      return { sha: (sha ?? '').trim(), subject: rest.join('\u001f') };
    });
}

/** An untracked file's line count (all lines added), or binary (a NUL byte, or too large to read). */
async function countUntracked(dir: string, relative: string): Promise<Pick<ReviewFile, 'path' | 'added' | 'removed' | 'binary'>> {
  const absolute = path.join(dir, relative);
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) return { path: relative, added: 1, removed: 0, binary: false };
    if (info.size > UNTRACKED_READ_LIMIT) return { path: relative, added: 0, removed: 0, binary: true };
    const handle = await open(absolute, 'r');
    try {
      const buffer = Buffer.alloc(info.size);
      const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.includes(0)) return { path: relative, added: 0, removed: 0, binary: true };
      const text = bytes.toString('utf8');
      const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      return { path: relative, added: lines, removed: 0, binary: false };
    } finally {
      await handle.close();
    }
  } catch {
    return { path: relative, added: 0, removed: 0, binary: false };
  }
}
