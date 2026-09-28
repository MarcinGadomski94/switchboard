/**
 * Artifacts a session produces (decisions gap #9; `docs/derivations.md` →
 * *Artifacts*): PR (gh output / PR URLs), BRANCH, DIFF per solution + branch,
 * CONTRACT `contracts/*.md`, QA `coverage-matrix.md`, FOLLOWUP `mobile-followups/*`,
 * DOC any other written `.md`. TICKET is not auto-detected in v1.
 *
 * Paths are mapped to solutions with the workspace router's folder layout
 * (`docs/handoff/ARCHITECTURE.md` → *Workspace rules*); worktrees follow gap #1
 * (`../{repo}-wt-{session}`, a sibling of the repo).
 */
import path from 'node:path';
import type { ArtifactType } from '../model.ts';

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

/** The artifact type of a written file (by its path inside the solution), or `null` for none. */
export function fileArtifactType(relative: string): ArtifactType | null {
  const parts = relative.split('/').filter(Boolean);
  const base = parts.at(-1) ?? '';
  if (base === 'coverage-matrix.md') return 'QA';
  if (parts.slice(0, -1).includes('mobile-followups')) return 'FOLLOWUP';
  if (base.toLowerCase().endsWith('.md') && parts.at(-2) === 'contracts') return 'CONTRACT';
  if (base.toLowerCase().endsWith('.md')) return 'DOC';
  return null;
}

/** A GitHub pull request URL found in text. */
export interface PullRequestRef {
  readonly url: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

const PR_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g;

/** Every distinct GitHub PR URL in `text`, in order. */
export function findPullRequests(text: string): PullRequestRef[] {
  const seen = new Set<string>();
  const found: PullRequestRef[] = [];
  for (const match of text.matchAll(PR_URL)) {
    const [url, owner, repo, number] = match;
    if (!url || !owner || !repo || !number || seen.has(url)) continue;
    seen.add(url);
    found.push({ url, owner, repo, number: Number(number) });
  }
  return found;
}

/** `true` if a Bash command runs the GitHub CLI (`gh …`), whose output may carry PR URLs. */
export function runsGh(command: string): boolean {
  return splitStatements(command).some((words) => words[0] === 'gh');
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

/** A branch a command creates, and the folder it ran in when the command says so. */
export interface CreatedBranch {
  readonly branch: string;
  /** From a preceding `cd <dir>` or `git -C <dir>`; `null` when the command does not say. */
  readonly dir: string | null;
}

/**
 * Branches a Bash command creates: `git checkout -b|-B <name>`, `git switch -c|-C|--create <name>`,
 * `git worktree add … -b|-B <name> …` and `git branch <name>` (no options).
 */
export function createdBranches(command: string): CreatedBranch[] {
  const found: CreatedBranch[] = [];
  let cwd: string | null = null;
  for (const words of splitStatements(command)) {
    if (words[0] === 'cd' && words[1]) {
      cwd = cwd && !path.isAbsolute(words[1]) ? path.join(cwd, words[1]) : words[1];
      continue;
    }
    if (words[0] !== 'git') continue;
    let i = 1;
    let dir = cwd;
    while (words[i] === '-C' && words[i + 1]) {
      const target = words[i + 1] as string;
      dir = dir && !path.isAbsolute(target) ? path.join(dir, target) : target;
      i += 2;
    }
    const sub = words[i];
    const args = words.slice(i + 1);
    const after = (flags: readonly string[]): string | null => {
      const at = args.findIndex((arg) => flags.includes(arg));
      const value = at >= 0 ? args[at + 1] : undefined;
      return value && !value.startsWith('-') ? value : null;
    };
    let branch: string | null = null;
    if (sub === 'checkout') branch = after(['-b', '-B']);
    else if (sub === 'switch') branch = after(['-c', '-C', '--create', '--force-create']);
    else if (sub === 'worktree' && args[0] === 'add') branch = after(['-b', '-B']);
    else if (sub === 'branch' && args.length >= 1 && args.every((arg) => !arg.startsWith('-')) && args.length <= 2) branch = args[0] ?? null;
    if (branch) found.push({ branch, dir });
  }
  return found;
}

/** DIFF artifact name: the changed files' common folder inside the solution, then the file count ("Pages/FreeTalk · 6 files"). */
export function diffArtifactName(files: readonly string[]): string {
  const count = `${files.length} ${files.length === 1 ? 'file' : 'files'}`;
  const dirs = files.map((file) => file.split('/').filter(Boolean).slice(0, -1));
  let common = dirs[0] ?? [];
  for (const dir of dirs.slice(1)) {
    let n = 0;
    while (n < common.length && n < dir.length && common[n] === dir[n]) n++;
    common = common.slice(0, n);
  }
  return common.length > 0 ? `${common.join('/')} · ${count}` : count;
}
