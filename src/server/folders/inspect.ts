import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FolderCheck, FolderProblem } from '../../core/api.ts';
import { countLines, routerTitle } from '../../core/setup.ts';
import { toSolutionGroups } from '../../core/workspace-rules.ts';
import { isMainCheckout } from '../solutions/checkout.ts';
import { ROUTER_FILE, WorkspaceScanner } from '../solutions/scanner.ts';

/** Options of {@link inspectFolder}. */
export interface InspectOptions {
  /** `~` in a typed path (default `os.homedir()`). */
  readonly home?: string;
}

/** The refusal copy of each {@link FolderProblem}. */
export const FOLDER_PROBLEM_MESSAGES: Readonly<Record<FolderProblem, string>> = {
  'not-absolute': 'enter an absolute path',
  missing: 'folder not found',
  'not-a-folder': 'not a folder',
  'git-worktree': 'a git worktree or submodule, not a main checkout: add the repository itself',
  // Before D59; a folder that is neither is now a `plain` folder ({@link inspectFolder}).
  unsupported: 'no AGENTS.md here and not a git repository',
};

/** `~`, `~/…` and `~\…` → the home folder; anything else unchanged. */
export function expandHome(typed: string, home: string = os.homedir()): string {
  if (typed === '~') return home;
  if (typed.startsWith('~/') || typed.startsWith('~\\')) return path.join(home, typed.slice(2));
  return typed;
}

/** `<dir>/.git` is a file: a linked worktree or a submodule (gap #16), not followed when it is a symlink. */
async function gitFile(dir: string): Promise<boolean> {
  try {
    return (await lstat(path.join(dir, '.git'))).isFile();
  } catch {
    return false;
  }
}

function refused(folder: string, canonicalPath: string | null, exists: boolean, problem: FolderProblem): FolderCheck {
  return { path: folder, canonicalPath, exists, kind: null, router: null, solutionCount: null, repoName: null, problem, message: FOLDER_PROBLEM_MESSAGES[problem] };
}

/**
 * What a folder is (D14, `docs/folders.md` → *Kinds*), read-only and async:
 * 1. a **git main checkout** (`.git` is a folder) is a `repo`, even when it has
 *    its own `AGENTS.md` (a repo's rules do not make it a workspace);
 * 2. else a folder whose `.git` is a file (a linked worktree or a submodule) is
 *    refused (`git-worktree`): its main checkout is the repo to add;
 * 3. else a folder with an `AGENTS.md` is a `workspace`: the router's title and
 *    line count, and how many solutions the workspace scanner finds (the
 *    scanner's router parsing, M6.1);
 * 4. D59: any other folder is `plain` (no `AGENTS.md`, not a git repository):
 *    Simple sessions start there; it has no solutions (`solutionCount` 0);
 * 5. anything else is refused: not absolute, missing or a file.
 * `input` may start with `~`. Nothing is written and no process runs.
 */
export async function inspectFolder(input: string, options: InspectOptions = {}): Promise<FolderCheck> {
  const typed = expandHome(input.trim(), options.home);
  if (!path.isAbsolute(typed)) return refused(input.trim(), null, false, 'not-absolute');
  const folder = path.resolve(typed);
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(folder)).isDirectory();
  } catch {
    return refused(folder, null, false, 'missing');
  }
  const canonicalPath = await realpath(folder).catch(() => folder);
  if (!isDirectory) return refused(folder, canonicalPath, false, 'not-a-folder');
  // The scanner's and the worktree manager's rule for a main checkout (`solutions/checkout.ts`).
  if (await isMainCheckout(folder)) {
    return { path: folder, canonicalPath, exists: true, kind: 'repo', router: null, solutionCount: 1, repoName: path.basename(canonicalPath), problem: null, message: '' };
  }
  if (await gitFile(folder)) return refused(folder, canonicalPath, true, 'git-worktree');
  let text: string;
  try {
    text = await readFile(path.join(folder, ROUTER_FILE), 'utf8');
  } catch {
    // D59: neither a git main checkout nor a workspace: a plain folder.
    return { path: folder, canonicalPath, exists: true, kind: 'plain', router: null, solutionCount: 0, repoName: null, problem: null, message: '' };
  }
  let solutionCount: number | null = null;
  try {
    const groups = toSolutionGroups(await new WorkspaceScanner({ root: folder }).scan());
    solutionCount = groups.reduce((sum, group) => sum + group.solutions.length, 0);
  } catch {
    solutionCount = null;
  }
  return {
    path: folder,
    canonicalPath,
    exists: true,
    kind: 'workspace',
    router: { title: routerTitle(text), lines: countLines(text) },
    solutionCount,
    repoName: null,
    problem: null,
    message: '',
  };
}
