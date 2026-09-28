/**
 * Pure rules of the worktree manager (M2.2; `docs/worktrees.md`): the gap #1
 * naming, which folders a solution name may be, parsing `git diff` output into
 * `FileDiff`s (gap #10), reading `gh pr view --json` and the gap #2 move message.
 * No processes, no file system: `src/server/worktrees/` runs git / gh.
 */
import path from 'node:path';
import type { FileDiff } from './api.ts';
import { GROUP_FOLDERS } from './derive/artifacts.ts';

/** Prefix of the branch every Switchboard worktree gets (gap #1). */
export const WORKTREE_BRANCH_PREFIX = 'session/';

/** Gap #1: the branch of a session's worktree, `session/{name}`. */
export function worktreeBranch(sessionName: string): string {
  return `${WORKTREE_BRANCH_PREFIX}${sessionName}`;
}

/** Gap #1: the worktree folder `../{repo}-wt-{name}`, a sibling of the repo's main checkout. */
export function worktreePath(repoPath: string, sessionName: string): string {
  return path.join(path.dirname(repoPath), `${path.basename(repoPath)}-wt-${sessionName}`);
}

/**
 * Folders a solution name can mean, in the workspace router's layout
 * (`docs/handoff/ARCHITECTURE.md` → *Workspace rules*): a relative path
 * (`other/switchboard`, `microfrontends/web-front`) is taken as is; a bare name is
 * `<root>/<name>` (e.g. `mobile`) or `<root>/<group>/<name>` for every grouping
 * folder. Read-only folders (`deprecated/`, `infrastructure/`) are never
 * candidates. Returns `null` for a name that is not inside the root.
 */
export function solutionCandidates(root: string, solution: string): string[] | null {
  const parts = solution.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 || parts.includes('..') || path.isAbsolute(solution) || /^[A-Za-z]:/.test(solution)) return null;
  const first = parts[0] as string;
  if (first === 'deprecated' || first === 'infrastructure') return [];
  if (parts.length > 1) return [path.join(root, ...parts)];
  return [path.join(root, first), ...GROUP_FOLDERS.map((group) => path.join(root, group, first))];
}

// ── git diff ─────────────────────────────────────────────────────────────

const C_ESCAPES: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' };

/**
 * Reads one path token of a git header line: a C-quoted `"…"` string (git quotes
 * names with control characters, `"` or `\`; non-ASCII stays raw with
 * `core.quotePath=false`) or plain text up to the end. Returns the path and the
 * rest of the line, or `null` when a quoted token is not closed.
 */
export function readGitPathToken(text: string): { value: string; rest: string } | null {
  if (!text.startsWith('"')) return { value: text, rest: '' };
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 1; i < text.length; i++) {
    const char = text[i] as string;
    if (char === '"') return { value: new TextDecoder().decode(new Uint8Array(bytes)), rest: text.slice(i + 1) };
    if (char === '\\' && i + 1 < text.length) {
      const next = text[i + 1] as string;
      if (/[0-7]/.test(next)) {
        const octal = /^[0-7]{1,3}/.exec(text.slice(i + 1))?.[0] ?? next;
        bytes.push(Number.parseInt(octal, 8) & 0xff);
        i += octal.length;
        continue;
      }
      bytes.push(...encoder.encode(C_ESCAPES[next] ?? next));
      i += 1;
      continue;
    }
    bytes.push(...encoder.encode(char));
  }
  return null;
}

function stripPrefix(name: string, prefix: 'a/' | 'b/'): string | null {
  return name.startsWith(prefix) ? name.slice(prefix.length) : null;
}

/** The file path of one `diff --git` section (no renames: both sides name the same file). */
function sectionPath(header: readonly string[]): string | null {
  for (const line of header) {
    if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
      const token = readGitPathToken(line.slice(4).replace(/\t$/, ''));
      const name = token ? stripPrefix(token.value, 'b/') : null;
      if (name !== null) return name;
    }
  }
  for (const line of header) {
    if (line.startsWith('--- ') && line !== '--- /dev/null') {
      const token = readGitPathToken(line.slice(4).replace(/\t$/, ''));
      const name = token ? stripPrefix(token.value, 'a/') : null;
      if (name !== null) return name;
    }
  }
  const first = header[0] ?? '';
  const rest = first.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    const token = readGitPathToken(rest);
    return token ? stripPrefix(token.value, 'a/') : null;
  }
  // Unquoted `a/<p> b/<p>`: the same path twice, so its length is fixed.
  if ((rest.length - 5) % 2 !== 0 || rest.length < 7) return null;
  const length = (rest.length - 5) / 2;
  const name = rest.slice(2, 2 + length);
  return rest === `a/${name} b/${name}` ? name : null;
}

/** One file of a parsed patch. */
export interface PatchFile {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  /** Hunk body lines, each starting with `+`, `-` or a space (hunk headers dropped). */
  readonly lines: string[];
  readonly binary: boolean;
}

/**
 * Parses the output of `git diff --no-renames --src-prefix=a/ --dst-prefix=b/`
 * into one entry per file. `@@` hunk headers and `\ No newline at end of file`
 * markers are dropped (the `FileDiff.lines` shape), a trailing `\r` is cut, and
 * binary files have no lines. Sections whose path cannot be read are skipped.
 */
export function parsePatch(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let section: string[] | null = null;
  const flush = (): void => {
    if (!section) return;
    const firstHunk = section.findIndex((line) => line.startsWith('@@'));
    const header = firstHunk === -1 ? section : section.slice(0, firstHunk);
    const file = sectionPath(header);
    if (file !== null) {
      const body: string[] = [];
      let added = 0;
      let removed = 0;
      if (firstHunk !== -1) {
        for (const raw of section.slice(firstHunk)) {
          if (raw.startsWith('@@') || raw.startsWith('\\')) continue;
          const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
          const mark = line[0];
          if (mark === '+') added++;
          else if (mark === '-') removed++;
          else if (mark !== ' ' && line !== '') continue;
          body.push(line === '' ? ' ' : line);
        }
      }
      const binary = header.some((line) => line.startsWith('Binary files ') || line === 'GIT binary patch');
      files.push({ path: file, added, removed, lines: body, binary });
    }
    section = null;
  };
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      section = [line];
    } else if (section) {
      section.push(line);
    }
  }
  flush();
  return files;
}

/** `true` when the bytes look binary (a NUL byte in the first 8000, git's own rule). */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8000);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

/** A new, untracked text file as a diff: every line added. Binary content has no lines. */
export function untrackedFileDiff(filePath: string, bytes: Uint8Array): PatchFile {
  if (looksBinary(bytes)) return { path: filePath, added: 0, removed: 0, lines: [], binary: true };
  const text = new TextDecoder().decode(bytes);
  if (text === '') return { path: filePath, added: 0, removed: 0, lines: [], binary: false };
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const body = lines.map((line) => `+${line.endsWith('\r') ? line.slice(0, -1) : line}`);
  return { path: filePath, added: body.length, removed: 0, lines: body, binary: false };
}

/** Splits `git ls-files -z` output into paths, dropping folders (a nested repo shows as `dir/`). */
export function splitNulList(text: string): string[] {
  return text.split('\0').filter((entry) => entry !== '' && !entry.endsWith('/'));
}

/** A parsed file as the API's `FileDiff`; `uncommitted` = the working tree still changes it (see `FileDiff.uncommitted`). */
export function toFileDiff(solution: string, branch: string | null, file: PatchFile, uncommitted: boolean): FileDiff {
  return { solution, path: file.path, branch, added: file.added, removed: file.removed, lines: file.lines, uncommitted };
}

// ── gh ───────────────────────────────────────────────────────────────────

/** The fields Switchboard asks `gh pr view --json` for. */
export const PR_VIEW_FIELDS = 'number,state,url,headRefOid';

/** A pull request as `gh pr view --json number,state,url,headRefOid` prints it. */
export interface PullRequestInfo {
  readonly number: number;
  /** Verbatim: `OPEN`, `CLOSED`, `MERGED`. */
  readonly state: string;
  readonly url: string | null;
  readonly headRefOid: string | null;
}

/** Reads `gh pr view --json` output; `null` when it is not the expected shape. */
export function parsePullRequest(stdout: string): PullRequestInfo | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const number = record['number'];
  const state = record['state'];
  if (typeof number !== 'number' || !Number.isInteger(number) || typeof state !== 'string' || state === '') return null;
  const url = typeof record['url'] === 'string' ? record['url'] : null;
  const oid = typeof record['headRefOid'] === 'string' && /^[0-9a-f]{7,64}$/i.test(record['headRefOid']) ? record['headRefOid'] : null;
  return { number, state, url, headRefOid: oid };
}

/** `true` when gh's stderr says the branch has no pull request (gh exits 1 then). */
export function isNoPullRequest(stderr: string): boolean {
  return /no pull requests? found/i.test(stderr);
}

// ── gap #2 ───────────────────────────────────────────────────────────────

/** What the move message names. */
export interface MoveMessageInput {
  readonly repo: string;
  readonly repoPath: string;
  readonly worktreePath: string;
  readonly branch: string;
  /** The base branch (or commit) the worktree branch was created from. */
  readonly base: string;
}

/**
 * The user message a session gets when Switchboard moves it into a worktree
 * (gap #2: create the worktree, then pause + resume with this message). It never
 * asks the agent to stash, reset or check out the developer's tree.
 */
export function moveToWorktreeMessage(input: MoveMessageInput): string {
  return [
    `Switchboard moved your work on ${input.repo} into its own git worktree, so your changes stay separate from other work in that repo.`,
    `From now on, make every change to ${input.repo} in ${input.worktreePath} (branch ${input.branch}, created from the current commit of ${input.base}). Do not edit files in ${input.repoPath} any more.`,
    `Anything you already changed in ${input.repoPath} was left where it is. Re-apply the changes you still need inside the worktree, for example by copying the files you edited. Do not stash, reset or check out anything in ${input.repoPath}: that working tree belongs to the developer.`,
  ].join('\n\n');
}
