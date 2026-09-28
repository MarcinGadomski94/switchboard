import type { Folder, TeleportSession } from '../../core/api.ts';
import { parseRemoteSession, remoteSessionBaseName } from '../../core/remote-session.ts';
import { shortNameFromTitle } from '../../core/session-title.ts';
import { FOLDER_KIND_LABEL, sessionCwd } from '../folders/folders.ts';
import { type FormFolder, type StartNames, type SummaryLine, TITLE_TOO_LONG, startNames, titleTooLong, worktreeFolder } from './new-session.ts';

/**
 * D25 in the New-session form (`docs/new-session.md` → *From a remote session*):
 * **From a remote session** (a pill on the Folder label line) replaces the task
 * with a field for a claude.ai/code URL or a `session_…` / `cse_…` id, limits the
 * Folder dropdown to git repo folders (teleport needs a checkout of the session's
 * GitHub repo), hides the router sections and the Launch toggles, and Start
 * posts `POST /api/sessions/teleport` instead of a new session. Pure rules: the
 * folders offered, the names, when Start is enabled, the body, the summary.
 */

/** The choice on the Folder label line. */
export const FROM_REMOTE_SESSION = 'From a remote session';

/** Why only git repo folders are offered while the option is on. */
export const REPO_FOLDERS_HINT = 'Only git repo folders: a remote session continues in a checkout of its GitHub repository.';

/** The hint when no git repo folder is saved yet. */
export const NO_REPO_FOLDER_HINT = 'No git repo folder is saved yet: add the checkout of the remote session\'s repository with Browse….';

/** Where the Launch toggles were: what Start does instead. */
export const REMOTE_LAUNCH_NOTE = "A new worktree of the repo: claude checks out the remote session's branch there and loads its history. New work stays local.";

/** The remote field's placeholder. */
export const REMOTE_PLACEHOLDER = 'https://claude.ai/code/session_…, session_… or cse_…';

/** The optional first message's placeholder. */
export const REMOTE_TASK_PLACEHOLDER = 'First message (optional): sent once the local copy is ready';

/** The folders the dropdown offers while the option is on: the saved git repo folders, in the API's order. */
export function repoFolders(folders: readonly Folder[]): Folder[] {
  return folders.filter((folder) => folder.kind === 'repo');
}

/**
 * The folder the form uses while the option is on: the current one when it is a
 * saved repo folder, else the first saved repo folder (the default first, then
 * most recently used), else none.
 */
export function remoteFormFolder(current: string | null, folders: readonly Folder[]): string | null {
  const repos = repoFolders(folders);
  if (current && repos.some((folder) => folder.id === current)) return current;
  return repos[0]?.id ?? null;
}

/**
 * The local copy's names (D25, D22): typed text is its title and its short name is
 * derived from it (`startNames`, `-2`, `-3`, … when taken); an empty field gives
 * the service's default: the name `remote-<first 8 characters of X, lower-cased>`
 * (made unique) and the title `Remote <first 8 characters>` (not sent: the
 * service sets it). Without a usable id the name is `remote-…`.
 */
export function remoteNames(remote: string, typed: string, takenNames: readonly string[]): StartNames {
  if (typed.trim() !== '') return startNames({ name: typed }, takenNames);
  const parsed = parseRemoteSession(remote);
  return { name: parsed.ok ? shortNameFromTitle(remoteSessionBaseName(parsed.id), takenNames) : 'remote-…', title: null };
}

/** What still keeps Start disabled (the summary's `⚠` lines), in order. */
export function remoteProblems(remote: string, typed: string, folder: Pick<FormFolder, 'kind'> | null): string[] {
  const problems: string[] = [];
  if (remote.trim() === '') problems.push('⚠ paste the remote session: a claude.ai/code URL, session_… or cse_…');
  else if (!parseRemoteSession(remote).ok) problems.push('⚠ not a claude.ai/code session URL, session_… or cse_… id');
  if (!folder || folder.kind !== 'repo') problems.push('⚠ pick a git repo folder: the checkout of the session\'s repository');
  if (titleTooLong({ name: typed })) problems.push(TITLE_TOO_LONG);
  return problems;
}

/** Start teleports: a valid remote session, a repo folder, a usable title (or none). */
export function canStartRemote(remote: string, typed: string, folder: Pick<FormFolder, 'kind'> | null): boolean {
  return remoteProblems(remote, typed, folder).length === 0;
}

/**
 * The `POST /api/sessions/teleport` body: the remote session as pasted (trimmed;
 * the service normalizes it), the folder, the typed title (only when typed: the
 * service derives the short name from it) and the first message (only when typed).
 */
export function toTeleportBody(remote: string, folder: Pick<FormFolder, 'id'>, typed: string, task: string): TeleportSession {
  const title = typed.trim();
  const first = task.trim();
  return { remote: remote.trim(), folder: folder.id, ...(title !== '' ? { title } : {}), ...(first !== '' ? { task: first } : {}) };
}

/**
 * The live summary while the option is on: the folder, the remote session
 * (normalized to `session_<X>`), the cwd (the new worktree), the short name, the
 * worktree folder, what is still missing, and what happens (history from the
 * remote session; a first message or idle).
 */
export function remoteSummaryLines(remote: string, folder: FormFolder | null, typed: string, task: string, takenNames: readonly string[]): SummaryLine[] {
  const value = (text: string): SummaryLine => ({ text, tone: 'value' });
  const parsed = parseRemoteSession(remote);
  const { name } = remoteNames(remote, typed, takenNames);
  const repo = folder && folder.kind === 'repo' ? folder : null;
  const lines: SummaryLine[] = [{ text: '# claude code · background · Max', tone: 'comment' }];
  if (folder) lines.push(value(`folder    ${folder.displayName} · ${FOLDER_KIND_LABEL[folder.kind]}`));
  lines.push(
    value(`remote    ${parsed.ok ? parsed.id : '—'}`),
    value(`cwd       ${repo ? sessionCwd(repo, true, name) : '—'}`),
    value(`name      ${name}`),
    value(' '),
    { text: '# worktree · claude checks out its branch', tone: 'comment' },
  );
  if (repo) lines.push({ text: worktreeFolder(repo.name, name), tone: 'path' });
  for (const problem of remoteProblems(remote, typed, folder)) lines.push({ text: problem, tone: 'warn' });
  lines.push(value(' '), { text: task.trim() !== '' ? '✓ local copy · history · first message' : '✓ local copy · history · idle', tone: 'ok' });
  return lines;
}
