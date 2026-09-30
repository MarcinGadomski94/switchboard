import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { InstallKind } from '../../core/updates.ts';

/**
 * Where installs live (D55, `docs/updates.md` → *Install layout*): the updater
 * keeps versions side by side under the data folder, `<dataDir>/versions/<v>`,
 * and the login service's definition is the stable pointer that says which one
 * starts. `<dataDir>/updates/` holds the downloads, the staging folders and
 * `installs.json` (the current and the previous install, for a rollback). The
 * database and everything else in the data folder are never touched.
 */

/** The folders of the updater under a data folder. */
export interface UpdatePaths {
  /** `<dataDir>/versions`: one folder per installed version. */
  readonly versions: string;
  /** `<dataDir>/updates`. */
  readonly updates: string;
  /** `<dataDir>/updates/downloads`. */
  readonly downloads: string;
  /** `<dataDir>/updates/staging`. */
  readonly staging: string;
  /** `<dataDir>/updates/installs.json`. */
  readonly ledger: string;
  /** `<dataDir>/logs/update.log`: the restart helper's log. */
  readonly log: string;
}

/** The updater's paths under `dataDir`. */
export function updatePaths(dataDir: string): UpdatePaths {
  const updates = path.join(dataDir, 'updates');
  return {
    versions: path.join(dataDir, 'versions'),
    updates,
    downloads: path.join(updates, 'downloads'),
    staging: path.join(updates, 'staging'),
    ledger: path.join(updates, 'installs.json'),
    log: path.join(dataDir, 'logs', 'update.log'),
  };
}

/** `<dataDir>/versions/<version>`. */
export function versionDir(paths: UpdatePaths, version: string): string {
  return path.join(paths.versions, version);
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The install kind of `appDir`: `git` when it holds `.git` (a folder, or the
 * file of a worktree), else `release`.
 */
export async function detectInstallKind(appDir: string): Promise<InstallKind> {
  return (await exists(path.join(appDir, '.git'))) ? 'git' : 'release';
}

/** The version in `<dir>/package.json` (`null` when unreadable). */
export async function packageVersion(dir: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { version?: unknown; name?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** One install in the ledger. */
export interface InstallRef {
  readonly version: string;
  readonly dir: string;
}

/** `installs.json`: what the last update switched from and to. */
export interface InstallLedger {
  readonly current: InstallRef | null;
  readonly previous: InstallRef | null;
}

/** Reads the ledger (empty when missing or unreadable). */
export async function readLedger(paths: UpdatePaths): Promise<InstallLedger> {
  try {
    const parsed = JSON.parse(await readFile(paths.ledger, 'utf8')) as Record<string, unknown>;
    const ref = (value: unknown): InstallRef | null => {
      if (typeof value !== 'object' || value === null) return null;
      const record = value as Record<string, unknown>;
      return typeof record['version'] === 'string' && typeof record['dir'] === 'string' ? { version: record['version'], dir: record['dir'] } : null;
    };
    return { current: ref(parsed['current']), previous: ref(parsed['previous']) };
  } catch {
    return { current: null, previous: null };
  }
}

/** Writes the ledger atomically (a temp file renamed over it). */
export async function writeLedger(paths: UpdatePaths, ledger: InstallLedger): Promise<void> {
  await mkdir(paths.updates, { recursive: true });
  const temp = `${paths.ledger}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(ledger, null, 2)}\n`);
  await rename(temp, paths.ledger);
}

/** `true` when `child` is `parent` or inside it (both resolved). */
export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Leftovers of an interrupted update (downloads, staging folders) and every
 * `versions/*` folder that is neither the running install nor the ledger's
 * previous one. Only folders the updater made are ever removed: nothing outside
 * `<dataDir>/versions` and `<dataDir>/updates`, and the versions only when this
 * process itself runs from one of them (after a manual rollback to an original
 * folder, nothing is pruned).
 * @returns the removed folders.
 */
export async function pruneInstalls(paths: UpdatePaths, appDir: string, ledger: InstallLedger): Promise<string[]> {
  const removed: string[] = [];
  for (const dir of [paths.downloads, paths.staging]) {
    if (await exists(dir)) {
      await rm(dir, { recursive: true, force: true });
      removed.push(dir);
    }
  }
  if (!isInside(appDir, paths.versions)) return removed;
  let names: string[] = [];
  try {
    names = await readdir(paths.versions);
  } catch {
    return removed;
  }
  const keep = new Set([path.resolve(appDir), ...(ledger.previous ? [path.resolve(ledger.previous.dir)] : [])]);
  for (const name of names) {
    const dir = path.resolve(paths.versions, name);
    if (keep.has(dir)) continue;
    await rm(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}
