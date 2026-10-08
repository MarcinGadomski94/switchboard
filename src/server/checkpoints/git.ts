import { randomUUID } from 'node:crypto';
import { copyFile, lstat, readdir, rm, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CheckpointFileChange, CheckpointFileChangeKind, CheckpointHeadPlan } from '../../core/checkpoints.ts';
import { isCheckpointRef } from '../../core/checkpoints.ts';
import { failureText, runCommand, succeeded } from '../exec.ts';

/**
 * D80 (`docs/undo.md` → *How a checkpoint is built*): the git side of Undo a
 * turn. A checkpoint is built with a **throw-away index** (D65's technique,
 * `takeover/git.ts`): the developer's index file is copied to a temp file (so
 * git's stat cache makes `add` fast), `GIT_INDEX_FILE` points git at the copy,
 * `git add -A` adds every tracked and untracked file (ignored ones never),
 * `write-tree` + `commit-tree` (parent = HEAD) make the commit. The developer's
 * index, HEAD, branch and files are never written. Every call is argv-only.
 */

/** A git failure, with the command. */
export class CheckpointGitError extends Error {
  override name = 'CheckpointGitError';
}

/** The identity of checkpoint commits (the user's `user.name` may be unset). */
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Switchboard',
  GIT_AUTHOR_EMAIL: 'switchboard@localhost',
  GIT_COMMITTER_NAME: 'Switchboard',
  GIT_COMMITTER_EMAIL: 'switchboard@localhost',
} as const;

/** Paths per `checkout-index` call (argv stays far below the OS limit). */
const CHECKOUT_BATCH = 200;

/** The state of one working tree at a moment. */
export interface TreeSnapshot {
  /** The working tree's top-level folder. */
  readonly top: string;
  /** The repo's common git dir (two worktrees of one repo share it, and its refs). */
  readonly commonDir: string;
  /** HEAD's commit; `null` before the first commit. */
  readonly head: string | null;
  /** The checked-out branch; `null` for a detached HEAD. */
  readonly branch: string | null;
  /** Tracked + untracked (not ignored) files as a tree. */
  readonly tree: string;
  /** The developer's index as a tree; `null` when it cannot be written (unmerged entries). */
  readonly indexTree: string | null;
}

/** Runs git for checkpoints. */
export class CheckpointGit {
  readonly #env: NodeJS.ProcessEnv;
  readonly #timeoutMs: number;

  constructor(options: { readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number } = {}) {
    // A GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE of Switchboard's own environment must never redirect these calls.
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(options.env ?? process.env)) {
      if (!['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'].includes(key)) env[key] = value;
    }
    this.#env = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
    this.#timeoutMs = options.timeoutMs ?? 120_000;
  }

  /** `git <args>` in `cwd`: the outcome as a value. */
  async try(cwd: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<{ readonly ok: boolean; readonly out: string; readonly raw: string; readonly error: string; readonly code: number | null }> {
    const result = await runCommand(['git'], args, { cwd, env: { ...this.#env, ...extraEnv }, timeoutMs: this.#timeoutMs });
    const ok = succeeded(result);
    return { ok, out: result.stdout.trim(), raw: result.stdout, error: ok ? '' : failureText(result), code: result.code };
  }

  /** `git <args>` in `cwd`: trimmed stdout, else throws {@link CheckpointGitError}. */
  async run(cwd: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
    const result = await this.try(cwd, args, extraEnv);
    if (!result.ok) throw new CheckpointGitError(`git ${args.join(' ')} failed in ${cwd}: ${result.error}`);
    return result.out;
  }

  /** The top-level folder of the working tree `dir` is in; `null` when it is none (not a repo, a bare repo, missing). */
  async toplevel(dir: string): Promise<string | null> {
    const result = await this.try(dir, ['rev-parse', '--show-toplevel']);
    return result.ok && result.out !== '' ? result.out : null;
  }

  /** HEAD's commit, or `null` before the first commit. */
  async head(top: string): Promise<string | null> {
    const result = await this.try(top, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    return result.ok && result.out !== '' ? result.out : null;
  }

  /** The checked-out branch (short name), `null` for a detached HEAD. */
  async branch(top: string): Promise<string | null> {
    const result = await this.try(top, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return result.ok && result.out !== '' ? result.out : null;
  }

  /**
   * Snapshots the working tree `top` **without writing anything of the
   * developer's**: copies the index to a temp file, writes its tree (the staged
   * state), then `git add -A` into the copy and writes that tree (tracked +
   * untracked files, `.gitignore` respected). Only objects are added to the repo.
   */
  async snapshot(top: string): Promise<TreeSnapshot> {
    const commonDir = await this.run(top, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const realIndex = await this.run(top, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const head = await this.head(top);
    const branch = await this.branch(top);
    const temp = path.join(os.tmpdir(), `switchboard-checkpoint-${randomUUID()}.index`);
    const env = { GIT_INDEX_FILE: temp };
    try {
      let copied = true;
      try {
        await copyFile(realIndex, temp);
      } catch {
        copied = false;
      }
      let indexTree: string | null = null;
      if (copied) {
        const staged = await this.try(top, ['write-tree'], env);
        indexTree = staged.ok && staged.out !== '' ? staged.out : null;
      } else if (head !== null) {
        // No index file (a clone with --no-checkout, …): start from HEAD.
        await this.run(top, ['read-tree', 'HEAD'], env);
        indexTree = await this.run(top, ['rev-parse', 'HEAD^{tree}']);
      } else {
        indexTree = await this.emptyTree(top);
      }
      await this.run(top, ['add', '-A'], env);
      const tree = await this.run(top, ['write-tree'], env);
      return { top, commonDir, head, branch, tree, indexTree };
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
      await rm(`${temp}.lock`, { force: true }).catch(() => undefined);
    }
  }

  /** The empty tree's id in this repo's hash (`write-tree` of a fresh throw-away index). */
  async emptyTree(top: string): Promise<string> {
    const temp = path.join(os.tmpdir(), `switchboard-empty-${randomUUID()}.index`);
    try {
      return await this.run(top, ['write-tree'], { GIT_INDEX_FILE: temp });
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  /** `commit-tree` of a snapshot (parent = its HEAD), no hooks, no signing. */
  async commit(snapshot: TreeSnapshot, message: string): Promise<string> {
    const parent = snapshot.head ? ['-p', snapshot.head] : [];
    return this.run(snapshot.top, ['-c', 'commit.gpgsign=false', 'commit-tree', snapshot.tree, ...parent, '-m', message], IDENTITY);
  }

  /** Points a checkpoint ref at `sha` (only refs under `refs/switchboard/checkpoints/`). */
  async setRef(top: string, ref: string, sha: string): Promise<void> {
    if (!isCheckpointRef(ref)) throw new CheckpointGitError(`refusing to write ${ref}: not a checkpoint ref`);
    await this.run(top, ['update-ref', ref, sha]);
  }

  /** Deletes a checkpoint ref (gone already: fine). Only refs under `refs/switchboard/checkpoints/`. */
  async deleteRef(dir: string, ref: string): Promise<void> {
    if (!isCheckpointRef(ref)) throw new CheckpointGitError(`refusing to delete ${ref}: not a checkpoint ref`);
    await this.try(dir, ['update-ref', '-d', ref]);
  }

  /** `true` when `ref` names an existing commit. */
  async hasCommit(top: string, sha: string): Promise<boolean> {
    return (await this.try(top, ['cat-file', '-e', `${sha}^{commit}`])).ok;
  }

  /** The files that differ between two trees (`from` → `to`), paths relative to the top. */
  async diff(top: string, from: string, to: string): Promise<CheckpointFileChange[]> {
    if (from === to) return [];
    const result = await this.try(top, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', from, to]);
    if (!result.ok) throw new CheckpointGitError(`git diff-tree failed in ${top}: ${result.error}`);
    const parts = result.raw.split('\0');
    const out: CheckpointFileChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i] as string;
      const file = parts[i + 1] as string;
      if (status === '' || file === '') continue;
      out.push({ path: file, change: changeKind(status) });
    }
    return out;
  }

  /** `true` when `ancestor` is an ancestor of (or equal to) `descendant`. */
  async isAncestor(top: string, ancestor: string, descendant: string): Promise<boolean> {
    return (await this.try(top, ['merge-base', '--is-ancestor', ancestor, descendant])).ok;
  }

  /** The commits `from..to` (count), and how many of them no remote-tracking ref contains (not pushed). */
  async commitsBetween(top: string, from: string, to: string): Promise<{ readonly total: number; readonly unpushed: number }> {
    const total = Number(await this.run(top, ['rev-list', '--count', `${from}..${to}`]));
    const unpushed = Number(await this.run(top, ['rev-list', '--count', `${from}..${to}`, '--not', '--remotes']));
    return { total, unpushed };
  }

  /**
   * What a revert to a checkpoint (`target`: HEAD and branch then) does with the
   * branch of `current` (developer ruling): nothing when HEAD did not move; move the
   * branch back (a reset to the recorded HEAD) only when the branch is the same, the
   * recorded HEAD is an ancestor of today's, and none of the commits since is pushed;
   * otherwise refused, with the reason (files only).
   */
  async revertHeadPlan(top: string, target: { readonly head: string | null; readonly branch: string | null }, current: { readonly head: string | null; readonly branch: string | null }): Promise<CheckpointHeadPlan> {
    const base = { branch: target.branch, to: target.head };
    if (target.head === current.head) return { ...base, action: 'none', commits: 0, reason: null };
    if (target.head === null) return { ...base, action: 'refused', commits: 0, reason: `${path.basename(top)} had no commit before this turn, so its branch cannot go back` };
    if (target.branch !== current.branch) {
      const was = target.branch ?? 'a detached HEAD';
      const now = current.branch ?? 'a detached HEAD';
      return { ...base, action: 'refused', commits: 0, reason: `${path.basename(top)} is on ${now} now, not ${was} as before this turn` };
    }
    if (current.head === null || !(await this.hasCommit(top, target.head)) || !(await this.isAncestor(top, target.head, current.head))) {
      return { ...base, action: 'refused', commits: 0, reason: `the history of ${target.branch ?? 'HEAD'} in ${path.basename(top)} was rewritten since this turn` };
    }
    const { total, unpushed } = await this.commitsBetween(top, target.head, current.head);
    if (unpushed < total) {
      const pushed = total - unpushed;
      return { ...base, action: 'refused', commits: total, reason: `${pushed} of the ${total} commit${total === 1 ? '' : 's'} made on ${target.branch ?? 'HEAD'} since this turn ${pushed === 1 ? 'is' : 'are'} already pushed` };
    }
    return { ...base, action: 'reset', commits: total, reason: null };
  }

  /**
   * Redo's plan: the branch goes forward again to the HEAD the safety capture
   * recorded, when it is still on the same branch and today's HEAD is an ancestor
   * of it (nothing was committed on top of the revert); otherwise files only.
   */
  async redoHeadPlan(top: string, target: { readonly head: string | null; readonly branch: string | null }, current: { readonly head: string | null; readonly branch: string | null }): Promise<CheckpointHeadPlan> {
    const base = { branch: target.branch, to: target.head };
    if (target.head === current.head) return { ...base, action: 'none', commits: 0, reason: null };
    if (target.head === null || current.head === null || target.branch !== current.branch) {
      return { ...base, action: 'refused', commits: 0, reason: `${path.basename(top)} is not on the branch it was on before the revert` };
    }
    if (!(await this.isAncestor(top, current.head, target.head))) {
      return { ...base, action: 'refused', commits: 0, reason: `${target.branch ?? 'HEAD'} in ${path.basename(top)} moved since the revert` };
    }
    const total = Number(await this.run(top, ['rev-list', '--count', `${current.head}..${target.head}`]));
    return { ...base, action: 'reset', commits: total, reason: null };
  }

  /** Moves the branch (or a detached HEAD) from `from` to `to` (`update-ref` with the old value checked; the reflog keeps the old one). */
  async moveHead(top: string, branch: string | null, from: string, to: string, reason: string): Promise<void> {
    if (branch !== null) await this.run(top, ['update-ref', '-m', reason, `refs/heads/${branch}`, to, from]);
    else await this.run(top, ['update-ref', '--no-deref', '-m', reason, 'HEAD', to, from]);
  }

  /**
   * Makes the working tree's files those of `target`: `changes` (from the current
   * state's tree to `target`, {@link diff}) are applied: deleted files are removed
   * (and folders left empty by that), added and modified ones are written from a
   * throw-away index filled with `target` (`checkout-index`). Files the changes do
   * not name (ignored ones above all) are never touched.
   */
  async restoreFiles(top: string, target: string, changes: readonly CheckpointFileChange[]): Promise<void> {
    for (const change of changes) {
      if (change.change !== 'deleted') continue;
      const file = safeJoin(top, change.path);
      await rm(file, { force: true });
      await removeEmptyParents(top, path.dirname(file));
    }
    const writes = changes.filter((change) => change.change !== 'deleted').map((change) => change.path);
    if (writes.length === 0) return;
    const temp = path.join(os.tmpdir(), `switchboard-restore-${randomUUID()}.index`);
    const env = { GIT_INDEX_FILE: temp };
    try {
      await this.run(top, ['read-tree', target], env);
      for (let i = 0; i < writes.length; i += CHECKOUT_BATCH) {
        const batch = writes.slice(i, i + CHECKOUT_BATCH);
        // A folder where a file goes (or the reverse) is cleared first: checkout-index writes files only.
        for (const file of batch) await clearBlocking(top, file);
        await this.run(top, ['checkout-index', '-f', '--', ...batch], env);
      }
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
      await rm(`${temp}.lock`, { force: true }).catch(() => undefined);
    }
  }

  /** Sets the developer's index to `tree` (a revert restores the staged state too), then refreshes its stat cache. */
  async setIndex(top: string, tree: string): Promise<void> {
    await this.run(top, ['read-tree', tree]);
    await this.try(top, ['update-index', '-q', '--refresh']);
  }
}

function changeKind(status: string): CheckpointFileChangeKind {
  if (status.startsWith('A')) return 'added';
  if (status.startsWith('D')) return 'deleted';
  return 'modified';
}

/** `top/relative`, refusing a path that leaves `top` (git never gives one; a guard all the same). */
function safeJoin(top: string, relative: string): string {
  const full = path.resolve(top, relative);
  if (full !== top && !full.startsWith(`${top}${path.sep}`)) throw new CheckpointGitError(`refusing a path outside ${top}: ${relative}`);
  return full;
}

/** Removes `dir` and its parents up to (not including) `top` while they are empty. */
async function removeEmptyParents(top: string, dir: string): Promise<void> {
  let current = dir;
  while (current !== top && current.startsWith(`${top}${path.sep}`)) {
    try {
      if ((await readdir(current)).length > 0) return;
      await rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

/**
 * Before a file is written at `relative`: a folder in its place goes when it holds
 * nothing (the revert already removed the files that do not belong there), and a
 * file where one of its parent folders goes is removed. Anything else stays and
 * `checkout-index` reports it.
 */
async function clearBlocking(top: string, relative: string): Promise<void> {
  const full = safeJoin(top, relative);
  const parts = relative.split('/');
  let current = top;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = await lstat(current).catch(() => null);
    if (stat && !stat.isDirectory()) await rm(current, { force: true });
    if (!stat || !stat.isDirectory()) return;
  }
  const stat = await lstat(full).catch(() => null);
  if (stat?.isDirectory()) await rmdir(full).catch(() => undefined);
}
