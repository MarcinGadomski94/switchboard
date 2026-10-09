/**
 * Where a session's files are (`docs/derivations.md`): which solution a written
 * file belongs to (the agent cards' path line, the session's solutions, D38) and
 * how a Bash command reads (`splitStatements`, `addsWorktree`). Until D89 this
 * module also derived the session's artifacts (gap #9); artifacts are now saved
 * on purpose (`src/core/artifacts.ts`, `docs/artifacts.md`).
 *
 * Paths are mapped to solutions with the workspace router's folder layout
 * (`docs/handoff/ARCHITECTURE.md` → *Workspace rules*); worktrees follow gap #1
 * (`../{repo}-wt-{session}`, a sibling of the repo).
 */
import path from 'node:path';
import type { FolderKind } from '../model.ts';

/** Grouping folders whose children are solutions (`microfrontends/<repo>-front`, …). */
export const GROUP_FOLDERS: readonly string[] = ['microfrontends', 'nugets', 'microservices', 'functions', 'other'];

/** Where a file lives in the workspace. */
export interface FileLocation {
  /** Solution (repo) name, `null` for the workspace root or a path outside it. */
  readonly solution: string | null;
  /** Path inside the solution (or the workspace root), `/`-separated; the absolute path when outside the root. */
  readonly relative: string;
  /** `true` when the path is inside the session's worktree of that solution (gap #1 naming). */
  readonly worktree: boolean;
  /** `true` when the path is outside the workspace root. */
  readonly outside: boolean;
}

/** Strips the gap #1 worktree suffix `-wt-<session>` from a folder name. */
function stripWorktree(folder: string, sessionName: string | null): { name: string; worktree: boolean } {
  const suffix = sessionName ? `-wt-${sessionName}` : null;
  if (suffix && folder.endsWith(suffix) && folder.length > suffix.length) {
    return { name: folder.slice(0, -suffix.length), worktree: true };
  }
  return { name: folder, worktree: false };
}

/**
 * Maps a file to its solution. `<group>/<repo>/…` (microfrontends, nugets,
 * microservices, functions, other) → `<repo>`; `mobile/…` → `mobile`;
 * `deprecated/<type>/<repo>/…` → `<repo>`; `infrastructure/…` → `infrastructure`;
 * anything else under the root → the workspace root (`null`). A folder named
 * `<repo>-wt-<session>` (the session's worktree) maps to `<repo>`.
 */
export function locateFile(workspaceRoot: string, file: string, sessionName: string | null = null): FileLocation {
  const absolute = path.resolve(workspaceRoot, file);
  const rel = path.relative(workspaceRoot, absolute);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { solution: null, relative: absolute, worktree: false, outside: true };
  }
  const parts = rel.split(path.sep).filter(Boolean);
  const [first, second, third] = parts;
  const inside = (skip: number, solution: string, worktree: boolean): FileLocation => ({
    solution,
    relative: parts.slice(skip).join('/'),
    worktree,
    outside: false,
  });
  if (first && GROUP_FOLDERS.includes(first) && second && parts.length > 2) {
    const repo = stripWorktree(second, sessionName);
    return inside(2, repo.name, repo.worktree);
  }
  if (first === 'deprecated' && third && parts.length > 3) return inside(3, third, false);
  if ((first === 'mobile' || first === 'infrastructure') && parts.length > 1) return inside(1, first, false);
  if (first && parts.length > 1) {
    const repo = stripWorktree(first, sessionName);
    if (repo.worktree) return inside(1, repo.name, true);
  }
  return { solution: null, relative: parts.join('/'), worktree: false, outside: false };
}

/**
 * The workspace-relative folder of the solution a file belongs to (M4.3, the
 * agent card's path line; `docs/session-panel.md`), in the prototype's words:
 * `<group>/<repo>` for the grouping folders (`microfrontends/acme-app-front`),
 * `deprecated/<type>/<repo>`, and `<repo>/` for a repo at the root (`mobile/`,
 * `infrastructure/`). A file in the session's worktree (`<repo>-wt-<session>`,
 * gap #1) maps to its repo's folder. `null` for the workspace root itself and
 * for paths outside it (same rules as {@link locateFile}).
 */
export function solutionFolder(workspaceRoot: string, file: string, sessionName: string | null = null): string | null {
  const where = locateFile(workspaceRoot, file, sessionName);
  if (where.outside || where.solution === null) return null;
  const [first, second] = path.relative(workspaceRoot, path.resolve(workspaceRoot, file)).split(path.sep).filter(Boolean);
  if (first && GROUP_FOLDERS.includes(first)) return `${first}/${where.solution}`;
  if (first === 'deprecated' && second) return `deprecated/${second}/${where.solution}`;
  return `${where.solution}/`;
}

/**
 * Where a session works, for mapping the files it writes to solutions (D14): a
 * workspace session maps them with the router layout ({@link locateFile}); a repo
 * session's files all belong to its one solution, the repo, whether they are in
 * its worktree or in the main checkout.
 */
export interface SessionPlace {
  /** The session's folder, canonical: the workspace root or the repo. */
  readonly root: string;
  readonly kind: FolderKind;
  /** The process's working folder (relative paths resolve against it): the root, or a repo session's worktree. */
  readonly cwd: string;
}

/** A repo session's file (D14): in its worktree (the cwd, or the gap #1 `../{repo}-wt-{session}` folder) or in the repo, else outside. */
function locateRepoFile(place: SessionPlace, file: string, sessionName: string | null): FileLocation {
  const name = path.basename(place.root);
  const absolute = path.resolve(place.cwd, file);
  const worktrees = [place.cwd, ...(sessionName ? [path.join(path.dirname(place.root), `${name}-wt-${sessionName}`)] : [])].filter((dir) => dir !== place.root);
  const candidates: Array<readonly [string, boolean]> = [...worktrees.map((dir) => [dir, true] as const), [place.root, false] as const];
  for (const [dir, worktree] of candidates) {
    const rel = path.relative(dir, absolute);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    return { solution: name, relative: rel.split(path.sep).filter(Boolean).join('/'), worktree, outside: false };
  }
  return { solution: null, relative: absolute, worktree: false, outside: true };
}

/** {@link solutionFolder} for a session's place (D14): a repo folder's files are all in `<repo>/`. */
export function sessionSolutionFolder(place: SessionPlace, file: string, sessionName: string | null = null): string | null {
  if (place.kind === 'workspace') return solutionFolder(place.root, file, sessionName);
  if (place.kind === 'plain') return null;
  const where = locateRepoFile(place, file, sessionName);
  return where.solution === null ? null : `${where.solution}/`;
}

/** Splits a command line into statements of words (`&&`, `||`, `;`, `|` and newlines separate; quotes respected). */
export function splitStatements(command: string): string[][] {
  const statements: string[][] = [];
  let words: string[] = [];
  let word = '';
  let hasWord = false;
  let quote: '"' | "'" | null = null;
  const endWord = (): void => {
    if (hasWord) words.push(word);
    word = '';
    hasWord = false;
  };
  const endStatement = (): void => {
    endWord();
    if (words.length > 0) statements.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasWord = true;
    } else if (char === '\\' && i + 1 < command.length) {
      word += command[++i];
      hasWord = true;
    } else if (char === ' ' || char === '\t') {
      endWord();
    } else if (char === '\n' || char === ';') {
      endStatement();
    } else if (char === '&' || char === '|') {
      if (command[i + 1] === char) i++;
      endStatement();
    } else {
      word += char;
      hasWord = true;
    }
  }
  endStatement();
  return statements;
}

/**
 * D38: `true` when a Bash command adds a git worktree: it contains `git worktree
 * add`, or one of its statements is `git [-C <dir>] [-c <k=v>] [--opt] worktree add …`.
 */
export function addsWorktree(command: string): boolean {
  if (command.includes('git worktree add')) return true;
  return splitStatements(command).some((words) => {
    if (words[0] !== 'git') return false;
    let i = 1;
    while (i < words.length && (words[i] ?? '').startsWith('-')) i += words[i] === '-C' || words[i] === '-c' ? 2 : 1;
    return words[i] === 'worktree' && words[i + 1] === 'add';
  });
}
