import type { Dirent } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/** `true` when `<dir>/.git` is a directory (a git main checkout). A symlinked `.git` is not followed. */
export async function isMainCheckout(dir: string): Promise<boolean> {
  try {
    return (await lstat(path.join(dir, '.git'))).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The git main checkout a solution folder stands for: the folder itself, or,
 * when it is not one, its only direct subfolder that is (developer ruling
 * 2026-09-28: the mobile clone sits at `mobile/acme-app-mobile/`, one level
 * below the router's `mobile/`). Hidden folders, symlinks and worktrees (`.git`
 * is a file) never count, so a worktree next to the nested repo does not make it
 * ambiguous. `null` when there is no checkout, or several subfolders are one.
 */
export async function checkoutOf(dir: string): Promise<string | null> {
  if (await isMainCheckout(dir)) return dir;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const nested: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const child = path.join(dir, entry.name);
    if (await isMainCheckout(child)) nested.push(child);
  }
  return nested.length === 1 ? (nested[0] as string) : null;
}

/**
 * `true` when `<dir>/.git` exists as a directory (a main checkout) or a regular
 * file (a linked worktree or a submodule): `dir` is the top of a git working tree.
 * A symlinked `.git` is not followed.
 */
export async function isWorkingTreeTop(dir: string): Promise<boolean> {
  try {
    const info = await lstat(path.join(dir, '.git'));
    return info.isDirectory() || info.isFile();
  } catch {
    return false;
  }
}

/**
 * The git working tree a solution folder stands for when Switchboard only
 * **watches** it (turn checkpoints, the Diff tab; `docs/worktrees.md`
 * → *Which repositories*): the folder itself when it is a main checkout **or a
 * linked worktree** (an agent-made `…-wt-…` folder), else its one nested main
 * checkout ({@link checkoutOf}). Never used to pick where a worktree is created:
 * that stays {@link checkoutOf} (main checkouts only).
 */
export async function watchedCheckoutOf(dir: string): Promise<string | null> {
  if (await isWorkingTreeTop(dir)) return dir;
  return checkoutOf(dir);
}

/** A linked worktree's main checkout and checked-out `HEAD` ({@link linkedWorktreeOf}). */
export interface LinkedWorktree {
  /** The main checkout the worktree belongs to (the folder holding the shared `.git`). */
  readonly main: string;
  /** The worktree's own `HEAD` file contents (`ref: refs/heads/<branch>` or a commit), `null` when unreadable. */
  readonly head: string | null;
}

/**
 * Solutions (2026-10-14): the main checkout of a **linked worktree** `dir` (an
 * agent-made `…-wt-…` folder or one Switchboard registered): its `.git` is a file
 * `gitdir: <main>/.git/worktrees/<name>`, and that folder's `commondir` names the
 * shared `.git`. `null` for a main checkout, a submodule (no `commondir`), a
 * folder that is gone or anything unreadable. Read-only: two small files.
 */
export async function linkedWorktreeOf(dir: string): Promise<LinkedWorktree | null> {
  try {
    const dotGit = path.join(dir, '.git');
    if (!(await lstat(dotGit)).isFile()) return null;
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, 'utf8'));
    if (!pointer?.[1]) return null;
    const gitDir = path.resolve(dir, pointer[1]);
    const common = path.resolve(gitDir, (await readFile(path.join(gitDir, 'commondir'), 'utf8')).trim());
    if (path.basename(common) !== '.git') return null;
    const head = await readFile(path.join(gitDir, 'HEAD'), 'utf8').catch(() => null);
    return { main: path.dirname(common), head };
  } catch {
    return null;
  }
}
