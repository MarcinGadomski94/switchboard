import { SESSION_START_KIND } from '../../core/first-turn.ts';
import { worktreeBranch } from '../../core/worktrees.ts';
import { type RefusalBody, worktreeRefusal } from '../api/worktree-errors.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { WorktreeRecord } from '../db/repos/worktrees.ts';
import { type FolderRef, repoSolutionName } from '../folders/ref.ts';
import { FolderError } from '../folders/service.ts';
import type { ApiContext } from '../routes.ts';
import { type TaskWorktree, WorktreeError } from '../worktrees/manager.ts';
import { buildFirstTurn } from './first-turn.ts';
import { type ValidNewSession, type WorktreeBranchRule, validateNewSession } from './validate.ts';

/** What {@link startNewSession} needs (a subset of the route context). */
export type SessionStartContext = Pick<ApiContext, 'store' | 'providers' | 'supervisor' | 'worktrees' | 'folders'>;

/** Options for {@link startNewSession}. */
export interface StartNewSessionOptions {
  /** Runs once the session is stored and its worktrees are linked, before its process starts (M7.1 links the scheduled run here). */
  readonly beforeSpawn?: (session: SessionRecord) => Promise<void>;
  /**
   * D32: how the worktree branch is named. Default `ticket`: the developer's
   * `branch` (required with worktrees). The scheduler passes `session`: its runs
   * keep `session/{name}`.
   */
  readonly worktreeBranch?: WorktreeBranchRule;
}

/** Result of {@link startNewSession}: the started session, or a refusal to send as it is. */
export type StartNewSessionOutcome =
  | { readonly ok: true; readonly session: ValidNewSession; readonly folder: FolderRef; readonly record: SessionRecord }
  | { readonly ok: false; readonly status: number; readonly body: RefusalBody };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The folder a NewSession names (D14): `folder` = a saved folder's id, omitted or
 * `null` = the default folder. A refusal comes back as the HTTP answer: 422
 * (`folder` not a string, or no such saved folder), 409 `no-folder` (none saved)
 * or 409 `folder-missing` (the folder is gone from disk).
 */
export async function resolveSessionFolder(
  context: Pick<ApiContext, 'folders'>,
  body: unknown,
  field = 'folder',
): Promise<{ readonly ok: true; readonly folder: FolderRef } | { readonly ok: false; readonly status: number; readonly body: RefusalBody }> {
  const raw = isRecord(body) ? body['folder'] : undefined;
  if (raw !== undefined && raw !== null && (typeof raw !== 'string' || raw.trim() === '')) {
    return { ok: false, status: 422, body: { error: 'invalid', errors: [{ field, message: 'folder must be the id of a saved folder' }] } };
  }
  try {
    return { ok: true, folder: await context.folders.resolveForSession(typeof raw === 'string' ? raw : null) };
  } catch (error) {
    if (!(error instanceof FolderError)) throw error;
    if (error.code === 'not-found') return { ok: false, status: 422, body: { error: 'invalid', errors: [{ field, message: error.message }] } };
    return { ok: false, status: error.status, body: { error: error.code, message: error.message } };
  }
}

/**
 * The `POST /api/sessions` flow (M2.1 / M2.2 / M5.2 / M6.1; D14), shared with the
 * scheduler (M7.1): resolve the session's folder (default when omitted),
 * validate the NewSession for it (422 with `{errors}`; read-only solutions
 * through the workspace scan; a repo folder allows only its own solution; D32:
 * a ticket `branch` with worktrees, unless {@link StartNewSessionOptions.worktreeBranch}
 * says `session`), create its worktrees first (gap #1, on that branch; refusals
 * as {@link worktreeRefusal}, e.g. 409 `branch-exists`), pick
 * the process's cwd (the workspace root; the repo, or its worktree), build the
 * first stdin message (M5.2: task + the confirmed answers for a workspace, only
 * the worktree note for a repo; with no task the block waits in the outbox) and
 * start the process. A supervisor refusal is thrown (a `SupervisorError`) after
 * the worktrees created for it are discarded again. D38: a workspace session may
 * name no solutions; it then gets no worktree up front (its agent creates them on
 * the stored branch and `WorktreeAdoption` registers them) and starts with empty
 * `solutions`, which fill in from what its agents touch. D40: with a ticket
 * branch the worktrees follow the epic/task model (`createTaskWorktrees`: fetch,
 * cut from `origin/<epic>` / `origin/<base>` / the origin default branch, reuse an
 * existing task branch; 409 `fetch-failed` / `base-missing` /
 * `branch-checked-out`), dropped repos leave `solutions`, the branching is
 * stored and the first message carries the Branching lines.
 */
export async function startNewSession(context: SessionStartContext, body: unknown, options: StartNewSessionOptions = {}): Promise<StartNewSessionOutcome> {
  const { store, supervisor, providers, worktrees, folders } = context;
  const resolved = await resolveSessionFolder(context, body);
  if (!resolved.ok) return resolved;
  const { folder } = resolved;
  const scan = providers.solutions;
  const readOnly =
    scan && folder.kind === 'workspace'
      ? async (solution: string): Promise<boolean> => {
          // The scanner's own rule (M6.1, docs/solutions.md) resolves the name like the worktree manager does.
          if (scan.isReadOnly) return scan.isReadOnly(solution, folder);
          const groups = await scan.solutions(folder);
          return groups.some((group) => group.solutions.some((s) => s.name === solution && s.rule === 'read-only'));
        }
      : undefined;
  const result = await validateNewSession(body, {
    nameTaken: async (name) => (await store.sessions.getByName(name)) !== null,
    folder: { kind: folder.kind, repoName: repoSolutionName(folder) },
    worktreeBranch: options.worktreeBranch ?? 'ticket',
    ...(readOnly ? { readOnly } : {}),
  });
  if (!result.ok) return { ok: false, status: 422, body: { error: 'invalid', errors: result.errors } };
  // D38: the branch the session's worktrees are on (stored with the session): the developer's ticket branch
  // (D32), `session/{name}` for scheduled runs; also the branch its agent's own worktrees get.
  const branch = result.value.worktrees ? (result.value.branch ?? worktreeBranch(result.value.name)) : null;
  // D40: a ticket-branch session's worktrees follow the epic/task model (a body without `branching` is a task
  // without an epic); dropped repos get no worktree and leave the session's solutions.
  const branching = result.value.worktrees && result.value.branch ? (result.value.branching ?? null) : null;
  const solutions = branching ? result.value.solutions.filter((solution) => !branching.dropped.includes(solution)) : result.value.solutions;
  const input: ValidNewSession = { ...result.value, solutions, ...(branch !== null ? { branch } : {}) };
  // M2.2 / gap #1: the worktrees exist before the process starts and are linked to the session before its spawn.
  // D32: on the developer's ticket branch (the same in every repo); `session/{name}` for scheduled runs.
  // D38: a workspace session without solutions gets none up front: its agent creates them (and Switchboard adopts them).
  // D40: task worktrees are cut from origin after a `git fetch origin` (WorktreeManager.createTaskWorktrees).
  let created: WorktreeRecord[] = [];
  let taskWorktrees: TaskWorktree[] = [];
  if (input.worktrees && input.solutions.length > 0) {
    try {
      if (branching && input.branch) {
        taskWorktrees = await worktrees.createTaskWorktrees(input.name, input.solutions, folder, { task: input.branch, branching });
        created = taskWorktrees.map((worktree) => worktree.record);
      } else {
        created = await worktrees.createForSession(input.name, input.solutions, folder, null, input.branch ? { branch: input.branch } : {});
      }
    } catch (error) {
      if (!(error instanceof WorktreeError)) throw error;
      return { ok: false, ...worktreeRefusal(error, 'solutions') };
    }
  }
  try {
    // M5.2: the task + the confirmed session-start answers are the first stdin message; with no task the
    // process starts idle and the answers wait in the outbox for the developer's first message.
    const firstTurn = await buildFirstTurn(input, {
      folder,
      worktrees: created,
      resolveRepo: (solution) => worktrees.resolveRepo(solution, folder),
      agentBranch: branch,
      branching,
      cutFrom: new Map(taskWorktrees.map((worktree) => [worktree.record.id, worktree.from])),
    });
    // D14: a workspace session runs at the folder root (the router applies); a repo session in the repo, or in its worktree.
    const cwd = folder.kind === 'repo' && created[0] ? created[0].path : folder.root;
    const record = await supervisor.start(input, { folder, cwd }, firstTurn.message, {
      beforeSpawn: async (session) => {
        // D40 (0012): the branching, for the worktrees its agent creates later (adoption reads it, also after a restart).
        if (branching) await store.sessions.update(session.id, { branching });
        await worktrees.assign(created, session.id);
        if (firstTurn.message === '' && firstTurn.block !== '') await store.pendingMessages.enqueue({ sessionId: session.id, kind: SESSION_START_KIND, text: firstTurn.block });
        if (options.beforeSpawn) await options.beforeSpawn(session);
      },
    });
    await folders.markUsed(folder.id);
    return { ok: true, session: input, folder, record };
  } catch (error) {
    if (created.length > 0 && (await store.sessions.getByName(input.name)) === null) await worktrees.discard(created);
    throw error;
  }
}
