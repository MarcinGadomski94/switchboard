import { accountActionWhat, accountWaitReason, sessionProfileId } from '../../core/accounts.ts';
import type { CliProviderId } from '../../core/cli-providers.ts';
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
  /** D145: an item was merged: its run session's merged worktrees are cleaned up. */
  readonly itemMerged?: (sessionId: string) => Promise<void>;
  readonly now?: () => number;
  /** D138: moves a Project's live sessions to its accounts after they changed (the `AccountChoice`); absent: nothing moves. */
  readonly applyProjectAccounts?: (planId: string) => Promise<void>;
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
  /** The CLI and account a step of `plan` for `todo` would start on (D82's routing, D138's Project account, then D63's pick). */
  const stepAccount = async (plan: PlanRecord, todo: TodoRecord): Promise<{ readonly provider: CliProviderId | null; readonly profileId: string }> => {
    const source = await store.sessions.get(plan.sourceSessionId);
    if (!source) return { provider: null, profileId: '' };
    const routed = todoRunOptions({ source: { provider: source.provider, model: source.model, effort: source.effort, profileId: source.profileId }, todo, rules: await modelRulesOf(store.settings) });
    const provider = routed.settings.provider;
    // D138: the Project's account for that CLI first (as the run would start on it).
    const chosen = plan.accounts[provider];
    const profileId = (chosen ? await accounts.pick(provider, { check: false, preferred: chosen }) : null) ?? chosen ?? routed.settings.profileId ?? (await accounts.pick(provider, { check: false })) ?? `default-${provider}`;
    return { provider, profileId };
  };
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
        // D138: the Project's account for the run's CLI, as a preference (it out of usage: the automatic pick).
        // D139: a Project's own account that needs the developer is never left for another (the step waits: usageHeld);
        // without one, a step whose account (D76's, a D82 rule's) needs the developer starts on another with allowance.
        const profileFor = async (provider: CliProviderId): Promise<string | null> => {
          const chosen = input.plan.accounts[provider];
          if (chosen) return (await accounts.blockOf(chosen)) !== null ? chosen : ((await accounts.pick(provider, { check: false, preferred: chosen })) ?? chosen);
          const own = (await stepAccount(input.plan, input.todo)).profileId;
          if ((await accounts.blockOf(own)) === null) return null;
          const other = await accounts.pick(provider, { check: false, preferred: null });
          return other !== null && (await accounts.blockOf(other)) === null ? other : null;
        };
        const outcome = await runTodo(context, input.plan.sourceSessionId, input.todo.id, { branch: input.branch, from: input.from, repoPaths: input.repoPaths, task: input.task, answers: input.answers, sidebarFolder: input.plan.sidebarFolder, profileFor });
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
      const step = await stepAccount(plan, todo);
      if (step.provider === null) return null;
      const provider = step.provider;
      const snapshots = await accounts.snapshots(provider);
      // D139: the Project's own account needs the developer: its steps wait (never moved off it silently).
      const chosen = plan.accounts[provider];
      const chosenSnapshot = chosen ? snapshots.find((candidate) => candidate.id === chosen) : undefined;
      if (chosenSnapshot?.blocked === true) return accountWaitReason(chosenSnapshot.name);
      let profileId = step.profileId;
      // D139: without one, a blocked account gives way to another that can take the step (as the run picks it); none: wait.
      if (!chosen && snapshots.find((candidate) => candidate.id === profileId)?.blocked === true) {
        const other = await accounts.pick(provider, { check: false, preferred: null });
        const otherSnapshot = other !== null ? snapshots.find((candidate) => candidate.id === other) : undefined;
        if (!otherSnapshot || otherSnapshot.blocked === true) return accountWaitReason(snapshots.find((candidate) => candidate.id === profileId)?.name ?? profileId);
        profileId = otherSnapshot.id;
      }
      const snapshot = snapshots.find((candidate) => candidate.id === profileId);
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

    // D139: why a run session cannot start again now: its account needs the developer.
    async accountBlockOf(sessionId: string) {
      const session = await store.sessions.get(sessionId);
      if (!session) return null;
      const profileId = sessionProfileId(session);
      const block = await accounts.blockOf(profileId);
      if (block === null) return null;
      const name = (await store.profiles.get(profileId))?.name ?? profileId;
      return `${accountWaitReason(name)} — ${accountActionWhat(block.kind, session.provider)}`;
    },

    // D139: Restart: the same run session starts again (its lost messages go out again).
    async restartSession(sessionId: string) {
      try {
        await context.supervisor.restartStopped(sessionId);
        return { ok: true as const };
      } catch (error) {
        return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
      }
    },

    // D117 follow-up: Delete plan stops its running item sessions through the session's own Stop (D50, the supervisor's interrupt).
    async stopTurn(sessionId: string) {
      if ((await store.sessions.get(sessionId))?.hooked === true) return 'hooked' as const;
      return (await context.supervisor.interrupt(sessionId)).outcome;
    },

    ...(deps.ciSendsFailures ? { ciSendsFailures: deps.ciSendsFailures } : {}),
    ...(deps.applyProjectAccounts ? { accountsChanged: deps.applyProjectAccounts } : {}),
    ...(deps.prOpened ? { prOpened: deps.prOpened } : {}),
    ...(deps.itemMerged ? { itemMerged: deps.itemMerged } : {}),

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

    // D149: "Done without merging: <item> (<plan>)" (Open session / Open PR are links; Dismiss).
    async unmergedNotice(input) {
      await systemItems.planUnmergedNotice(input);
    },
  };
}
