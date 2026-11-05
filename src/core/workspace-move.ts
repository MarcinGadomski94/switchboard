import { scrubCredentials } from './takeover.ts';

/**
 * D152 (`docs/peers.md` → *A complete move (D152)*): the pure part of moving a
 * workspace session (or a whole crew) to another computer in one go: the
 * workspace's own non-git files (which ones may be copied, which look like they
 * hold a secret), the workspace root the developer creates on the target, the
 * target's paths written the target's way (a Windows PC's `D:\code\ws` from a
 * Mac), and which repos an agent works in. No file system, no network: shared
 * by the server (`src/server/takeover/workspace.ts`) and the UI.
 */

// ── limits ─────────────────────────────────────────────────────────────────

/** Largest workspace file that is copied (1 MB). */
export const WORKSPACE_FILE_MAX_BYTES = 1024 * 1024;

/** Most bytes one move copies in workspace files (20 MB). */
export const WORKSPACE_FILES_MAX_TOTAL = 20 * 1024 * 1024;

/** A binary file (a NUL byte in its first 8 KB) is copied only up to this size (256 KB). */
export const WORKSPACE_BINARY_MAX_BYTES = 256 * 1024;

/** Most files one move lists and copies. */
export const WORKSPACE_FILES_MAX_COUNT = 300;

/** How deep below the workspace root files are listed. */
export const WORKSPACE_WALK_MAX_DEPTH = 6;

/** Most folder entries one listing visits (an 80 GB workspace stays cheap: its repos are never entered). */
export const WORKSPACE_WALK_MAX_ENTRIES = 5000;

/** Folders never listed (beside every git working tree, which is a repo's, not the workspace's). */
export const WORKSPACE_SKIPPED_DIRS: ReadonlySet<string> = new Set(['.git', '.worktrees', 'node_modules', '.idea', '.vs', '.cache', 'bin', 'obj', 'dist', 'build', '.terraform']);

/** Files never listed (the OS's own). */
export const WORKSPACE_SKIPPED_FILES: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

// ── the workspace's own files ─────────────────────────────────────────────

/** One regular file under the workspace root and outside every repo, as the source lists it. */
export interface WorkspaceFileInfo {
  /** Relative to the workspace root, `/`-separated (`AGENTS.md`, `.claude/settings.local.json`, `docs/plan.md`). */
  readonly name: string;
  readonly size: number;
  /** Hex sha256 of the file; `null` when it cannot be copied (too large). */
  readonly sha256: string | null;
  /** Why it looks like it holds a secret (marked and unticked by default); `null` when it does not. Never the value. */
  readonly secret: string | null;
  /** A NUL byte in its first 8 KB. */
  readonly binary: boolean;
  /** Why it cannot be copied (over a cap); `null` when it can. */
  readonly refused: string | null;
}

/** The source's listing of a workspace's own files (`SourceInspect.workspaceFiles`). */
export interface WorkspaceFilesListing {
  /** The workspace root on the source. */
  readonly root: string;
  readonly files: readonly WorkspaceFileInfo[];
  /** The listing stopped at a cap (files, entries, depth): more files may exist. */
  readonly truncated: boolean;
}

/** What is at a workspace file's path on the target. */
export type WorkspaceFileTargetState = 'new' | 'same' | 'conflict' | 'refused';

/** The target's view of one workspace file (`TargetPlan.workspaceFiles`). */
export interface WorkspaceFileTarget {
  readonly name: string;
  /** `new` = copied; `same` = already there with the same content (skipped); `conflict` = a different file (or a link, a folder) is there: never overwritten, skipped; `refused` = the name cannot be written there. */
  readonly state: WorkspaceFileTargetState;
  readonly reason: string | null;
}

/** Which workspace files a move copies (the dialog's ticks). Absent = none. */
export interface WorkspaceFileChoice {
  /** Names from {@link WorkspaceFilesListing.files}. */
  readonly copy: readonly string[];
  /** The developer confirmed copying the ticked files that are marked secret ("Copy after confirming"). */
  readonly confirmSecrets?: boolean;
}

/** What a move did with the workspace files on the target (the apply's answer, the run's detail). */
export interface WorkspaceFilesResult {
  readonly copied: readonly string[];
  readonly same: readonly string[];
  /** A different file was there: skipped, never overwritten. */
  readonly conflicts: readonly string[];
  readonly refused: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
  /** How many of {@link copied} were marked secret (and confirmed). */
  readonly secret: number;
}

/** Names that look like they hold secrets (D152: marked, unticked by default). */
const SECRET_NAME_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:^|\/)\.env(?:\..*)?$/i,
  /(?:^|\/)[^/]*\.local\.json$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/i,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)[^/]*$/i,
  /(?:^|\/)(?:credentials|secrets?)(?:\.[^/]*)?$/i,
  /(?:^|\/)\.(?:npmrc|netrc|pgpass|pypirc|git-credentials)$/i,
];

/** A key name that says it holds a credential. */
const SECRET_KEY = String.raw`[\w.-]*(?:token|secret|password|passwd|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credential|auth)[\w.-]*`;
/** `KEY = value`, `"key": "value"`, `key: value` with a value that looks like a credential (12+ token characters). */
const SECRET_ASSIGNMENT = new RegExp(String.raw`(?:^|[\s{,"'])${SECRET_KEY}["']?\s*[:=]\s*["']?[A-Za-z0-9_\-+/=.~]{12,}`, 'im');
/** A private key block, and tokens with well-known shapes. */
const SECRET_SHAPES: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
];
/** A JSON `"env": { "KEY": "value" }` block (Claude Code's settings files keep tokens there). */
const ENV_BLOCK = /"env"\s*:\s*\{\s*"[A-Za-z_][\w]*"\s*:\s*"[^"]+"/;

/** Why `name` looks like a secrets file, `null` when it does not. */
export function secretByName(name: string): string | null {
  return SECRET_NAME_PATTERNS.some((pattern) => pattern.test(name)) ? 'named like a file that holds secrets' : null;
}

/** Why a text looks like it holds a secret (never the value), `null` when it does not. */
export function secretByContent(text: string): string | null {
  if (SECRET_SHAPES.some((pattern) => pattern.test(text))) return 'holds a private key or a token';
  if (ENV_BLOCK.test(text)) return 'holds environment values (an "env" block)';
  if (SECRET_ASSIGNMENT.test(text)) return 'holds token-like keys';
  if (scrubCredentials(text) !== text) return 'holds a URL with credentials';
  return null;
}

/**
 * Why a workspace file looks like it holds a secret: its name, else its text
 * (`content` `null` for a binary or unread file). `null` = it does not.
 */
export function looksSecret(name: string, content: string | null): string | null {
  return secretByName(name) ?? (content === null ? null : secretByContent(content));
}

/**
 * `true` for a workspace file name the receiving machine may write under the
 * workspace root: relative, `/`-separated, no `.` / `..` / empty segment, no
 * backslash, drive, colon (a Windows alternate stream), NUL or control
 * character, no `.git` segment, at most 400 characters.
 */
export function isSafeWorkspaceFileName(name: unknown): name is string {
  if (typeof name !== 'string' || name === '' || name.length > 400) return false;
  if (/[\x00-\x1f\\:*?"<>|]/.test(name) || name.startsWith('/')) return false;
  const segments = name.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment.toLowerCase() !== '.git' && !/[. ]$/.test(segment));
}

/** Whether a listed file is ticked when the dialog opens: copyable and not marked secret. */
export function defaultTicked(file: Pick<WorkspaceFileInfo, 'refused' | 'secret'>, target?: Pick<WorkspaceFileTarget, 'state'> | null): boolean {
  if (file.refused !== null || file.secret !== null) return false;
  return !target || target.state === 'new';
}

/** The default choice of a listing: every copyable file that is not marked secret and is new on the target. */
export function defaultChoice(listing: WorkspaceFilesListing | null | undefined, targets: readonly WorkspaceFileTarget[] | null | undefined): WorkspaceFileChoice {
  const byName = new Map((targets ?? []).map((entry) => [entry.name, entry]));
  return { copy: (listing?.files ?? []).filter((file) => defaultTicked(file, byName.get(file.name) ?? null)).map((file) => file.name), confirmSecrets: false };
}

/**
 * Why a choice of workspace files cannot be copied as it is (`null` = it can):
 * a name the source did not list, a file over a cap, a ticked secret without the
 * confirmation, too many files or bytes. A conflict or a same file is not a
 * problem: it is skipped and reported.
 */
export function fileChoiceProblem(listing: WorkspaceFilesListing | null | undefined, choice: WorkspaceFileChoice | null | undefined): string | null {
  if (!choice || choice.copy.length === 0) return null;
  const files = new Map((listing?.files ?? []).map((file) => [file.name, file]));
  let bytes = 0;
  const secrets: string[] = [];
  for (const name of new Set(choice.copy)) {
    const file = files.get(name);
    if (!file) return `${name} is not one of the workspace's files on the source`;
    if (file.refused !== null) return `${name} cannot be copied: ${file.refused}`;
    if (file.secret !== null) secrets.push(name);
    bytes += file.size;
  }
  if (new Set(choice.copy).size > WORKSPACE_FILES_MAX_COUNT) return `at most ${WORKSPACE_FILES_MAX_COUNT} workspace files are copied in one move`;
  if (bytes > WORKSPACE_FILES_MAX_TOTAL) return `the ticked workspace files are ${formatBytes(bytes)}: at most ${formatBytes(WORKSPACE_FILES_MAX_TOTAL)} are copied in one move`;
  if (secrets.length > 0 && choice.confirmSecrets !== true) {
    return `${secrets.length === 1 ? `${secrets[0]} looks like it holds secrets` : `${secrets.length} ticked files look like they hold secrets`}: confirm copying ${secrets.length === 1 ? 'it' : 'them'} first`;
  }
  return null;
}

/** `1.2 MB`, `340 KB`, `12 B`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** The audit line of a copy (never a name or a value): "copied 3 workspace files (1 marked secret) to PC". */
export function workspaceCopyAudit(copied: number, secret: number, target: string): string {
  return `copied ${copied} workspace file${copied === 1 ? '' : 's'} (${secret} marked secret) to ${target}`;
}

// ── the workspace root created on the target ──────────────────────────────

/** D152: create the workspace root at a folder the developer picks on the target (`TargetPlacement.newWorkspace`). */
export interface NewWorkspace {
  /** The full path on the target (a parent the developer picked + the new folder's name, or a typed path that does not exist yet). */
  readonly path: string;
  /** The developer confirmed using an existing folder that is not empty. */
  readonly useExisting?: boolean;
}

/** The target's check of {@link NewWorkspace} (`TargetPlan.workspaceRoot`). */
export interface WorkspaceRootCheck {
  /** The final path (an existing part resolved to its real path). */
  readonly path: string;
  readonly exists: boolean;
  /** Exists and holds nothing. */
  readonly empty: boolean;
  /** Exists and is a workspace already (its router `AGENTS.md`). */
  readonly workspace: boolean;
  /** An existing non-empty folder that still needs the developer's confirmation. */
  readonly needsConfirm: boolean;
  readonly ok: boolean;
  /** Why it cannot be used (or what needs confirming); `null` when it can. */
  readonly reason: string | null;
}

/** The target's way of writing paths: a drive letter or a UNC path, or a path with only backslashes, is Windows. */
export function pathStyleOf(value: string): 'windows' | 'posix' {
  if (/^[A-Za-z]:([\\/]|$)/.test(value) || value.startsWith('\\\\')) return 'windows';
  return value.includes('\\') && !value.includes('/') ? 'windows' : 'posix';
}

/** `true` for an absolute path on either kind of machine (`/x`, `C:\x`, `C:/x`, `\\server\share`). */
export function isAbsoluteTargetPath(value: string): boolean {
  const text = value.trim();
  return text.startsWith('/') || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\') || text === '~' || text.startsWith('~/');
}

/** `parent` + `segments` written the way `parent` is (`D:\code` + `ws` → `D:\code\ws`; `/Users/x` + `a/b` → `/Users/x/a/b`). */
export function joinTargetPath(parent: string, ...segments: readonly string[]): string {
  const style = pathStyleOf(parent);
  const separator = style === 'windows' ? '\\' : '/';
  const parts = segments.flatMap((segment) => segment.split(/[\\/]+/)).filter((part) => part !== '' && part !== '.');
  const base = parent.replace(/[\\/]+$/, '');
  // A drive root keeps its separator (`D:` + `x` → `D:\x`), the POSIX root too.
  const head = base === '' ? (style === 'windows' ? '' : '') : base;
  return parts.length === 0 ? parent : `${head}${separator}${parts.join(separator)}`;
}

/** The last segment of a target path. */
export function targetBaseName(value: string): string {
  const parts = value.split(/[\\/]+/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? '';
}

/** The parent of a target path (`D:\code\ws` → `D:\code`; a root stays itself). */
export function targetParent(value: string): string {
  const style = pathStyleOf(value);
  const trimmed = value.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (cut < 0) return value;
  const head = trimmed.slice(0, cut);
  if (head === '') return '/';
  if (style === 'windows' && /^[A-Za-z]:$/.test(head)) return `${head}\\`;
  return head;
}

/**
 * Two target paths name the same folder: separators and a trailing one ignored,
 * and on a Windows path the case (`D:\Code\WS` = `d:/code/ws`). POSIX paths keep their case.
 */
export function sameTargetPath(a: string, b: string): boolean {
  const norm = (value: string): string => {
    const text = value.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    return pathStyleOf(value) === 'windows' ? text.toLowerCase() : text;
  };
  return norm(a) === norm(b);
}

/**
 * `child` relative to `root` as `/`-separated segments, or `null` when it is not
 * inside (Windows paths compared without case). Used to show and keep a repo's
 * place inside the new workspace root.
 */
export function relativeInside(root: string, child: string): string[] | null {
  const windows = pathStyleOf(root) === 'windows' || pathStyleOf(child) === 'windows';
  const split = (value: string): string[] => value.split(/[\\/]+/).filter((part) => part !== '' && part !== '.');
  const base = split(root);
  const full = split(child);
  if (full.length < base.length) return null;
  for (let i = 0; i < base.length; i++) {
    const x = base[i] as string;
    const y = full[i] as string;
    if (windows ? x.toLowerCase() !== y.toLowerCase() : x !== y) return null;
  }
  const rest = full.slice(base.length);
  return rest.includes('..') ? null : rest;
}

/** Characters a Windows folder name may not have (and `/`, `\` everywhere). */
const BAD_NAME = /[<>:"/\\|?*\x00-\x1f]/;
/** Names Windows reserves for devices. */
const RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

/** Why `name` cannot be the new workspace folder's name (`null` = it can). Checked for Windows' rules on every machine: a name that works on both. */
export function folderNameProblem(name: string): string | null {
  const value = name.trim();
  if (value === '') return 'type the new folder’s name';
  if (value === '.' || value === '..') return 'the name cannot be . or ..';
  if (BAD_NAME.test(value)) return 'the name cannot hold / \\ : * ? " < > |';
  if (RESERVED.test(value)) return `${value} is a name Windows reserves`;
  if (/[. ]$/.test(value)) return 'the name cannot end with a dot or a space';
  if (value.length > 120) return 'the name is too long';
  return null;
}

/**
 * The new workspace root from what the dialog holds: a parent folder + a name, or
 * a full path typed as is. `null` with the problem when it is not usable yet.
 */
export function newWorkspacePath(input: { readonly parent: string; readonly name: string } | { readonly full: string }): { readonly path: string; readonly problem: null } | { readonly path: null; readonly problem: string } {
  if ('full' in input) {
    const value = input.full.trim();
    if (value === '') return { path: null, problem: 'type the folder’s full path on the target' };
    if (!isAbsoluteTargetPath(value)) return { path: null, problem: `${value} is not a full path (like D:\\code\\workspace or /Users/me/workspace)` };
    return { path: value, problem: null };
  }
  const parent = input.parent.trim();
  if (parent === '') return { path: null, problem: 'pick the folder to create it in' };
  if (!isAbsoluteTargetPath(parent)) return { path: null, problem: `${parent} is not a full path` };
  const problem = folderNameProblem(input.name);
  if (problem !== null) return { path: null, problem };
  return { path: joinTargetPath(parent, input.name.trim()), problem: null };
}

/**
 * The suggested parent of a new workspace root on the target (only pre-filled,
 * never applied by itself): the parent of its first saved workspace, else of its
 * first saved folder, else its home folder.
 */
export function suggestWorkspaceParent(places: ReadonlyArray<{ readonly path: string; readonly kind: string }>): string | null {
  const workspace = places.find((place) => place.kind === 'workspace');
  if (workspace) return targetParent(workspace.path);
  const saved = places.find((place) => place.kind === 'repo' || place.kind === 'plain');
  if (saved) return targetParent(saved.path);
  return places.find((place) => place.kind === 'home')?.path ?? null;
}

// ── which repos an agent works in ─────────────────────────────────────────

/**
 * Where a repo of {@link SessionWorksIn} came from (`docs/worktrees.md` → *Which repositories*).
 * D152 follow-up 2026-11-05: `read` (it only read files there) and `commands` (it ran
 * shell commands there) are additive; an older Switchboard sends neither.
 */
export type WorksInSource = 'worktree' | 'solution' | 'edited' | 'cwd' | 'read' | 'commands';

/** What a repo was seen through (D152 follow-up 2026-11-05): edits, reads, shell commands. */
export type WorksInEvidence = 'edited' | 'read' | 'commands';

/** One repo an agent works in. */
export interface WorksInRepo {
  /** The solution name, else the folder's name. */
  readonly name: string;
  /** Where it works (a worktree, or the checkout) on its computer. */
  readonly path: string;
  readonly kind: 'main' | 'worktree';
  readonly source: WorksInSource;
  /** The branch checked out there; `null` when detached or unreadable. */
  readonly branch: string | null;
  /** The remote's URL without credentials; `null` without one. */
  readonly remoteUrl: string | null;
  /**
   * Additive (D152 follow-up 2026-11-05): what the agent's history shows it did
   * there, strongest first (`edited`, `commands`, `read`); empty when it is listed
   * only for where it was started (its separate copy, a picked solution, its
   * working folder). Absent from an older Switchboard.
   */
  readonly evidence?: readonly WorksInEvidence[];
}

/** D152 `GET /api/sessions/{id}/works-in`: the repos a session works in, derived from its history. */
export interface SessionWorksIn {
  readonly repos: readonly WorksInRepo[];
}

/** The side panel's one-line summary: "web-front" / "web-front, api +2" / "No repo found yet". */
export function worksInSummary(repos: readonly Pick<WorksInRepo, 'name'>[]): string {
  if (repos.length === 0) return 'No repo found yet';
  const names = [...new Set(repos.map((repo) => repo.name))];
  return names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

/** How the side panel says where a repo came from. */
export function worksInSourceLabel(source: WorksInSource): string {
  switch (source) {
    case 'worktree':
      return 'its separate copy';
    case 'solution':
      return 'picked at start';
    case 'edited':
      return 'it edited files here';
    case 'cwd':
      return 'its working folder';
    case 'read':
      return 'it read files here';
    case 'commands':
      return 'it ran commands here';
  }
}

/** The side panel's subtle evidence words: "edited · commands · read" (empty without evidence). */
export function worksInEvidenceLabel(evidence: readonly WorksInEvidence[] | undefined): string {
  const words: Record<WorksInEvidence, string> = { edited: 'edited', commands: 'commands', read: 'read' };
  return (evidence ?? []).map((kind) => words[kind]).join(' · ');
}

/** At most this many repos may be left out of one move. */
export const EXCLUDE_REPOS_MAX = 200;

/**
 * D152 follow-up 2026-11-05: the repos left out of a move (`excludeRepos`: their
 * source paths) from a request body; `undefined` when absent, `null` when malformed.
 */
export function excludeReposOf(value: unknown): string[] | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > EXCLUDE_REPOS_MAX || value.some((entry) => typeof entry !== 'string' || entry === '' || entry.length > 4096)) return null;
  return [...new Set(value as string[])];
}

/** A {@link WorkspaceFileChoice} from a request body; `undefined` when absent, `null` when malformed. */
export function workspaceChoiceOf(value: unknown): WorkspaceFileChoice | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const copy = record['copy'];
  if (!Array.isArray(copy) || copy.some((name) => typeof name !== 'string') || copy.length > WORKSPACE_FILES_MAX_COUNT * 2) return null;
  return { copy: [...new Set(copy as string[])], ...(record['confirmSecrets'] === true ? { confirmSecrets: true } : {}) };
}

/**
 * The files a move really sends (initiating machine): the ticked ones that are new
 * on the target (a same file or a conflict is skipped and reported), plus the root
 * `AGENTS.md` when the move creates the workspace root (it is what makes the folder
 * a workspace there).
 */
export function filesToSend(listing: WorkspaceFilesListing | null | undefined, choice: WorkspaceFileChoice | null | undefined, targets: readonly WorkspaceFileTarget[] | null | undefined, createsRoot: boolean): WorkspaceFileChoice {
  const byName = new Map((targets ?? []).map((entry) => [entry.name, entry]));
  const listed = new Set((listing?.files ?? []).map((file) => file.name));
  const wanted = new Set(choice?.copy ?? []);
  if (createsRoot && listed.has('AGENTS.md')) wanted.add('AGENTS.md');
  const copy = [...wanted].filter((name) => (byName.get(name)?.state ?? 'new') === 'new');
  return { copy, ...(choice?.confirmSecrets === true ? { confirmSecrets: true } : {}) };
}
