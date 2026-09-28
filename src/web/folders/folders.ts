import type { Folder, FolderCheck, Session } from '../../core/api.ts';
import type { FolderKind } from '../../core/model.ts';

/**
 * Pure rules of the saved folders in the UI (D14, `docs/folders.md` → *UI*): the
 * check line every place shows for a folder (Settings → Folders, the New-session
 * form's Folder row, the wizard's "Add your first folder"), the default folder,
 * the folder switcher's options (Solutions, the Codebase Memory strip), the folder
 * tag of lists that mix folders, and the cwd a new session gets. Kept free of
 * React so `tests/web` can check them.
 */

/** A folder's check line: `✓ …` (usable) or `✕ <why not>`. */
export interface CheckLine {
  readonly ok: boolean;
  readonly text: string;
}

/**
 * How the router file is named in a check line (the wizard's rule, M5.3): its
 * first `# ` heading when that starts with `AGENTS.md`, else `AGENTS.md (<heading>)`,
 * else just `AGENTS.md`.
 */
export function routerName(title: string | null): string {
  if (!title) return 'AGENTS.md';
  return title.startsWith('AGENTS.md') ? title : `AGENTS.md (${title})`;
}

/** `38 solutions` / `1 solution`. */
function solutions(count: number): string {
  return `${count} solution${count === 1 ? '' : 's'}`;
}

/**
 * The check line of a folder (D14): a workspace `✓ AGENTS.md (Workspace Router) ·
 * 38 solutions` (the router's name, then how many solutions its scan lists; the
 * count is left out when the scan failed), a repo `✓ git repo · single solution`,
 * anything else `✕ <the server's message>`. `null` without a check.
 */
export function folderCheckLine(check: FolderCheck | null): CheckLine | null {
  if (!check) return null;
  if (check.kind === 'repo') return { ok: true, text: '✓ git repo · single solution' };
  if (check.kind === 'workspace') {
    const name = routerName(check.router?.title ?? null);
    return { ok: true, text: check.solutionCount === null ? `✓ ${name}` : `✓ ${name} · ${solutions(check.solutionCount)}` };
  }
  return { ok: false, text: `✕ ${check.message || 'not a workspace or a git repository'}` };
}

/** The kind as the UI names it. */
export const FOLDER_KIND_LABEL: Readonly<Record<FolderKind, string>> = { workspace: 'workspace', repo: 'git repo' };

/** The default saved folder (the API lists it first), `null` while none is saved. */
export function defaultFolder(folders: readonly Folder[] | null): Folder | null {
  if (!folders) return null;
  return folders.find((folder) => folder.isDefault) ?? folders[0] ?? null;
}

/** The saved folder with this id, `null` when there is none. */
export function folderById(folders: readonly Folder[] | null, id: string | null | undefined): Folder | null {
  if (!folders || !id) return null;
  return folders.find((folder) => folder.id === id) ?? null;
}

function lastSeparator(text: string): number {
  return Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
}

/** A path without trailing separators (a root such as `/` or `C:\` stays as it is). */
function trimPath(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '');
  return trimmed === '' || /^[A-Za-z]:$/.test(trimmed) ? value : trimmed;
}

/** The last segment of a path in either OS form (`/a/switchboard` → `switchboard`). */
export function folderName(folderPath: string): string {
  const trimmed = trimPath(folderPath);
  return trimmed.slice(lastSeparator(trimmed) + 1) || trimmed;
}

/** The parent of a path in either OS form (`/a/switchboard` → `/a`, `D:\ws` → `D:\`). */
export function parentFolder(folderPath: string): string {
  const trimmed = trimPath(folderPath);
  const at = lastSeparator(trimmed);
  if (at < 0) return '';
  if (at === 0) return trimmed.slice(0, 1);
  const parent = trimmed.slice(0, at);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}${trimmed[at]}` : parent;
}

/** The separator a path uses (`\` for a Windows path, else `/`; gap #17). */
function separatorOf(folderPath: string): string {
  return folderPath.includes('\\') && !folderPath.includes('/') ? '\\' : '/';
}

/** The comparison form of a path: `/`-separated, no trailing separator, case kept. */
function samePathForm(value: string): string {
  return trimPath(value).replaceAll('\\', '/');
}

/** `true` when two paths name the same folder as text (either separator, trailing ones ignored). */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return samePathForm(a) === samePathForm(b);
}

/** A saved folder whose path or canonical path is `folderPath`, `null` when none is. */
export function folderByPath(folders: readonly Folder[] | null, folderPath: string | null | undefined): Folder | null {
  if (!folders || !folderPath) return null;
  return folders.find((folder) => samePath(folder.canonicalPath, folderPath) || samePath(folder.path, folderPath)) ?? null;
}

/** Anything that names the folder it belongs to (a Session, a HistoryItem, an ArtifactListItem, a Schedule). */
export interface FolderOwned {
  /** The saved folder's id; `null` when none (or it left the saved list). */
  readonly folder?: string | null;
  /** The folder's path; `null` when unknown. */
  readonly folderPath?: string | null;
}

/**
 * The folder tag of a row in a list that mixes folders (D14: the sidebar's session
 * rows, the Inbox meta, History, Artifacts, Schedules): the folder's name when the
 * row belongs to a folder other than the default one, else `null`, so the default
 * folder's rows look exactly as before D14. Nothing is tagged until the saved
 * folders are known (`folders` `null`), so no tag flashes while they load. A row
 * without a folder id or path (a schedule saved before any folder) runs in the
 * default folder and is not tagged.
 */
export function folderTag(item: FolderOwned, folders: readonly Folder[] | null): string | null {
  if (!folders) return null;
  const id = item.folder ?? null;
  const itemPath = item.folderPath ?? null;
  if (!id && !itemPath) return null;
  const home = defaultFolder(folders);
  if (home && id && home.id === id) return null;
  if (home && !id && (samePath(home.canonicalPath, itemPath) || samePath(home.path, itemPath))) return null;
  const saved = folderById(folders, id) ?? folderByPath(folders, itemPath);
  if (saved) return saved.id === home?.id ? null : saved.name;
  return itemPath ? folderName(itemPath) : null;
}

/** One entry of the folder switcher (Solutions, the Codebase Memory strip) and of the New-session dropdown. */
export interface FolderOption {
  /** What `?folder=` / the API gets: a saved folder's id, or the path of a session's folder that is not saved. */
  readonly value: string;
  /** The shown text (the path; `(default)` after the default folder). */
  readonly label: string;
  readonly path: string;
  readonly kind: FolderKind | null;
  readonly isDefault: boolean;
  /** `true` for a saved folder; `false` for a folder only an open session uses. */
  readonly saved: boolean;
}

/**
 * The folder switcher's options (D14): the default folder first, then the other
 * saved folders (the API's order: most recently used, then the order added), then
 * the folders sessions use that are not saved (a folder removed from the list
 * while its sessions stay), each once, by path.
 */
export function switcherOptions(folders: readonly Folder[] | null, sessions: readonly Session[] | null): FolderOption[] {
  const saved = [...(folders ?? [])].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const options: FolderOption[] = saved.map((folder) => ({
    value: folder.id,
    label: folder.isDefault ? `${folder.path} (default)` : folder.path,
    path: folder.path,
    kind: folder.kind,
    isDefault: folder.isDefault,
    saved: true,
  }));
  const seen = new Set(saved.flatMap((folder) => [samePathForm(folder.path), samePathForm(folder.canonicalPath)]));
  for (const session of sessions ?? []) {
    if (!session.folderPath || folderById(folders, session.folder)) continue;
    const form = samePathForm(session.folderPath);
    if (seen.has(form)) continue;
    seen.add(form);
    options.push({ value: session.folderPath, label: session.folderPath, path: session.folderPath, kind: session.folderKind, isDefault: false, saved: false });
  }
  return options;
}

/**
 * The option a `?folder=` value selects: the option with that value (a saved id)
 * or path; the default folder's option without a value; `null` when nothing
 * matches (the lists are still loading, or the value is unknown: the view passes
 * it to the API as it is and shows the service's answer).
 */
export function selectedOption(options: readonly FolderOption[], param: string | null): FolderOption | null {
  if (!param) return options.find((option) => option.isDefault) ?? options[0] ?? null;
  return options.find((option) => option.value === param) ?? options.find((option) => samePath(option.path, param)) ?? null;
}

/**
 * The working folder a new session gets (D14, gap #1): a workspace runs at its
 * root, a repo in the repo, or with Worktree on in its worktree next to it,
 * `<parent>/<repo>-wt-<name>` (the path's own separator, gap #17).
 */
export function sessionCwd(folder: Pick<Folder, 'path' | 'kind' | 'name'>, worktrees: boolean, name: string): string {
  if (folder.kind !== 'repo' || !worktrees) return folder.path;
  const parent = parentFolder(folder.path);
  const leaf = `${folder.name}-wt-${name}`;
  if (!parent) return leaf;
  return /[\\/]$/.test(parent) ? `${parent}${leaf}` : `${parent}${separatorOf(folder.path)}${leaf}`;
}

/**
 * The message of a refused folder call (`POST /api/folders` 422, `DELETE` 409, …):
 * the server's `message`, else the HTTP status, else "not reachable".
 */
export function folderRefusal(status: number, body: unknown): string {
  if (typeof body === 'object' && body !== null) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return status === 0 ? 'Switchboard is not reachable.' : `HTTP ${status}`;
}
