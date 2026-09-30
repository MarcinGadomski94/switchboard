import { lstat } from 'node:fs/promises';
import type { TeleportRefusal } from '../../core/api.ts';
import { parseRemoteSession, remoteSessionBaseName, remoteSessionTitle } from '../../core/remote-session.ts';
import { checkTitle, shortNameFromTitle } from '../../core/session-title.ts';
import { type RefusalBody, worktreeRefusal } from '../api/worktree-errors.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { WorktreeRecord } from '../db/repos/worktrees.ts';
import type { Store } from '../db/store.ts';
import { type FolderRef, repoSolutionName } from '../folders/ref.ts';
import { FolderError, type FolderService } from '../folders/service.ts';
import { type SessionSupervisor, SupervisorError, TeleportError } from '../supervisor/supervisor.ts';
import { WorktreeError, type WorktreeManager } from '../worktrees/manager.ts';

/** Why a teleport is refused: the usual refusal bodies, or the CLI's own text (D25). */
export type TeleportRefusalBody = RefusalBody | TeleportRefusal;

/** Result of {@link SessionTeleporter.teleport}: the started session, or the refusal to send as it is. */
export type TeleportOutcome =
  | { readonly ok: true; readonly record: SessionRecord }
  | { readonly ok: false; readonly status: number; readonly body: TeleportRefusalBody };

/** Options of {@link SessionTeleporter}. */
export interface SessionTeleporterOptions {
  readonly store: Store;
  readonly supervisor: SessionSupervisor;
  readonly worktrees: WorktreeManager;
  readonly folders: FolderService;
  /** Called when cleaning up after a refused teleport fails (default: `console.error`). */
  readonly onError?: (error: unknown) => void;
}

/** What {@link parseTeleportBody} took from a valid body. */
interface TeleportRequest {
  readonly remote: string;
  readonly folderId: string;
  readonly title: string | null;
  readonly task: string;
}

type Field = { readonly field: string; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(errors: readonly Field[]): TeleportOutcome {
  return { ok: false, status: 422, body: { error: 'invalid', errors: [...errors] } };
}

/** HTTP status of a supervisor refusal (the session routes' map for the codes a teleport can meet). */
function supervisorStatus(error: SupervisorError): number {
  switch (error.code) {
    case 'teleport-failed':
      return 502;
    case 'teleport-timeout':
      return 504;
    case 'closing':
      return 503;
    case 'not-found':
      return 404;
    default:
      return 409;
  }
}

/**
 * The body of `POST /api/sessions/teleport` (`TeleportSession`): `remote` (a
 * claude.ai/code URL, `session_<X>` or `cse_<X>`, normalized to `session_<X>`),
 * `folder` (a saved folder's id, required), `title` (D22 rules; omitted, `null` or
 * blank = the default) and `task` (optional text). Every problem is one
 * `{ field, message }`.
 */
export function parseTeleportBody(body: unknown): { readonly ok: true; readonly value: TeleportRequest } | { readonly ok: false; readonly errors: Field[] } {
  if (!isRecord(body)) return { ok: false, errors: [{ field: '', message: 'the body must be an object: { remote, folder, title?, task? }' }] };
  const errors: Field[] = [];
  const remote = parseRemoteSession(body['remote']);
  if (!remote.ok) errors.push({ field: 'remote', message: remote.message });
  const folder = body['folder'];
  if (typeof folder !== 'string' || folder.trim() === '') errors.push({ field: 'folder', message: 'folder must be the id of a saved git repo folder' });
  let title: string | null = null;
  const rawTitle = body['title'];
  if (rawTitle !== undefined && rawTitle !== null && !(typeof rawTitle === 'string' && rawTitle.trim() === '')) {
    const check = checkTitle(rawTitle);
    if (check.ok) title = check.title;
    else errors.push({ field: 'title', message: check.message });
  }
  const rawTask = body['task'];
  if (rawTask !== undefined && rawTask !== null && typeof rawTask !== 'string') errors.push({ field: 'task', message: 'the first message must be text' });
  if (errors.length > 0 || !remote.ok || typeof folder !== 'string') return { ok: false, errors };
  return { ok: true, value: { remote: remote.id, folderId: folder.trim(), title, task: typeof rawTask === 'string' ? rawTask.trim() : '' } };
}

/**
 * "From a remote session" (D25, `docs/supervisor.md` → *Teleport*):
 * `POST /api/sessions/teleport` continues a remote session (claude.ai/code, or
 * Remote Control on another machine) as a local copy that Switchboard supervises.
 *
 * 1. The body ({@link parseTeleportBody}): 422 `invalid` on `remote`, `folder`,
 *    `title` or `task`.
 * 2. **Folder**: a saved **repo** folder. An unknown id or a workspace folder is
 *    422 on `folder` (teleport needs a checkout of the session's GitHub repo); a
 *    folder gone from disk 409 `folder-missing`.
 * 3. **Names** (D22): the typed title, its short name derived from it; without one
 *    the title `Remote <first 8 characters of X>` and the short name
 *    `remote-<the same, lower-cased>`; `-2`, `-3`, … when taken.
 * 4. **Worktree**: a new clean worktree of the repo, as D14's repo sessions get
 *    (`../{repo}-wt-{name}`, branch `session/{name}` from HEAD); its refusals as
 *    for a new session (409 `branch-exists`, `path-exists`, …).
 * 5. {@link SessionSupervisor.teleport}: `claude -p --teleport <session_X>` in that
 *    worktree; the local copy's id from `system/init`.
 * 6. **Branch**: the branch the teleport checked out (`git rev-parse --abbrev-ref
 *    HEAD` in the worktree) is recorded on the worktree row (`branch`), so the
 *    Diff tab, the pull request check and removal follow it. A detached HEAD
 *    keeps `session/{name}`.
 *
 * A refused teleport (502 `teleport-failed`: the CLI's text verbatim; 504
 * `teleport-timeout`) leaves nothing behind: the supervisor deleted the session
 * and this removes the worktree and its `session/{name}` branch again. Teleports
 * run one at a time, so two calls never pick one name twice.
 */
export class SessionTeleporter {
  readonly #store: Store;
  readonly #supervisor: SessionSupervisor;
  readonly #worktrees: WorktreeManager;
  readonly #folders: FolderService;
  readonly #onError: (error: unknown) => void;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: SessionTeleporterOptions) {
    this.#store = options.store;
    this.#supervisor = options.supervisor;
    this.#worktrees = options.worktrees;
    this.#folders = options.folders;
    this.#onError = options.onError ?? ((error) => console.error('switchboard teleport:', error));
  }

  /** Teleports as the class comment says; `body` is the request body (`TeleportSession`). */
  teleport(body: unknown): Promise<TeleportOutcome> {
    const run = this.#queue.catch(() => undefined).then(() => this.#teleportNow(body));
    this.#queue = run;
    return run;
  }

  async #teleportNow(body: unknown): Promise<TeleportOutcome> {
    const parsed = parseTeleportBody(body);
    if (!parsed.ok) return invalid(parsed.errors);
    const request = parsed.value;

    let folder: FolderRef;
    try {
      folder = await this.#folders.resolveForSession(request.folderId);
    } catch (error) {
      if (!(error instanceof FolderError)) throw error;
      if (error.code === 'not-found') return invalid([{ field: 'folder', message: error.message }]);
      return { ok: false, status: error.status, body: { error: error.code, message: error.message } };
    }
    if (folder.kind !== 'repo') {
      return invalid([
        {
          field: 'folder',
          message: `${folder.path} is ${folder.kind === 'plain' ? 'a plain folder' : 'a workspace'}: a remote session continues in a checkout of its GitHub repository, so pick a git repo folder`,
        },
      ]);
    }

    const taken = new Set((await this.#store.sessions.list()).map((session) => session.name));
    const name = shortNameFromTitle(request.title ?? remoteSessionBaseName(request.remote), taken);
    const title = request.title ?? remoteSessionTitle(request.remote);
    const repo = repoSolutionName(folder);

    let worktree: WorktreeRecord;
    try {
      const created = await this.#worktrees.createForSession(name, [repo], folder);
      if (!created[0]) throw new Error('no worktree was created');
      worktree = created[0];
    } catch (error) {
      if (!(error instanceof WorktreeError)) throw error;
      return { ok: false, ...worktreeRefusal(error, 'folder') };
    }

    let record: SessionRecord;
    try {
      record = await this.#supervisor.teleport(
        { name, title, remoteSource: request.remote, solutions: [repo], task: request.task },
        { folder, cwd: worktree.path },
        { beforeSpawn: (session) => this.#worktrees.assign([worktree], session.id) },
      );
    } catch (error) {
      const kept = await this.#discard(worktree);
      if (error instanceof TeleportError) {
        const message = kept ? `${error.message}\n\nSwitchboard could not remove the worktree it made for this teleport: ${worktree.path} is still there.` : error.message;
        const refusal: TeleportRefusal = { error: error.code === 'teleport-timeout' ? 'teleport-timeout' : 'teleport-failed', message };
        return { ok: false, status: supervisorStatus(error), body: refusal };
      }
      if (error instanceof SupervisorError) return { ok: false, status: supervisorStatus(error), body: { error: error.code, message: error.message } };
      throw error;
    }

    // The branch the teleport checked out (the CLI's `git fetch origin <b>:<b>` + checkout, R.3).
    const branch = await this.#worktrees.checkedOutBranch(worktree.path);
    if (branch !== null && branch !== worktree.branch) await this.#store.worktrees.update(worktree.id, { branch });
    await this.#folders.markUsed(folder.id);
    return { ok: true, record: (await this.#store.sessions.get(record.id)) ?? record };
  }

  /**
   * Removes the worktree (and its `session/{name}` branch) made for a teleport
   * that did not start (`git worktree remove`, never `--force`; `git branch -d`).
   * A failure is reported, never thrown; `true` when the worktree folder is still
   * there afterwards (e.g. it holds changes git will not drop without `--force`).
   */
  async #discard(worktree: WorktreeRecord): Promise<boolean> {
    try {
      await this.#worktrees.discard([worktree]);
    } catch (error) {
      this.#onError(error);
    }
    try {
      await lstat(worktree.path);
      return true;
    } catch {
      return false;
    }
  }
}
