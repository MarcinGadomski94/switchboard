import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FoundCheckout, TargetDirEntry } from '../../core/takeover.ts';
import { normalizeRemoteUrl, redactUrl } from '../../core/takeover.ts';
import { isMainCheckout } from '../solutions/checkout.ts';
import type { TakeoverGit } from './git.ts';

/**
 * D110 (`docs/peers.md` → *Target folders and verification*): the target side of
 * "which folder holds the session's repos here". Two read-only jobs, both
 * callable by a paired machine: the folder picker's listing (folders only, never
 * a file name or contents, never outside the allowed places) and the search for
 * checkouts under the chosen folders (bounded depth), with each checkout's
 * remotes, branch and uncommitted count. Nothing here writes anything.
 */

/** Most folders one search visits (a home folder chosen as a root stays cheap). */
export const LOCATE_MAX_DIRS = 2_000;

/** Most entries one listing returns. */
export const LIST_MAX_ENTRIES = 500;

/** Folders never searched or listed into: dependencies, build output, the read-only archives of a workspace. */
const SKIPPED = new Set(['node_modules', 'bin', 'obj', 'dist', 'build', 'deprecated', 'infrastructure', 'Library', 'AppData']);

/** Case-insensitive file systems (macOS, Windows) compare paths without case. */
function samePrefix(child: string, parent: string): boolean {
  const fold = process.platform === 'darwin' || process.platform === 'win32';
  const a = fold ? child.toLowerCase() : child;
  const b = fold ? parent.toLowerCase() : parent;
  if (a === b) return true;
  const withSep = b.endsWith(path.sep) ? b : `${b}${path.sep}`;
  return a.startsWith(withSep);
}

/**
 * The places a listing or a search may look into: the home folder, every saved
 * folder and every saved folder's parent (where D65 already clones a missing repo
 * next to the default folder; a PC's `D:\code` holds the saved `D:\code\ws`).
 * Real paths; ones that do not exist are left out.
 */
export async function allowedPlaces(home: string, savedFolders: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  const add = async (value: string): Promise<void> => {
    const real = await realpath(value).catch(() => null);
    if (real && !out.includes(real)) out.push(real);
  };
  await add(home);
  for (const folder of savedFolders) {
    await add(folder);
    const parent = path.dirname(folder);
    // Never a drive / file-system root as an allowed place.
    if (parent !== folder && path.dirname(parent) !== parent) await add(parent);
  }
  return out;
}

/** Why a path may not be looked into. */
export class LocateRefusal extends Error {
  override name = 'LocateRefusal';
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * `input` as a real folder inside one of `places`, or a {@link LocateRefusal}
 * (422 not absolute / missing / not a folder, 403 outside the allowed places). A
 * symlink is resolved first, so it cannot point out of them.
 */
export async function resolveAllowed(input: string, places: readonly string[]): Promise<string> {
  if (!path.isAbsolute(input)) throw new LocateRefusal(422, `${input} is not an absolute path on this machine`);
  const real = await realpath(input).catch(() => null);
  if (real === null) throw new LocateRefusal(422, `${input} does not exist on this machine`);
  if (!(await stat(real)).isDirectory()) throw new LocateRefusal(422, `${input} is not a folder`);
  if (!places.some((place) => samePrefix(real, place))) throw new LocateRefusal(403, `${input} is outside the home folder and the saved folders of this machine`);
  return real;
}

async function dirsOf(dir: string): Promise<Dirent[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
  // `isDirectory()` is false for a symlink: links are never followed.
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('$')).sort((a, b) => a.name.localeCompare(b.name));
}

async function isWorkspace(dir: string): Promise<boolean> {
  try {
    return (await lstat(path.join(dir, 'AGENTS.md'))).isFile() && !(await isMainCheckout(dir));
  } catch {
    return false;
  }
}

/**
 * The folders inside `dir` (one level, hidden ones and links left out), each
 * marked repo / workspace. `dir` must already be {@link resolveAllowed}.
 */
export async function listFolders(dir: string): Promise<TargetDirEntry[]> {
  const out: TargetDirEntry[] = [];
  for (const entry of (await dirsOf(dir)).slice(0, LIST_MAX_ENTRIES)) {
    const child = path.join(dir, entry.name);
    const repo = await isMainCheckout(child);
    out.push({ name: entry.name, path: child, repo, workspace: !repo && (await isWorkspace(child)) });
  }
  return out;
}

/**
 * The git main checkouts under `root`, bounded: `root` itself when it is one
 * (nothing under a checkout is searched), else its direct subfolders and their
 * subfolders (a workspace's group folders `microfrontends/…`, the nested mobile
 * clone `mobile/<repo>/`). Hidden folders, links, worktrees (`.git` is a file),
 * dependencies and a workspace's read-only archives are never matches; at most
 * {@link LOCATE_MAX_DIRS} folders are visited.
 */
export async function findCheckouts(root: string): Promise<string[]> {
  if (await isMainCheckout(root)) return [root];
  const out: string[] = [];
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await dirsOf(dir)) {
      if (visited >= LOCATE_MAX_DIRS) return;
      if (SKIPPED.has(entry.name)) continue;
      visited++;
      const child = path.join(dir, entry.name);
      if (await isMainCheckout(child)) out.push(child);
      else if (depth < 2) await walk(child, depth + 1);
    }
  };
  await walk(root, 1);
  return out;
}

/** One checkout on the target, with what the verification needs. */
export interface CheckoutFacts extends FoundCheckout {
  /** `remote name → normalised key` (every remote of the checkout). */
  readonly remotes: ReadonlyArray<{ readonly name: string; readonly url: string; readonly key: string }>;
}

/** The facts of a checkout: its remotes (URLs redacted, keys normalised), its branch and its uncommitted count. */
export async function checkoutFacts(dir: string, git: TakeoverGit): Promise<CheckoutFacts> {
  const names = (await git.try(dir, ['remote'])).out.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const remotes: Array<{ name: string; url: string; key: string }> = [];
  for (const name of names) {
    const url = await git.try(dir, ['remote', 'get-url', name]);
    if (url.ok && url.out !== '') remotes.push({ name, url: redactUrl(url.out), key: normalizeRemoteUrl(url.out) });
  }
  const branch = await git.currentBranch(dir);
  const dirty = (await git.dirtyCounts(dir)).total;
  return { path: dir, branch, dirty, remotes };
}
