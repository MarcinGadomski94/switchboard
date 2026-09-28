import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SolutionGroup } from '../../core/api.ts';
import {
  type FolderSpec,
  type RouterFile,
  type ScannedFolder,
  type ScannedSolution,
  type WorkspaceScan,
  readOnlyCheck,
  mergeFolderRules,
  parseRouterRules,
  toSolutionGroups,
} from '../../core/workspace-rules.ts';
import { checkoutOf } from './checkout.ts';

/** The router file at the workspace root. */
export const ROUTER_FILE = 'AGENTS.md';

/** Why a scan could not run: the folder is gone (D14: `no-folder` is the folder service's). */
export type ScanErrorCode = 'folder-missing';

/** A scan refusal: the workspace folder is not a folder (any more). */
export class ScanError extends Error {
  override name = 'ScanError';
  readonly code: ScanErrorCode;

  constructor(code: ScanErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Options for {@link WorkspaceScanner}. */
export interface WorkspaceScannerOptions {
  /** The workspace folder to scan (absolute; a saved folder's path, D14). */
  readonly root: string;
}

/** The folder rules of a workspace and the router file they came from. */
export interface WorkspaceRules {
  readonly router: RouterFile;
  readonly folders: FolderSpec[];
}

type GitKind = 'dir' | 'file' | 'none';

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

function isGone(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * What `<dir>/.git` is: a directory (a main checkout), a file (a worktree or
 * submodule, gap #16) or anything else. Not followed when it is a symlink, like
 * the worktree manager's `resolveRepo`.
 */
async function gitKind(dir: string): Promise<GitKind> {
  try {
    const info = await lstat(path.join(dir, '.git'));
    if (info.isDirectory()) return 'dir';
    if (info.isFile()) return 'file';
    return 'none';
  } catch {
    return 'none';
  }
}

async function listDirs(dir: string): Promise<Dirent[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isGone(error)) return [];
    throw error;
  }
  // Real directories only: files, symlinks and hidden folders (`.git`, `.idea`, `.claude`) are never solutions.
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
}

/**
 * The WorkspaceScanner (M6.1, `docs/solutions.md`): reads the folder rules out of
 * the router `AGENTS.md` of one workspace folder (D14: one scanner per folder),
 * lists each folder's solutions and groups them as `GET /api/solutions` does.
 * Read-only: it never writes anywhere, never runs a process and never follows a
 * symlink.
 */
export class WorkspaceScanner {
  readonly #root: string;

  constructor(options: WorkspaceScannerOptions) {
    this.#root = options.root;
  }

  /** The scanned rows grouped as `GET /api/solutions` (without the live fields). @throws {ScanError} when the folder is gone. */
  async solutions(): Promise<SolutionGroup[]> {
    return toSolutionGroups(await this.scan());
  }

  /**
   * NewSession validation (`POST /api/sessions`, 422): `true` when the router's
   * folder rules make `solution` read-only ({@link readOnlyCheck}): its path
   * starts in a read-only folder, or a folder it can resolve to lies in one and
   * exists.
   */
  async isReadOnly(solution: string): Promise<boolean> {
    const root = this.#root;
    const { folders } = await this.rules(root);
    const check = readOnlyCheck(folders, root, solution);
    if (check.always) return true;
    for (const candidate of check.candidates) {
      try {
        if ((await lstat(candidate)).isDirectory()) return true;
      } catch {
        // not there: this candidate cannot be the write target
      }
    }
    return false;
  }

  /** The whole scan: the router file, then every folder's solutions. @throws {ScanError} */
  async scan(): Promise<WorkspaceScan> {
    const root = await this.#workspaceRoot();
    const { router, folders } = await this.rules(root);
    const scanned: ScannedFolder[] = [];
    for (const spec of folders) scanned.push(await this.#scanFolder(root, spec));
    return { root, router, folders: scanned };
  }

  /**
   * The folder rules of the workspace at `root`: `<root>/AGENTS.md` parsed and
   * merged onto the baseline layout (`mergeFolderRules`). Without the file the
   * baseline alone applies (`router.found` = false).
   */
  async rules(root: string): Promise<WorkspaceRules> {
    const file = path.join(root, ROUTER_FILE);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (isGone(error)) return { router: { path: file, found: false, lines: 0 }, folders: mergeFolderRules([]) };
      throw error;
    }
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    return { router: { path: file, found: true, lines: lines.length }, folders: mergeFolderRules(parseRouterRules(text)) };
  }

  async #workspaceRoot(): Promise<string> {
    const root = this.#root;
    try {
      if ((await stat(root)).isDirectory()) return root;
    } catch {
      // reported below
    }
    throw new ScanError('folder-missing', `the folder does not exist: ${root}`);
  }

  async #scanFolder(root: string, spec: FolderSpec): Promise<ScannedFolder> {
    const dir = path.join(root, spec.folder);
    let exists = false;
    try {
      exists = (await lstat(dir)).isDirectory();
    } catch (error) {
      if (!isGone(error)) throw error;
    }
    if (!exists) return { ...spec, exists, solutions: [] };
    const solutions: ScannedSolution[] = [];
    if (spec.depth === 0) {
      const git = await gitKind(dir);
      if (git !== 'file') solutions.push(await this.#solution(root, [spec.folder], git));
    } else {
      await this.#walk(root, [spec.folder], spec.depth, solutions);
    }
    solutions.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
    return { ...spec, exists, solutions };
  }

  /**
   * Walks `remaining` levels below `parts`: a folder whose `.git` is a file is
   * skipped (gap #16: a worktree such as `web-front-wt-x`, or a submodule); a
   * main checkout is a solution wherever it sits (`deprecated/mobile/` is one
   * repo, not a type group); any other folder is a solution at the last level
   * and a grouping folder above it.
   */
  async #walk(root: string, parts: readonly string[], remaining: number, into: ScannedSolution[]): Promise<void> {
    for (const entry of await listDirs(path.join(root, ...parts))) {
      const childParts = [...parts, entry.name];
      const git = await gitKind(path.join(root, ...childParts));
      if (git === 'file') continue;
      if (git === 'dir' || remaining <= 1) {
        into.push(await this.#solution(root, childParts, git));
        continue;
      }
      await this.#walk(root, childParts, remaining - 1, into);
    }
  }

  async #solution(root: string, parts: readonly string[], git: GitKind): Promise<ScannedSolution> {
    const dir = path.join(root, ...parts);
    // Not a checkout itself: it may hold exactly one (the nested mobile clone, `checkoutOf`).
    const repoPath = git === 'dir' ? dir : await checkoutOf(dir);
    return {
      name: parts.at(-1) as string,
      relativePath: parts.join('/'),
      path: dir,
      git: repoPath !== null,
      repoPath,
    };
  }
}
