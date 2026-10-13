import { stat } from 'node:fs/promises';
import { type RunResult, failureText, runCommand, succeeded } from '../exec.ts';

/**
 * The safe local merge of a worktree's branch into a target branch, and opening its pull
 * request (D102, `docs/plans.md` → *Merge step*). Moved here from the removed review cards'
 * git adapter (D79's Merge and Open PR, `ReviewGit`) when Plans got its own Merge step.
 *
 * - **Checked first, nothing touched:** refused while the worktree has uncommitted changes
 *   (they would not be merged), when the target is checked out somewhere with uncommitted
 *   tracked changes, and with the conflicting files when `git merge-tree --write-tree` (which
 *   touches no working tree) finds conflicts.
 * - **Local only, never pushed, never forced:** where the target is checked out (usually the
 *   main checkout) `git merge --no-edit <branch>` runs there (hooks run; a failure is aborted);
 *   otherwise the target ref is moved with `git update-ref <ref> <new> <old>` (a fast-forward,
 *   or a merge commit made from the conflict-free tree with `git commit-tree`). Already
 *   contained = nothing to do. A target that exists only as `origin/<target>` is created
 *   locally at that commit.
 * - **Open PR:** `git push -u origin <branch>` (that branch only, never forced), then an open
 *   pull request for the branch is reused or `gh pr create --base <target>` opens one.
 *
 * Every command is an argv (`shell: false`).
 */

/** Why a step was refused. */
export type BranchMergeErrorCode = 'conflicts' | 'uncommitted' | 'target-missing' | 'target-dirty' | 'no-branch' | 'no-remote' | 'git-failed' | 'gh-failed';

/** A refused git / gh step. */
export class BranchMergeError extends Error {
  override name = 'BranchMergeError';
  readonly code: BranchMergeErrorCode;
  /** Conflicting files (`conflicts`). */
  readonly conflicts: readonly string[];
  constructor(code: BranchMergeErrorCode, message: string, conflicts: readonly string[] = []) {
    super(message);
    this.code = code;
    this.conflicts = conflicts;
  }
}

/** One repository of a merge. */
export interface BranchMergeInput {
  /** The repo's name (messages). */
  readonly repo: string;
  /** The worktree the branch is checked out in (its uncommitted changes are looked at); may be gone. */
  readonly dir: string;
  /** The repo's main checkout. */
  readonly repoPath: string;
  /** The branch to merge. */
  readonly branch: string;
  /** The branch it is merged into. */
  readonly target: string;
}

/** A checked merge of one repo ({@link BranchMergeGit.check}). */
export interface BranchMergePlan {
  readonly input: BranchMergeInput;
  /** The branch's tip. */
  readonly head: string;
  /** The target's tip: the local branch's, else `origin/<target>`'s (the local branch is then created). */
  readonly targetTip: string;
  /** `true` when `refs/heads/<target>` exists. */
  readonly targetLocal: boolean;
  /** Where the target is checked out (merged there), else `null` (the ref is moved). */
  readonly checkedOutAt: string | null;
  readonly kind: 'up-to-date' | 'fast-forward' | 'merge';
  /** `merge` without a checkout: the conflict-free tree. */
  readonly tree: string | null;
}

/** Options of {@link BranchMergeGit}. */
export interface BranchMergeGitOptions {
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

/** The git / gh steps of a branch merge (see the module comment). */
export class BranchMergeGit {
  readonly #git: readonly string[];
  readonly #gh: readonly string[];
  readonly #env: NodeJS.ProcessEnv;
  readonly #timeout: number;

  constructor(options: BranchMergeGitOptions) {
    this.#git = options.git ?? ['git'];
    this.#gh = options.gh;
    this.#env = options.env ?? process.env;
    this.#timeout = options.timeoutMs ?? 120_000;
  }

  /**
   * Checks that `input.branch` merges into `input.target` (nothing is touched). Refused with
   * `no-branch` (the branch is gone), `target-missing`, `uncommitted` (the worktree has
   * uncommitted changes), `target-dirty` (the target's checkout has uncommitted tracked
   * changes) or `conflicts` with the files.
   */
  async check(input: BranchMergeInput): Promise<BranchMergePlan> {
    const head = await this.#sha(input.repoPath, `refs/heads/${input.branch}`);
    if (head === null) throw new BranchMergeError('no-branch', `${input.repo}: the branch ${input.branch} does not exist`);
    let targetTip = await this.#sha(input.repoPath, `refs/heads/${input.target}`);
    const targetLocal = targetTip !== null;
    targetTip ??= await this.#sha(input.repoPath, `refs/remotes/origin/${input.target}`);
    if (targetTip === null) throw new BranchMergeError('target-missing', `${input.repo}: the target branch ${input.target} does not exist`);
    if (await isDirectory(input.dir)) {
      const status = await this.#run(input.dir, ['status', '--porcelain=v1', '--untracked-files=all']);
      if (!succeeded(status)) throw new BranchMergeError('git-failed', `git status failed in ${input.dir}: ${failureText(status)}`);
      const dirty = status.stdout.split('\n').filter((line) => line.trim() !== '').length;
      if (dirty > 0) {
        throw new BranchMergeError('uncommitted', `${input.repo}: ${dirty} file${dirty === 1 ? ' has' : 's have'} uncommitted changes in the worktree; they would not be merged. Send it back to commit them, or commit them yourself.`);
      }
    }
    const checkedOutAt = targetLocal ? await this.#checkedOutAt(input.repoPath, input.target) : null;
    if (checkedOutAt !== null) {
      const status = await this.#run(checkedOutAt, ['status', '--porcelain=v1', '--untracked-files=no']);
      if (!succeeded(status)) throw new BranchMergeError('git-failed', `git status failed in ${checkedOutAt}: ${failureText(status)}`);
      if (status.stdout.trim() !== '') throw new BranchMergeError('target-dirty', `${input.target} is checked out at ${checkedOutAt} with uncommitted changes; commit or stash them there first`);
    }
    const base = { input, head, targetTip, targetLocal, checkedOutAt };
    if (await this.#isAncestor(input.repoPath, head, targetTip)) return { ...base, kind: 'up-to-date', tree: null };
    if (await this.#isAncestor(input.repoPath, targetTip, head)) return { ...base, kind: 'fast-forward', tree: null };
    const tree = await this.#run(input.repoPath, ['merge-tree', '--write-tree', '--name-only', '--no-messages', targetTip, head]);
    if (tree.code === 1) {
      const lines = tree.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      throw new BranchMergeError('conflicts', `${input.repo}: ${input.branch} conflicts with ${input.target}`, lines.slice(1));
    }
    if (!succeeded(tree)) throw new BranchMergeError('git-failed', `git merge-tree failed in ${input.repoPath}: ${failureText(tree)}`);
    return { ...base, kind: 'merge', tree: tree.stdout.split('\n')[0]?.trim() ?? null };
  }

  /**
   * Merges a checked plan locally: in the checkout the target is on (`git merge --no-edit`,
   * hooks run), else by moving the target ref (a fast-forward, or a merge commit made from the
   * conflict-free tree). Never pushes. Returns a one-line note.
   */
  async merge(plan: BranchMergePlan): Promise<string> {
    const { input } = plan;
    if (plan.kind === 'up-to-date') return `${input.repo}: ${input.branch} is already in ${input.target}`;
    if (plan.checkedOutAt !== null) {
      const merged = await this.#run(plan.checkedOutAt, ['merge', '--no-edit', '--no-stat', input.branch]);
      if (!succeeded(merged)) {
        const unmerged = await this.#run(plan.checkedOutAt, ['diff', '--name-only', '--diff-filter=U']);
        await this.#run(plan.checkedOutAt, ['merge', '--abort']);
        const conflicts = succeeded(unmerged) ? unmerged.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : [];
        if (conflicts.length > 0) throw new BranchMergeError('conflicts', `${input.repo}: ${input.branch} conflicts with ${input.target}`, conflicts);
        throw new BranchMergeError('git-failed', `git merge failed in ${plan.checkedOutAt}: ${failureText(merged)}`);
      }
      return `${input.repo}: merged ${input.branch} into ${input.target} (in ${plan.checkedOutAt})`;
    }
    const ref = `refs/heads/${input.target}`;
    // `update-ref <ref> <new> <old>` only moves the ref while it is still at <old> (an empty old = it must not exist yet).
    const old = plan.targetLocal ? plan.targetTip : '';
    if (plan.kind === 'fast-forward') {
      await this.#updateRef(input.repoPath, ref, plan.head, old);
      return `${input.repo}: fast-forwarded ${input.target} to ${input.branch}`;
    }
    if (plan.tree === null) throw new BranchMergeError('git-failed', `${input.repo}: git merge-tree wrote no tree`);
    const commit = await this.#run(input.repoPath, ['commit-tree', plan.tree, '-p', plan.targetTip, '-p', plan.head, '-m', `Merge branch '${input.branch}' into ${input.target}`]);
    if (!succeeded(commit) || commit.stdout.trim() === '') throw new BranchMergeError('git-failed', `git commit-tree failed in ${input.repoPath}: ${failureText(commit)}`);
    await this.#updateRef(input.repoPath, ref, commit.stdout.trim(), old);
    return `${input.repo}: merged ${input.branch} into ${input.target}`;
  }

  /**
   * Open PR: pushes the branch to `origin` (`git push -u origin <branch>`, never forced) and
   * opens a pull request into the target with gh. An open PR for the branch is reused. Returns its URL.
   */
  async openPullRequest(input: BranchMergeInput, title: string, body: string): Promise<string> {
    const dir = (await isDirectory(input.dir)) ? input.dir : input.repoPath;
    if ((await this.#sha(dir, `refs/heads/${input.branch}`)) === null) throw new BranchMergeError('no-branch', `${input.repo}: the branch ${input.branch} does not exist`);
    const remote = await this.#run(dir, ['remote', 'get-url', 'origin']);
    if (!succeeded(remote)) throw new BranchMergeError('no-remote', `${input.repo} has no origin remote to open a pull request on`);
    const pushed = await this.#run(dir, ['push', '-u', 'origin', `refs/heads/${input.branch}:refs/heads/${input.branch}`]);
    if (!succeeded(pushed)) throw new BranchMergeError('git-failed', `git push failed in ${dir}: ${failureText(pushed)}`);
    const existing = await this.#runGh(dir, ['pr', 'view', input.branch, '--json', 'url,state']);
    if (succeeded(existing)) {
      try {
        const parsed = JSON.parse(existing.stdout) as { url?: unknown; state?: unknown };
        if (typeof parsed.url === 'string' && parsed.state === 'OPEN') return parsed.url;
      } catch {
        // Fall through: create one.
      }
    }
    const created = await this.#runGh(dir, ['pr', 'create', '--base', input.target, '--head', input.branch, '--title', title, '--body', body]);
    if (!succeeded(created)) throw new BranchMergeError('gh-failed', `gh pr create failed: ${failureText(created)}`);
    const url = created.stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /^https?:\/\//.test(line));
    if (!url) throw new BranchMergeError('gh-failed', `gh pr create printed no URL: ${created.stdout.trim().slice(0, 200)}`);
    return url;
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
    const updated = await this.#run(dir, ['update-ref', '-m', 'switchboard: merge', ref, value, old]);
    if (!succeeded(updated)) throw new BranchMergeError('git-failed', `git update-ref ${ref} failed: ${failureText(updated)}`);
  }

  #run(cwd: string, args: readonly string[]): Promise<RunResult> {
    return runCommand(this.#git, args, { cwd, env: { ...this.#env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, timeoutMs: this.#timeout });
  }

  #runGh(cwd: string, args: readonly string[]): Promise<RunResult> {
    return runCommand(this.#gh, args, { cwd, env: { ...this.#env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' }, timeoutMs: this.#timeout });
  }
}
