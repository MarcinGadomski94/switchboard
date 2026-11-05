/**
 * D152 follow-up 2026-11-05 (`docs/worktrees.md` → *Which repositories* → *Works in*):
 * the paths a session's tool calls **read** or **ran commands in**, so "Works in"
 * also answers for a workspace agent that mostly read files and ran shell commands
 * inside one repo (it edited nothing there). Pure: no file system; the server maps
 * each path to the git working tree that holds it (`src/server/worktrees/works-in.ts`).
 *
 * Conservative on purpose: only paths a call names outright count (a Read's
 * `file_path`, a Grep / Glob / LS `path`, the static part of an absolute Glob
 * pattern, a Bash command's `cd <dir>` / `pushd <dir>` / `git -C <dir>` and its
 * absolute path words), plus the absolute paths a Glob / Grep result lists line
 * by line. Relative paths are resolved against the command's own `cd` (within
 * one command) and the session's working folder; `~`, variables (`$HOME`) and
 * command substitution are never guessed. The server keeps only paths under the
 * session's folder or its worktrees.
 */

/** What a repo of "Works in" was seen through. */
export type WorksInEvidenceKind = 'edited' | 'read' | 'commands';

/** The tools whose input names a path the agent read. */
export const READ_TOOLS: readonly string[] = ['Read', 'NotebookRead', 'Grep', 'Glob', 'LS'];

/** The tools whose input is a shell command. */
export const COMMAND_TOOLS: readonly string[] = ['Bash', 'PowerShell'];

/** At most this many paths are taken from one tool result (a Glob / Grep listing). */
export const RESULT_PATHS_MAX = 20;

/** One path a tool call names, and how. */
export interface EvidencePath {
  readonly path: string;
  readonly kind: WorksInEvidenceKind;
  /**
   * D152 follow-up (outside repos): a command **worked in** this folder (a `cd` /
   * `pushd` / `Set-Location` target, a `git -C` folder, a Codex command's own
   * `cwd`), not just named a path in it. Only these count outside the session's
   * folder (an absolute path word or a read there does not).
   */
  readonly workedIn?: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `true` for an absolute POSIX path, a Windows drive path (`C:\…`, `C:/…`) or a UNC path. */
export function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

/**
 * `relative` joined onto `base` with `.` / `..` resolved, in `base`'s style (a
 * Windows base keeps `\`); an absolute `relative` is normalized alone. `null` when
 * it cannot be resolved (no base, `~`, a variable).
 */
export function joinEvidencePath(base: string | null, relative: string): string | null {
  if (relative === '' || relative.startsWith('~') || relative.includes('$') || relative.includes('`')) return null;
  const absolute = isAbsolutePath(relative);
  if (!absolute && (base === null || !isAbsolutePath(base))) return null;
  const whole = absolute ? relative : `${base}/${relative}`;
  const windows = isWindowsPath(whole);
  const sep = windows ? '\\' : '/';
  const unc = whole.startsWith('\\\\');
  const drive = /^[A-Za-z]:/.exec(whole)?.[0] ?? '';
  const rest = unc ? whole.slice(2) : whole.slice(drive.length);
  const parts: string[] = [];
  for (const part of rest.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  if (unc) return `\\\\${parts.join(sep)}`;
  return `${drive}${sep}${parts.join(sep)}`;
}

/** The static folder part of a glob pattern (`/a/b/**\/*.ts` → `/a/b`), `null` when nothing static is left. */
function globBase(pattern: string): string | null {
  const at = pattern.search(/[*?[{]/);
  const fixed = at < 0 ? pattern : pattern.slice(0, at);
  const cut = Math.max(fixed.lastIndexOf('/'), fixed.lastIndexOf('\\'));
  if (at < 0) return pattern;
  if (cut <= 0) return null;
  return fixed.slice(0, cut);
}

/** The paths a read tool's input names (absolute, or resolved against `cwd`). */
export function readToolPaths(name: string, input: unknown, cwd: string | null): string[] {
  if (!isRecord(input)) return [];
  const raw: string[] = [];
  const str = (key: string): string | null => (typeof input[key] === 'string' && input[key] !== '' ? (input[key] as string) : null);
  if (name === 'Read') raw.push(...[str('file_path')].filter((value): value is string => value !== null));
  else if (name === 'NotebookRead') raw.push(...[str('notebook_path')].filter((value): value is string => value !== null));
  else if (name === 'Grep' || name === 'LS') raw.push(...[str('path')].filter((value): value is string => value !== null));
  else if (name === 'Glob') {
    const where = str('path');
    if (where !== null) raw.push(where);
    const pattern = str('pattern');
    if (pattern !== null && isAbsolutePath(pattern)) {
      const base = globBase(pattern);
      if (base !== null) raw.push(base);
    }
  }
  return unique(raw.map((value) => joinEvidencePath(cwd, value)).filter((value): value is string => value !== null));
}

/**
 * The absolute paths a Glob / Grep result lists (one per line, as Grep's
 * `files_with_matches` and Glob print them; a `path:line:` prefix is cut), at most
 * {@link RESULT_PATHS_MAX}. Other tools' results are not read.
 */
export function resultPaths(name: string, result: unknown): string[] {
  if ((name !== 'Glob' && name !== 'Grep') || typeof result !== 'string') return [];
  const out: string[] = [];
  for (const line of result.split(/\r?\n/, 200)) {
    const text = line.trim();
    if (!isAbsolutePath(text)) continue;
    // `path:12:match` (Grep's content mode): keep the path (a drive letter's colon is not a separator).
    const colon = text.indexOf(':', isWindowsPath(text) ? 2 : 0);
    const file = colon > 0 ? text.slice(0, colon) : text;
    const joined = joinEvidencePath(null, file);
    if (joined !== null) out.push(joined);
    if (out.length >= RESULT_PATHS_MAX) break;
  }
  return unique(out);
}

/**
 * A command line split into statements of words (`&&`, `||`, `;`, `|` and new
 * lines separate). Quotes as bash reads them: single quotes keep everything, a
 * double-quoted `\` only escapes `$ \` " \``; unquoted, `\` escapes the next
 * character except in a word that started as a Windows path (`D:\code`), which an
 * agent on Windows writes for PowerShell. A redirection's target is dropped.
 */
export function commandStatements(command: string): string[][] {
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
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '\\' && /[$`"\\]/.test(command[i + 1] ?? '')) word += command[++i];
      else word += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasWord = true;
    } else if (char === '\\' && i + 1 < command.length) {
      if (/^[A-Za-z]:/.test(word) || (word === '' && command[i + 1] === '\\')) word += char;
      else if (command[i + 1] === '\n') i++;
      else word += command[++i];
      hasWord = true;
    } else if (char === ' ' || char === '\t') {
      endWord();
    } else if (char === '\n' || char === ';') {
      endStatement();
    } else if (char === '&' || char === '|') {
      if (command[i + 1] === char) i++;
      endStatement();
    } else if (char === '(' || char === ')') {
      endWord();
    } else {
      word += char;
      hasWord = true;
    }
  }
  endStatement();
  return statements.map((statement) => statement.filter((entry, at) => !/^\d*[<>]/.test(entry) && !/^\d*[<>]/.test(statement[at - 1] ?? 'x')));
}

const CD_COMMANDS = new Set(['cd', 'pushd', 'Set-Location', 'sl', 'Push-Location', 'chdir']);

/**
 * The folders and paths a shell command works in: each `cd` / `pushd` /
 * `Set-Location` target (later relative paths resolve against it, within this
 * command only), each `git -C <dir>`, and every absolute path word (also as a
 * `--flag=/path` value). `cwd`: where the command started (the session's folder,
 * or a Codex command's own `cwd`).
 */
export function commandPaths(command: string, cwd: string | null): string[] {
  const out: string[] = [];
  let here = cwd;
  for (const words of commandStatements(command)) {
    const first = words[0] ?? '';
    if (CD_COMMANDS.has(first)) {
      const args = words.slice(1).filter((word, at, all) => !word.startsWith('-') || (at > 0 && /^-(?:Path|LiteralPath)$/i.test(all[at - 1] ?? '')));
      const target = args.find((word) => !/^-/.test(word));
      // A bare `cd` goes home (never guessed): later relative paths are unknown.
      if (target === undefined) here = null;
      else {
        const next = joinEvidencePath(here, target);
        if (next !== null) {
          here = next;
          out.push(next);
        } else {
          // An unresolvable cd (`cd ~/x`, `cd $DIR`): later relative paths are unknown.
          here = null;
        }
      }
      continue;
    }
    for (let i = 0; i < words.length; i++) {
      const word = words[i] as string;
      if (word === '-C' && (words[i - 1] === 'git' || (i > 0 && words.slice(0, i).includes('git')))) {
        const dir = words[i + 1];
        if (dir !== undefined) {
          const joined = joinEvidencePath(here, dir);
          if (joined !== null) out.push(joined);
        }
        i++;
        continue;
      }
      const value = /^--?[A-Za-z][\w-]*=(.+)$/.exec(word)?.[1] ?? word;
      if (isAbsolutePath(value)) {
        const joined = joinEvidencePath(null, value);
        if (joined !== null) out.push(joined);
      }
    }
    // The statement ran in `here`: it counts as a command there.
    if (here !== null && here !== cwd) out.push(here);
  }
  return unique(out);
}

/**
 * The folders a shell command **worked in** (a subset of {@link commandPaths}): each
 * `cd` / `pushd` / `Set-Location` target and each `git -C <dir>`, resolved the same
 * way. Absolute path words are not in it.
 */
export function commandWorkPaths(command: string, cwd: string | null): string[] {
  const out: string[] = [];
  let here = cwd;
  for (const words of commandStatements(command)) {
    const first = words[0] ?? '';
    if (CD_COMMANDS.has(first)) {
      const args = words.slice(1).filter((word, at, all) => !word.startsWith('-') || (at > 0 && /^-(?:Path|LiteralPath)$/i.test(all[at - 1] ?? '')));
      const target = args.find((word) => !/^-/.test(word));
      const next = target === undefined ? null : joinEvidencePath(here, target);
      here = next;
      if (next !== null) out.push(next);
      continue;
    }
    for (let i = 0; i < words.length; i++) {
      if (words[i] === '-C' && words.slice(0, i).includes('git')) {
        const dir = words[i + 1];
        const joined = dir === undefined ? null : joinEvidencePath(here, dir);
        if (joined !== null) out.push(joined);
        i++;
      }
    }
  }
  return unique(out);
}

/** The paths one tool event names, each with its kind (edits are read elsewhere: `SessionRepos`). */
export function evidencePaths(payload: unknown, cwd: string | null): EvidencePath[] {
  if (!isRecord(payload) || payload['type'] !== 'tool') return [];
  const name = typeof payload['name'] === 'string' ? payload['name'] : '';
  const input = isRecord(payload['input']) ? payload['input'] : {};
  if (READ_TOOLS.includes(name)) {
    const paths = [...readToolPaths(name, input, cwd), ...(payload['isError'] === true ? [] : resultPaths(name, payload['result']))];
    return unique(paths).map((path) => ({ path, kind: 'read' }));
  }
  if (COMMAND_TOOLS.includes(name) && typeof input['command'] === 'string') {
    const own = typeof input['cwd'] === 'string' && isAbsolutePath(input['cwd']) ? input['cwd'] : cwd;
    const paths = commandPaths(input['command'], own);
    const worked = new Set(commandWorkPaths(input['command'], own));
    if (own !== null && own !== cwd) {
      paths.push(own);
      worked.add(own);
    }
    return unique(paths).map((path): EvidencePath => (worked.has(path) ? { path, kind: 'commands', workedIn: true } : { path, kind: 'commands' }));
  }
  return [];
}

/** How much one call of each kind weighs in the ranking: an edit says more than a read or a command. */
export const EVIDENCE_WEIGHT: Readonly<Record<WorksInEvidenceKind, number>> = { edited: 10, commands: 2, read: 1 };

/** The evidence counted for one repo. */
export interface EvidenceCounts {
  readonly edited: number;
  readonly read: number;
  readonly commands: number;
}

/** A repo's evidence score ({@link EVIDENCE_WEIGHT} per call; a declared solution or a worktree counts as an edit). */
export function evidenceScore(counts: EvidenceCounts, declared = false): number {
  return (declared ? EVIDENCE_WEIGHT.edited : 0) + counts.edited * EVIDENCE_WEIGHT.edited + counts.read * EVIDENCE_WEIGHT.read + counts.commands * EVIDENCE_WEIGHT.commands;
}

/** The evidence kinds present in `counts`, strongest first. */
export function evidenceKinds(counts: EvidenceCounts): WorksInEvidenceKind[] {
  return (['edited', 'commands', 'read'] as const).filter((kind) => counts[kind] > 0);
}

/**
 * Ranks repos: worktrees first (the separate copies are certain), then by
 * {@link evidenceScore}, ties in the order they were found.
 */
export function rankByEvidence<T extends { readonly isWorktree: boolean; readonly declared: boolean; readonly counts: EvidenceCounts }>(repos: readonly T[]): T[] {
  return repos
    .map((repo, at) => ({ repo, at, score: evidenceScore(repo.counts, repo.declared) }))
    .sort((a, b) => Number(b.repo.isWorktree) - Number(a.repo.isWorktree) || b.score - a.score || a.at - b.at)
    .map((entry) => entry.repo);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
