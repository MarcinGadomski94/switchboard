import type { TodoRunResult } from '../../core/api.ts';
import { TITLE_MAX, shortNameFromTitle } from '../../core/session-title.ts';
import { todoStartMessage } from '../../core/todos.ts';
import type { RefusalBody } from '../api/worktree-errors.ts';
import type { TodoRecord } from '../db/repos/todos.ts';
import { FolderError } from '../folders/service.ts';
import type { ApiContext } from '../routes.ts';
import { type SessionStartContext, startNewSession } from '../sessions/start.ts';
import { toSession } from '../sessions/wire.ts';
import { todoRunOptions } from './run-options.ts';
import { TodoError } from './service.ts';

/** The prefix of a todo run's branch (`todo/<slug>`). */
export const TODO_RUN_BRANCH_PREFIX = 'todo/';

/** What {@link runTodo} needs (a subset of the route context). */
export type TodoRunContext = SessionStartContext & Pick<ApiContext, 'todos'>;

/** The answer of {@link runTodo}: the run, or a refusal to send as it is. */
export type TodoRunOutcome = { readonly ok: true; readonly result: TodoRunResult } | { readonly ok: false; readonly status: number; readonly body: RefusalBody };

/** The run session's title: the item's title, cut to a session title's length. */
export function runTitle(title: string): string {
  return title.length <= TITLE_MAX ? title : `${title.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

/** The slug of a run's branch: the D22 short-name rule over the title (`todo/fix-the-login-flake`). */
export function runSlug(title: string): string {
  return shortNameFromTitle(title, []);
}

/**
 * D76 · ▸ Run in new session (`docs/todos.md` → *Run in a new session*): starts a new
 * supervised session for item `todoId` of session `sessionId`:
 *
 * - in the source session's folder; in a **repo** folder on its own worktree, on a free
 *   `todo/<slug>` branch cut from the branch (or, detached, the commit) the source session
 *   has checked out; in a workspace or plain folder (not a git repository) in the same
 *   folder without a worktree, and the answer's `note` says so;
 * - on the source session's CLI, model, effort and account ({@link todoRunOptions});
 * - titled like the item, its first message the item's start message (D75's, with its
 *   "mark it done" line);
 * - linked both ways before its process starts: the session's `todoLink` (its agent may mark
 *   that one item) and the item's `runSessionId` (in progress, started by `run`).
 *
 * A refusal of the start (a folder gone, a model no longer listed, a branch problem, the CLI
 * unavailable) is answered as `POST /api/sessions` answers it, and the item is put back.
 * @throws {TodoError} 404 (no session / item), 422 (done or in review), 409 (`already-running`, `no-folder`).
 */
export async function runTodo(context: TodoRunContext, sessionId: string, todoId: string): Promise<TodoRunOutcome> {
  const { store, todos, worktrees, folders, supervisor } = context;
  const todo = await todos.checkRunnable(sessionId, todoId);
  const source = await store.sessions.get(sessionId);
  if (!source) throw new TodoError(404, 'not-found', `no session ${sessionId}`);
  if (!source.folderId) throw new TodoError(409, 'no-folder', "the session's folder is no longer in the saved folders: add it again to run items there");
  let folder;
  try {
    folder = await folders.resolveForSession(source.folderId);
  } catch (error) {
    if (!(error instanceof FolderError)) throw error;
    return { ok: false, status: error.status === 404 ? 409 : error.status, body: { error: error.code === 'not-found' ? 'no-folder' : error.code, message: error.message } };
  }
  const launch = todoRunOptions({ source: { provider: source.provider, model: source.model, effort: source.effort, profileId: source.profileId }, todo });
  const names = new Set((await store.sessions.list()).map((record) => record.name));
  const name = shortNameFromTitle(todo.title, names);

  let ownWorktree: { branch: string; from: string } | undefined;
  let note: string | null = null;
  if (folder.kind === 'repo') {
    const cwd = source.cwd ?? folder.root;
    const from = (await worktrees.checkedOutBranch(cwd)) ?? (await worktrees.headCommit(cwd));
    if (from === null) note = "The source session's branch could not be read: the run works in the same folder, without a worktree.";
    else {
      const slug = runSlug(todo.title);
      let branch = `${TODO_RUN_BRANCH_PREFIX}${slug}`;
      for (let n = 2; await worktrees.hasLocalBranch(folder.root, branch); n++) branch = `${TODO_RUN_BRANCH_PREFIX}${slug}-${n}`;
      ownWorktree = { branch, from };
    }
  } else {
    note = `The source session's folder is not a git repository${folder.kind === 'workspace' ? ' (a workspace)' : ''}: the run works in the same folder, without a worktree.`;
  }

  const body = {
    simple: true,
    name,
    title: runTitle(todo.title),
    task: todoStartMessage({ id: todo.id, title: todo.title, description: todo.description, plan: todo.plan }),
    folder: folder.id,
    provider: launch.provider,
    model: launch.model,
    effort: launch.effort,
    profileId: launch.profileId,
    worktrees: false,
  };
  let before: TodoRecord | null = null;
  let outcome;
  try {
    outcome = await startNewSession(context, body, {
      ...(ownWorktree ? { ownWorktree } : {}),
      // Linked before the process starts, so its agent can mark the item from its first turn.
      beforeSpawn: async (session) => {
        await store.sessions.update(session.id, { todoLink: { sourceSessionId: sessionId, todoId } });
        before = await todos.beginRun(sessionId, todoId, session.id);
      },
    });
  } catch (error) {
    if (before) await todos.cancelRun(before);
    throw error;
  }
  if (!outcome.ok) {
    if (before) await todos.cancelRun(before);
    return outcome;
  }
  const list = await todos.announceRun(sessionId);
  const session = await toSession(store, outcome.record, supervisor.activity(outcome.record.id));
  return { ok: true, result: { session, list, note } };
}
