import type { AccountService } from '../accounts/service.ts';
import { repoSolutionName } from '../folders/ref.ts';
import { FolderError } from '../folders/service.ts';
import type { SystemItemService } from '../inbox/system-items.ts';
import { modelRulesOf } from '../settings/settings.ts';
import { isReadOnlyByLayout } from '../sessions/validate.ts';
import { ScanError, WorkspaceScanner } from '../solutions/scanner.ts';
import { runTodo, type TodoRunContext } from '../todos/run.ts';
import { todoRunOptions } from '../todos/run-options.ts';
import { TodoError } from '../todos/service.ts';
import { WorktreeError } from '../worktrees/manager.ts';
import type { PlanRecord } from './repo.ts';
import type { TodoRecord } from '../db/repos/todos.ts';
import { type PlanEnvironment, PlanError, type PlanRepoRef, type PlanRunInput } from './service.ts';

/** What {@link planEnvironment} needs: the todo-run context (D76) plus the accounts, the Inbox and a message sender. */
export interface PlanEnvironmentDeps {
  readonly context: TodoRunContext;
  readonly accounts: AccountService;
  readonly systemItems: SystemItemService;
  /** Sends a service message to a session (a hooked one through its mailbox). */
  readonly send: (sessionId: string, text: string) => Promise<void>;
  /** D109: whether the shared PR watcher sends red checks itself. */
  readonly ciSendsFailures?: () => Promise<boolean>;
  /** D109: a PR was opened for a run session (the watcher reads it now). */
  readonly prOpened?: (sessionId: string) => Promise<void>;
  readonly now?: () => number;
}

function refusalText(body: unknown): string {
  if (typeof body !== 'object' || body === null) return 'the run was refused';
  const value = body as Record<string, unknown>;
  if (typeof value['message'] === 'string') return value['message'];
  if (Array.isArray(value['errors'])) return value['errors'].map((error) => (typeof error === 'object' && error !== null ? String((error as Record<string, unknown>)['message'] ?? '') : '')).filter(Boolean).join('; ') || 'the run was refused';
  return typeof value['error'] === 'string' ? value['error'] : 'the run was refused';
}

/**
 * D99: the real {@link PlanEnvironment}: plan repos resolve like a todo run's (D76: the source
 * session's saved folder; a workspace's solutions through the worktree manager), an item runs
 * through {@link runTodo} with the plan's overrides, the usage gate reads the account the run
 * would use (D82's routing, then D63's pick; D98's merged readings), and notices go to the Inbox.
 */
export function planEnvironment(deps: PlanEnvironmentDeps): PlanEnvironment {
  const { context, accounts, systemItems } = deps;
  const { store, folders, worktrees } = context;
  const now = deps.now ?? Date.now;
  return {
    async repos(sourceSessionId: string, names: readonly string[] | null) {
      const source = await store.sessions.get(sourceSessionId);
      if (!source) throw new PlanError(404, 'not-found', `no session ${sourceSessionId}`);
      if (!source.folderId) throw new PlanError(409, 'no-folder', "the session's folder is no longer in the saved folders: add it again");
      let folder;
      try {
        folder = await folders.resolveForSession(source.folderId);
      } catch (error) {
        if (error instanceof FolderError) throw new PlanError(409, 'no-folder', error.message);
        throw error;
      }
      if (folder.kind === 'repo') return { kind: 'repo' as const, repos: [{ name: repoSolutionName(folder), repoPath: folder.root }] };
      if (folder.kind !== 'workspace') return { kind: 'plain' as const, repos: [] };
      const out: PlanRepoRef[] = [];
      for (const name of names ?? source.solutions) {
        try {
          out.push({ name, repoPath: (await worktrees.resolveRepo(name, folder)).repoPath });
        } catch (error) {
          if (error instanceof WorktreeError) throw new PlanError(422, 'invalid', `${name} is not a solution repository of this workspace: ${error.message}`, 'repos');
          throw error;
        }
      }
      return { kind: 'workspace' as const, repos: out };
    },

    // D115: the workspace's solutions an item may work in (the import dialog's Repositories picker's list).
    async workspaceSolutions(sourceSessionId: string) {
      const source = await store.sessions.get(sourceSessionId);
      if (!source) throw new PlanError(404, 'not-found', `no session ${sourceSessionId}`);
      if (!source.folderId) throw new PlanError(409, 'no-folder', "the session's folder is no longer in the saved folders: add it again");
      let folder;
      try {
        folder = await folders.resolveForSession(source.folderId);
      } catch (error) {
        if (error instanceof FolderError) throw new PlanError(409, 'no-folder', error.message);
        throw error;
      }
      if (folder.kind !== 'workspace') return null;
      let groups;
      try {
        groups = await new WorkspaceScanner({ root: folder.path }).solutions();
      } catch (error) {
        if (error instanceof ScanError) throw new PlanError(409, 'no-folder', error.message);
        throw error;
      }
      const writable: string[] = [];
      const readOnly: string[] = [];
      for (const group of groups) {
        for (const solution of group.solutions) {
          const list = solution.rule === 'read-only' || isReadOnlyByLayout(solution.name) ? readOnly : writable;
          if (!writable.includes(solution.name) && !readOnly.includes(solution.name)) list.push(solution.name);
        }
      }
      return { writable, readOnly };
    },

    async run(input: PlanRunInput) {
      try {
        const outcome = await runTodo(context, input.plan.sourceSessionId, input.todo.id, { branch: input.branch, from: input.from, repoPaths: input.repoPaths, task: input.task, answers: input.answers });
        if (!outcome.ok) return { ok: false as const, message: refusalText(outcome.body) };
        const own = await store.worktrees.list({ sessionId: outcome.result.session.id });
        return { ok: true as const, sessionId: outcome.result.session.id, branch: own[0]?.branch ?? null };
      } catch (error) {
        if (error instanceof TodoError) return { ok: false as const, message: error.message };
        if (error instanceof Error) return { ok: false as const, message: error.message };
        throw error;
      }
    },

    async usageHeld(plan: PlanRecord, todo: TodoRecord) {
      const source = await store.sessions.get(plan.sourceSessionId);
      if (!source) return null;
      const routed = todoRunOptions({ source: { provider: source.provider, model: source.model, effort: source.effort, profileId: source.profileId }, todo, rules: await modelRulesOf(store.settings) });
      const provider = routed.settings.provider;
      const profileId = routed.settings.profileId ?? (await accounts.pick(provider, { check: false })) ?? `default-${provider}`;
      const snapshot = (await accounts.snapshots(provider)).find((candidate) => candidate.id === profileId);
      if (!snapshot) return null;
      if (snapshot.exhaustedUntil !== null && Date.parse(snapshot.exhaustedUntil) > now()) return `the account ${snapshot.name} is out of usage until ${snapshot.exhaustedUntil}`;
      const windows: Array<[string, number | null]> = [
        ['5-hour', snapshot.usage?.fiveHourPct ?? null],
        ['weekly', snapshot.usage?.sevenDayPct ?? null],
      ];
      for (const [window, pct] of windows) {
        if (pct !== null && pct >= plan.usageThreshold) return `the account ${snapshot.name} is at ${Math.round(pct)}% of its ${window} limit (the plan starts items below ${plan.usageThreshold}%)`;
      }
      return null;
    },

    send: deps.send,

    // D117 follow-up: Delete plan stops its running item sessions through the session's own Stop (D50, the supervisor's interrupt).
    async stopTurn(sessionId: string) {
      if ((await store.sessions.get(sessionId))?.hooked === true) return 'hooked' as const;
      return (await context.supervisor.interrupt(sessionId)).outcome;
    },

    ...(deps.ciSendsFailures ? { ciSendsFailures: deps.ciSendsFailures } : {}),
    ...(deps.prOpened ? { prOpened: deps.prOpened } : {}),

    async notice(input) {
      await systemItems.planNotice(input);
    },

    // D102: the "Ready to merge" Inbox item (Merge runs through the Plans hook, `plansInboxMerge`).
    async mergeNotice(input) {
      await systemItems.planMergeNotice(input);
    },

    async closeMergeNotice(itemId, outcome) {
      await systemItems.closePlanMergeNotices(itemId, outcome);
    },

    // D115 follow-ups: "<n> items of <plan> wait for repositories" (Ask again runs through the Plans hook, `plansInboxAskRepos`).
    async pickReposNotice(input) {
      await systemItems.planPickReposNotice(input);
    },

    async closePickReposNotices(planId, outcome) {
      await systemItems.closePlanPickReposNotices(planId, outcome);
    },

    // D120: "Stopped: <item> (<plan>)" (Open session is a link to the item's run session; Dismiss).
    async stoppedNotice(input) {
      await systemItems.planStoppedNotice(input);
    },

    async closeStoppedNotices(itemId, outcome) {
      await systemItems.closePlanStoppedNotices(itemId, outcome);
    },
  };
}
