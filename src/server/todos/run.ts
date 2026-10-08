import type { TodoRunResult } from '../../core/api.ts';
import { TITLE_MAX, shortNameFromTitle } from '../../core/session-title.ts';
import { todoStartMessage } from '../../core/todos.ts';
import type { RefusalBody } from '../api/worktree-errors.ts';
import type { TodoRecord } from '../db/repos/todos.ts';
import { repoSolutionName } from '../folders/ref.ts';
import { FolderError } from '../folders/service.ts';
import { WorktreeError } from '../worktrees/manager.ts';
import type { ApiContext } from '../routes.ts';
import { type SessionStartContext, startNewSession } from '../sessions/start.ts';
import { toSession } from '../sessions/wire.ts';
import { todoRunOptions } from './run-options.ts';
import { modelRulesOf } from '../settings/settings.ts';
import { readModelOptionsSetting } from '../settings/models.ts';
import { CLI_PROVIDERS, type CliProviderId } from '../../core/cli-providers.ts';
import { routingModelOptions } from '../../core/model-routing.ts';
import type { SessionModelOption } from '../../core/api.ts';
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
 * - in the source session's folder, on a free `todo/<slug>` branch: in a **repo** folder one
 *   worktree cut from the branch (or, detached, the commit) the source session has checked
 *   out; in a **workspace** folder one worktree per solution repo the source session uses
 *   (its `solutions`), each cut from the source's branch in that repo (its worktree's, else the
 *   main checkout's), as a Full start with worktrees per solution when the source has the
 *   router's answers; without such repos, or in a plain folder, in the same folder without a
 *   worktree, and the answer's `note` says so;
 * - on the source session's CLI, model, effort and account, unless a D82 *Model by task* rule
 *   matches the item's priority and estimate ({@link todoRunOptions}; the answer's `routing`
 *   then carries the rule's line, shown in the Run toast);
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
  // D82: the Model by task rules route the run (none = the source's settings); the explanation names the routed CLI's models and profiles.
  const rules = await modelRulesOf(store.settings);
  const reported = new Map<CliProviderId, readonly SessionModelOption[] | null>();
  const profileNames = new Map<string, string>();
  if (rules.length > 0) {
    for (const provider of CLI_PROVIDERS) reported.set(provider, await readModelOptionsSetting(store.settings, provider));
    for (const profile of await store.profiles.list()) profileNames.set(profile.id, profile.name);
  }
  const routed = todoRunOptions({
    source: { provider: source.provider, model: source.model, effort: source.effort, profileId: source.profileId },
    todo,
    rules,
    labels: (provider) => ({ models: routingModelOptions(provider, reported.get(provider) ?? null), profileName: (id) => profileNames.get(id) ?? null }),
  });
  const launch = routed.settings;
  const names = new Set((await store.sessions.list()).map((record) => record.name));
  const name = shortNameFromTitle(todo.title, names);

  // The source's branch in each repo the run gets a worktree in (D76; ruling D76-workspace: a workspace's solution repos).
  const from: Record<string, string> = {};
  const repoPaths: string[] = [];
  let note: string | null = null;
  if (folder.kind === 'repo') {
    const cwd = source.cwd ?? folder.root;
    const ref = (await worktrees.checkedOutBranch(cwd)) ?? (await worktrees.headCommit(cwd));
    if (ref === null) note = "The source session's branch could not be read: the run works in the same folder, without a worktree.";
    else {
      from[repoSolutionName(folder)] = ref;
      repoPaths.push(folder.root);
    }
  } else if (folder.kind === 'workspace') {
    for (const solution of source.solutions) {
      let repoPath: string;
      try {
        repoPath = (await worktrees.resolveRepo(solution, folder)).repoPath;
      } catch (error) {
        if (error instanceof WorktreeError) continue;
        throw error;
      }
      // The source's own worktree of that repo (its branch), else the main checkout's.
      const own = (await store.worktrees.list({ sessionId: source.id, repo: solution }))[0];
      const dir = own?.path ?? repoPath;
      const ref = (await worktrees.checkedOutBranch(dir)) ?? (await worktrees.headCommit(dir));
      if (ref === null) continue;
      from[solution] = ref;
      repoPaths.push(repoPath);
    }
    if (repoPaths.length === 0) note = "The source session uses no solution repository yet: the run works in the workspace folder, without a worktree.";
  } else {
    note = "The source session's folder is not a git repository: the run works in the same folder, without a worktree.";
  }
  let ownWorktree: { branch: string; from: Readonly<Record<string, string>> } | undefined;
  if (repoPaths.length > 0) {
    // One branch name, free in every repo.
    const slug = runSlug(todo.title);
    let branch = `${TODO_RUN_BRANCH_PREFIX}${slug}`;
    const taken = async (candidate: string): Promise<boolean> => {
      for (const repoPath of repoPaths) if (await worktrees.hasLocalBranch(repoPath, candidate)) return true;
      return false;
    };
    for (let n = 2; await taken(branch); n++) branch = `${TODO_RUN_BRANCH_PREFIX}${slug}-${n}`;
    ownWorktree = { branch, from };
  }

  const common = {
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
  // A workspace source with the router's answers starts the run as a Full start with the same answers (its first message carries
  // the session-start block with the worktrees, like a Full start with worktrees per solution); every other one as a simple start.
  const full = folder.kind === 'workspace' && source.workType !== null && source.mode !== null && source.phase !== null;
  const body = full
    ? {
        ...common,
        workType: source.workType,
        mode: source.mode,
        phase: source.phase,
        coordination: source.coordination,
        qa: source.workType === 'qa' && source.qaStack ? { stack: source.qaStack, confluenceUrl: source.qaConfluenceUrl ?? '', figmaUrls: source.qaFigmaUrls } : null,
        solutions: Object.keys(from),
        ultracode: source.ultracode,
      }
    : { ...common, simple: true };
  let before: TodoRecord | null = null;
  let outcome;
  try {
    outcome = await startNewSession(context, body, {
      ...(ownWorktree ? { ownWorktree } : {}),
      // The run's branch is todo/<slug> (ownWorktree), never a D32 ticket branch.
      worktreeBranch: 'session',
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
  return { ok: true, result: { session, list, note, routing: routed.explanation } };
}
