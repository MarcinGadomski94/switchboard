import path from 'node:path';
import type { BranchRef, InboxAction, NewSessionPrefill, Worktree } from '../../core/api.ts';
import { COORDINATIONS, PHASES, SESSION_MODES } from '../../core/model.ts';
import type { InstallKind } from '../../core/updates.ts';
import type { UserMessageOrigin } from '../../core/event-payload.ts';
import { type MergeKind, type ParentMerged, parentMergedMessage, parentMergedTitle, rebaseCommand } from '../../core/stacking.ts';
import type { ScheduleRecord, ScheduleRunRecord } from '../db/repos/schedules.ts';
import type { SystemItemCreate, SystemItemRecord } from '../db/repos/system-items.ts';
import type { WorktreeRecord } from '../db/repos/worktrees.ts';
import type { Store } from '../db/store.ts';
import { StoreError } from '../db/table.ts';
import type { HubBus } from '../hub/bus.ts';
import { WorktreeError } from '../worktrees/manager.ts';
import { inboxCount, sessionBranches } from './wire.ts';
// Plans (D99) hook (D102): the "Ready to merge" item's Merge.
import { plansInboxAskRepos, plansInboxMerge } from '../plans/hooks.ts';
// Project memory (D107) hook: a moved member's memory copy, Retry / Keep on this PC (docs/memory-removal.md).
import { MEMORY_COPY_KEEP, MEMORY_COPY_RETRY, memoryInboxAction } from '../memory/hooks.ts';

/**
 * System Inbox items (M3.3, `docs/system-items.md`): the items the service raises
 * itself, "Scheduled run failed" (a `schedule_runs` row with result `fail`) and
 * "PR merged" (a worktree the M2.2 manager flagged removable), and their actions
 * through `POST /api/inbox/{id}/actions/{action}`. Every item is built from stored
 * state only (D13); each run and each worktree raises at most one item. D47:
 * "Parent … merged — retarget and rebase …" (a stacked worktree whose parent's PR
 * merged), which also sends its session the rule-5 message.
 */

/** Plans (D99) hook (D102): kind of a plan item's "Ready to merge" item, its actions and their ids. */
export const PLAN_READY_TO_MERGE = 'plan-ready-to-merge';
export const PLAN_MERGE = 'plan-merge';
export const OPEN_PLAN = 'open-plan';
export const PLAN_READY_TO_MERGE_ACTIONS: readonly InboxAction[] = [
  { id: PLAN_MERGE, label: 'Merge' },
  { id: OPEN_PLAN, label: 'Open plan' },
];

/**
 * D115 follow-ups 2026-10-20: kind of a plan's "N items wait for repositories" item (its agent did not
 * pick them in time, or could not be asked), its **Ask again** and the item's actions.
 */
export const PLAN_PICK_REPOS = 'plan-pick-repos';
export const PLAN_ASK_REPOS = 'plan-ask-repos';
export const PLAN_PICK_REPOS_ACTIONS: readonly InboxAction[] = [
  { id: PLAN_ASK_REPOS, label: 'Ask again' },
  { id: OPEN_PLAN, label: 'Open plan' },
  { id: 'dismiss', label: 'Dismiss' },
];

/**
 * D120: kind of a plan item's "Stopped: <item> (<plan>)" item (its agent ended its turn without
 * finishing its todo) and its actions: **Open session** (a link to the item's run session, like the
 * PR watcher's) and **Dismiss**.
 */
export const PLAN_STOPPED = 'plan-stopped';
export const PLAN_STOPPED_ACTIONS: readonly InboxAction[] = [
  { id: 'open-session', label: 'Open session' },
  { id: 'dismiss', label: 'Dismiss' },
];

function isPayload(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Kind of the item a failed scheduled run raises. */
export const SCHEDULE_RUN_FAILED = 'schedule-run-failed';
/** Kind of the item a removable worktree raises. */
export const WORKTREE_REMOVABLE = 'worktree-removable';
/** D47: kind of the item a stacked worktree raises when its parent's PR merged. */
export const PARENT_MERGED = 'parent-merged';
/** D47 ruling D47-closed-parent: kind of the item a stacked worktree raises when its parent's PR closed without a merge. */
export const PARENT_CLOSED = 'parent-closed';
/** D47: outbox kind (`pending_messages.kind`) of the parent-merged message when it cannot be sent at once. */
export const PARENT_MERGED_KIND = 'parent-merged';

/** D55: kind of the item a newer Switchboard release raises (one per release version). */
export const UPDATE_AVAILABLE = 'update-available';
/** D55: "What's new": closes the item; the UI opens Settings → Updates (the notes and the Update button). */
export const WHATS_NEW = 'whats-new';
/** D55: the actions of an update item. */
export const UPDATE_AVAILABLE_ACTIONS: readonly InboxAction[] = [
  { id: WHATS_NEW, label: "What's new" },
  { id: 'dismiss', label: 'Dismiss' },
];

/** "Open fix session": closes the item; the UI opens the New-session modal with the item's `prefill`. */
export const OPEN_FIX_SESSION = 'open-fix-session';
/** "Retry run": runs the schedule again through the {@link ScheduleRunner} (M7.1). */
export const RETRY_RUN = 'retry-run';
/** "Remove worktree": `WorktreeManager.remove` (gap #3). */
export const REMOVE_WORKTREE = 'remove-worktree';

/** Actions of a failed scheduled run (prototype copy and order; the first is primary). */
export const SCHEDULE_RUN_FAILED_ACTIONS: readonly InboxAction[] = [
  { id: OPEN_FIX_SESSION, label: 'Open fix session' },
  { id: RETRY_RUN, label: 'Retry run' },
  { id: 'dismiss', label: 'Dismiss' },
];

/** Actions of a removable worktree (prototype copy and order; the first is primary). */
export const WORKTREE_REMOVABLE_ACTIONS: readonly InboxAction[] = [
  { id: REMOVE_WORKTREE, label: 'Remove worktree' },
  { id: 'keep', label: 'Keep' },
];

/** D47: the actions of a parent-merged item (it only informs: the agent, not Switchboard, retargets and rebases). */
export const PARENT_MERGED_ACTIONS: readonly InboxAction[] = [{ id: 'dismiss', label: 'Dismiss' }];

/** D109: kind of "CI keeps failing on PR #n …" (the watcher stopped sending failures: the cap or the same failure twice). */
export const CI_FAILING = 'ci-failing';
/** D109: kind of "PR #n ready to merge" (green and approved, or no approval required). */
export const CI_READY = 'ci-ready';
/** D109: **Merge PR**: `gh pr merge` through the PR watcher (only on this click). */
export const CI_MERGE_PR = 'merge-pr';
/** D109: **Open PR**: a link (`InboxItem.url`); the item stays open. */
export const CI_OPEN_PR = 'open-pr';
/** D109: **Open session**: a link to the item's session; the item stays open. */
export const CI_OPEN_SESSION = 'open-session';
/** D109: **Try again**: the PR's attempts start again and its failure is sent. */
export const CI_TRY_AGAIN = 'try-again';
/** D109: the actions of "CI keeps failing" (the first is primary). */
export const CI_FAILING_ACTIONS: readonly InboxAction[] = [
  { id: CI_OPEN_PR, label: 'Open PR' },
  { id: CI_OPEN_SESSION, label: 'Open session' },
  { id: CI_TRY_AGAIN, label: 'Try again' },
  { id: 'dismiss', label: 'Dismiss' },
];
/** D109: the actions of "ready to merge". */
export const CI_READY_ACTIONS: readonly InboxAction[] = [
  { id: CI_MERGE_PR, label: 'Merge PR' },
  { id: CI_OPEN_PR, label: 'Open PR' },
  { id: 'dismiss', label: 'Dismiss' },
];

/** D109: what the CI items' actions run (the PR watcher, `src/server/ci/watcher.ts`). */
export interface CiActions {
  /** Merge PR: answers `null` when merged, else why not. */
  merge(worktreeId: string): Promise<string | null>;
  /** Try again: the attempts start again. */
  tryAgain(worktreeId: string): Promise<void>;
}

/** Default pause between two {@link SystemItemService.sync} runs of {@link SystemItemService.startWatching}. */
export const DEFAULT_SYNC_MS = 30_000;

/** How many of a schedule's newest runs are read to count the green streak before a failure. */
const STREAK_WINDOW = 200;

/** Why an action on a system item was refused. `code` maps to an HTTP status in the route. */
export type SystemItemErrorCode = 'not-found' | 'unknown-action' | 'not-open' | 'busy' | 'gone' | 'refused' | 'unavailable';

/** A refusal of {@link SystemItemService.act}; the item stays open. */
export class SystemItemError extends Error {
  override name = 'SystemItemError';
  readonly code: SystemItemErrorCode;
  /** The backlog item that provides the missing service (`unavailable` only). */
  readonly item: string | null;
  constructor(code: SystemItemErrorCode, message: string, item: string | null = null) {
    super(message);
    this.code = code;
    this.item = item;
  }
}

/** What "Retry run" needs from the scheduler (M7.1 provides it). */
export interface ScheduleRunner {
  /** Starts one run of the schedule now (a manual run). */
  runNow(scheduleId: string): Promise<unknown>;
}

/** What the service needs from the M2.2 worktree manager. */
export interface WorktreeSource {
  on(name: 'worktreeRemovable', listener: (worktree: Worktree) => void): () => void;
  /** D47: a stacked worktree's parent merged (optional: without it the items come from {@link SystemItemService.sync} only). */
  onParentMerged?(listener: (worktree: WorktreeRecord) => void): () => void;
  /** D47 ruling: a stacked worktree's parent closed without a merge (optional, like {@link onParentMerged}). */
  onParentClosed?(listener: (worktree: WorktreeRecord) => void): () => void;
  /** Removes the worktree folder (gap #3); throws a `WorktreeError` when it refuses. */
  remove(worktreeId: string): Promise<unknown>;
}

/** D47: how the service tells a session that its parent merged (the supervisor). */
export interface SessionMessenger {
  /** Sends `text` (resuming a session without a live process); throws when the session cannot take it (detached, closed). */
  sendMessage(sessionId: string, text: string, origin: UserMessageOrigin): Promise<unknown>;
}

/** Options for {@link SystemItemService}. */
export interface SystemItemServiceOptions {
  readonly store: Store;
  /** Where `inboxChanged` goes (`/hub`). */
  readonly bus?: HubBus;
  /** The worktree manager: its `worktreeRemovable` raises "PR merged", its `remove` serves "Remove worktree". */
  readonly worktrees?: WorktreeSource;
  /** The scheduler (M7.1); "Retry run" answers `unavailable` without one. */
  readonly scheduleRunner?: ScheduleRunner;
  /** D47: sends the parent-merged message (the supervisor); without one the message waits in the session's outbox. */
  readonly sessions?: SessionMessenger;
  /** Called when a background raise or sync fails (default: `console.error`). */
  readonly onError?: (error: unknown) => void;
}

/**
 * Raises and closes the system Inbox items (M3.3). Items come from three paths,
 * all idempotent (one item per failed run, one per worktree, open or closed):
 * the worktree manager's `worktreeRemovable` event, {@link scheduleRunFinished}
 * (the scheduler's hook, M7.1), and {@link sync}, which picks up any failed run or
 * removable worktree in the database that has no item yet (at start and every
 * {@link DEFAULT_SYNC_MS} with {@link startWatching}). `inboxChanged` is published
 * whenever an item is raised or closed.
 */
export class SystemItemService {
  readonly #store: Store;
  readonly #bus: HubBus | null;
  readonly #worktrees: WorktreeSource | null;
  readonly #sessions: SessionMessenger | null;
  readonly #onError: (error: unknown) => void;
  readonly #busy = new Set<string>();
  #runner: ScheduleRunner | null;
  #ci: CiActions | null = null;
  #unsubscribe: (() => void) | null = null;
  #unsubscribeParent: (() => void) | null = null;
  #unsubscribeClosed: (() => void) | null = null;
  #timer: NodeJS.Timeout | undefined;
  #watching = false;
  #syncing: Promise<SystemItemRecord[]> | null = null;

  constructor(options: SystemItemServiceOptions) {
    this.#store = options.store;
    this.#bus = options.bus ?? null;
    this.#worktrees = options.worktrees ?? null;
    this.#runner = options.scheduleRunner ?? null;
    this.#sessions = options.sessions ?? null;
    this.#onError = options.onError ?? ((error) => console.error('switchboard system items:', error));
    if (this.#worktrees) {
      this.#unsubscribe = this.#worktrees.on('worktreeRemovable', (worktree) => {
        this.worktreeRemovable(worktree.id).catch(this.#onError);
      });
      this.#unsubscribeParent =
        this.#worktrees.onParentMerged?.((worktree) => {
          this.parentMerged(worktree.id).catch(this.#onError);
        }) ?? null;
      this.#unsubscribeClosed =
        this.#worktrees.onParentClosed?.((worktree) => {
          this.parentClosed(worktree.id).catch(this.#onError);
        }) ?? null;
    }
  }

  /** Plugs in the scheduler that serves "Retry run" (M7.1). */
  useScheduleRunner(runner: ScheduleRunner | null): void {
    this.#runner = runner;
  }

  /** D109: plugs in the PR watcher that serves Merge PR and Try again. */
  useCi(actions: CiActions | null): void {
    this.#ci = actions;
  }

  // ── raise ─────────────────────────────────────────────────────────────

  /**
   * D109 (`docs/ci.md`): the PR watcher's items: "CI keeps failing on PR #n …" (Open PR /
   * Open session / Try again / Dismiss) and "PR #n ready to merge" (Merge PR / Open PR /
   * Dismiss). Once per `dedupe` (open or closed); `payload.url` is the PR (Open PR's link).
   * A new item is what the devices' push announces (D73, the *Other Inbox items* toggle).
   * @returns the new item, or `null` when this key already raised one.
   */
  async ciNotice(input: { readonly kind: 'ci-failing' | 'ci-ready'; readonly worktreeId: string; readonly sessionId: string | null; readonly title: string; readonly detail: string; readonly url: string | null; readonly repo: string; readonly branch: string; readonly dedupe: string }): Promise<SystemItemRecord | null> {
    const actions = input.kind === CI_FAILING ? CI_FAILING_ACTIONS : CI_READY_ACTIONS;
    const created = await this.#store.systemItems.createOnceByPayload(
      {
        kind: input.kind,
        source: 'ci',
        status: input.kind === CI_FAILING ? 'fail' : 'need',
        title: input.title,
        detail: input.detail,
        branches: [{ solution: input.repo, branch: input.branch }],
        actions: actions.filter((action) => action.id !== CI_OPEN_PR || input.url !== null).map((action) => ({ id: action.id, label: action.label })),
        sessionId: input.sessionId,
        worktreeId: input.worktreeId,
        payload: { dedupe: input.dedupe, ...(input.url ? { url: input.url } : {}) },
      },
      'dedupe',
      input.dedupe,
    );
    if (created) await this.#publishInbox();
    return created;
  }

  /** D109: closes the open CI items of a worktree (only `kinds` when given) with `outcome`; answers how many. */
  async closeCiNotices(worktreeId: string, outcome: string, kinds: readonly string[] = [CI_FAILING, CI_READY]): Promise<number> {
    let closed = 0;
    for (const item of await this.#store.systemItems.list(['open'])) {
      if (item.worktreeId !== worktreeId || !kinds.includes(item.kind)) continue;
      try {
        await this.#store.systemItems.close(item.id, outcome);
        closed += 1;
      } catch (error) {
        if (!(error instanceof StoreError && error.code === 'conflict')) throw error;
      }
    }
    if (closed > 0) await this.#publishInbox();
    return closed;
  }

  /**
   * The scheduler's hook (M7.1): call it when a run ends. A run whose result is
   * `fail` raises its "Scheduled run failed" item (once); anything else does nothing.
   * @returns the new item, or `null`.
   */
  async scheduleRunFinished(runId: string): Promise<SystemItemRecord | null> {
    const created = await this.#raiseRun(runId);
    if (created) await this.#publishInbox();
    return created;
  }

  /**
   * Raises the "PR merged" item of a worktree that is flagged removable and not
   * removed yet (once per worktree).
   * @returns the new item, or `null`.
   */
  async worktreeRemovable(worktreeId: string): Promise<SystemItemRecord | null> {
    const created = await this.#raiseWorktree(worktreeId);
    if (created) await this.#publishInbox();
    return created;
  }

  /**
   * D47: raises the "Parent … merged" item of a stacked worktree whose parent's PR
   * was seen merged (once per worktree) and, with it, tells the session to
   * retarget and rebase ({@link parentMergedMessage}): sent at once (resuming a
   * paused session), else left in its outbox (e.g. while it continues in a
   * terminal); a closed session gets only the item.
   * @returns the new item, or `null`.
   */
  async parentMerged(worktreeId: string): Promise<SystemItemRecord | null> {
    const created = await this.#raiseParent(worktreeId);
    if (created) await this.#publishInbox();
    return created;
  }

  /**
   * D47 ruling D47-closed-parent: raises the "Parent … closed" item of a stacked
   * worktree whose parent's PR closed without a merge (once per worktree). The
   * session gets no message: the developer decides where the task goes.
   * @returns the new item, or `null`.
   */
  async parentClosed(worktreeId: string): Promise<SystemItemRecord | null> {
    const created = await this.#raiseClosed(worktreeId);
    if (created) await this.#publishInbox();
    return created;
  }

  /**
   * D55: raises the "Update available" item of a newer release (once per
   * version, open or closed: a dismissed one never comes back) and closes the
   * open ones of other versions (`superseded`).
   * @returns the new item, or `null`.
   */
  async updateAvailable(update: UpdateItemInput): Promise<SystemItemRecord | null> {
    let changed = await this.#closeUpdates((version) => version !== update.version, 'superseded');
    const created = await this.#store.systemItems.createOnceByPayload(updateAvailableItem(update), 'version', update.version);
    if (created) changed = true;
    if (changed) await this.#publishInbox();
    return created;
  }

  /**
   * D63: an Inbox item about accounts: every account of a CLI is out of usage ("stop and notify"),
   * or an automatic switch failed. Once per `dedupe` key (open or closed); dismiss-only.
   * @returns the new item, or `null` when this key already raised one.
   */
  async accountNotice(input: { readonly kind: 'account-exhausted' | 'account-switch-failed'; readonly sessionId: string; readonly title: string; readonly detail: string; readonly dedupe: string }): Promise<SystemItemRecord | null> {
    const created = await this.#store.systemItems.createOnceByPayload(
      {
        kind: input.kind,
        source: 'accounts',
        status: 'need',
        title: input.title,
        detail: input.detail,
        branches: [],
        actions: [{ id: 'dismiss', label: 'Dismiss' }],
        sessionId: input.sessionId,
        payload: { dedupe: input.dedupe },
      },
      'dedupe',
      input.dedupe,
    );
    if (created) await this.#publishInbox();
    return created;
  }

  /**
   * D103 (`docs/accounts.md` → *Credits*): an Inbox item about an account's credits:
   * it started paying from credits (`account-credits`), or its credits left fell
   * below 20 % of the limit (`account-credits-low`). Not tied to a session; once
   * per `dedupe` key (open or closed); dismiss-only. A new Inbox item is what the
   * devices' push (D73, the Inbox toggle) announces.
   * @returns the new item, or `null` when this key already raised one.
   */
  async creditNotice(input: { readonly kind: 'account-credits' | 'account-credits-low'; readonly title: string; readonly detail: string; readonly dedupe: string }): Promise<SystemItemRecord | null> {
    const created = await this.#store.systemItems.createOnceByPayload(
      {
        kind: input.kind,
        source: 'accounts',
        status: 'need',
        title: input.title,
        detail: input.detail,
        branches: [],
        actions: [{ id: 'dismiss', label: 'Dismiss' }],
        sessionId: null,
        payload: { dedupe: input.dedupe },
      },
      'dedupe',
      input.dedupe,
    );
    if (created) await this.#publishInbox();
    return created;
  }

  /**
   * Plans (D99) hook (`docs/plans.md`): an Inbox item about a plan: every item is done ("Plan ready: <target>
   * → <base>", the developer merges the epic), or an item's branch conflicts with the target a
   * second time (a question to the developer), or (D99 follow-up 2026-10-15, `plan-confirm`) a held item
   * of a plan without a merge step waits for the developer to confirm it. Once per `dedupe` key (open or
   * closed); dismiss-only (a `plan-confirm` item is also closed when its item is done or fails:
   * {@link closePlanMergeNotices}).
   * @returns the new item, or `null` when this key already raised one.
   */
  async planNotice(input: { readonly kind: 'plan-ready' | 'plan-conflict' | 'plan-confirm'; readonly sessionId: string; readonly title: string; readonly detail: string; readonly dedupe: string }): Promise<SystemItemRecord | null> {
    const created = await this.#store.systemItems.createOnceByPayload(
      {
        kind: input.kind,
        source: 'plans',
        status: 'need',
        title: input.title,
        detail: input.detail,
        branches: [],
        actions: [{ id: 'dismiss', label: 'Dismiss' }],
        sessionId: input.sessionId,
        payload: { dedupe: input.dedupe },
      },
      'dedupe',
      input.dedupe,
    );
    if (created) await this.#publishInbox();
    return created;
  }

  /**
   * Plans (D99) hook (D102, `docs/plans.md` → *Merge step*): the "Ready to merge: <item> (<plan>)"
   * item of a plan item waiting for the developer's Merge: **Merge** (runs the plan's Merge
   * through {@link plansInboxMerge}) and **Open plan** (the UI goes to `payload.route` and leaves
   * the item open). Once per `dedupe`; Plans closes it when the item is merged, sent back or fails.
   * @returns the new item, or `null` when this key already raised one.
   */
  async planMergeNotice(input: { readonly sessionId: string; readonly planId: string; readonly itemId: string; readonly title: string; readonly detail: string; readonly dedupe: string }): Promise<SystemItemRecord | null> {
    const created = await this.#store.systemItems.createOnceByPayload(
      {
        kind: PLAN_READY_TO_MERGE,
        source: 'plans',
        status: 'need',
        title: input.title,
        detail: input.detail,
        branches: [],
        actions: PLAN_READY_TO_MERGE_ACTIONS.map((action) => ({ id: action.id, label: action.label })),
        sessionId: input.sessionId,
        payload: { dedupe: input.dedupe, planId: input.planId, itemId: input.itemId, route: `/plans/${encodeURIComponent(input.planId)}` },
      },
      'dedupe',
      input.dedupe,
    );
    if (created) await this.#publishInbox();
    return created;
  }

  /**
   * Plans (D99) hook (D115 follow-ups 2026-10-20, `docs/plans.md` → *Repositories picked by the
   * plan's agent*): "<n> items of <plan> wait for repositories": the plan's agent did not pick them
   * in time, or could not be asked. **Ask again** (asks the agent again through
   * {@link plansInboxAskRepos}, which re-arms the check), **Open plan** (a link), **Dismiss**.
   * One open item per plan: a newer one closes the older (`superseded`); Plans closes it once every
   * item has its repositories.
   * @returns the new item, or `null` when this `dedupe` key already raised one.
   */
  async planPickReposNotice(input: { readonly sessionId: string; readonly planId: string; readonly title: string; readonly detail: string; readonly dedupe: string }): Promise<SystemItemRecord | null> {
    await this.#closePickRepos(input.planId, 'superseded', input.dedupe);
    const created = await this.#store.systemItems.createOnceByPayload(
      {
        kind: PLAN_PICK_REPOS,
        source: 'plans',
        status: 'need',
        title: input.title,
        detail: input.detail,
        branches: [],
        actions: PLAN_PICK_REPOS_ACTIONS.map((action) => ({ id: action.id, label: action.label })),
        sessionId: input.sessionId,
        payload: { dedupe: input.dedupe, planId: input.planId, route: `/plans/${encodeURIComponent(input.planId)}` },
      },
      'dedupe',
      input.dedupe,
    );
    await this.#publishInbox();
    return created;
  }

  /** Plans (D99) hook (D115 follow-ups): closes plan `planId`'s open "wait for repositories" items with `outcome`; answers how many. */
  async closePlanPickReposNotices(planId: string, outcome: string): Promise<number> {
    const closed = await this.#closePickRepos(planId, outcome, null);
    if (closed > 0) await this.#publishInbox();
    return closed;
  }

  async #closePickRepos(planId: string, outcome: string, keep: string | null): Promise<number> {
    let closed = 0;
    for (const item of await this.#store.systemItems.list(['open'])) {
      if (item.kind !== PLAN_PICK_REPOS || !isPayload(item.payload) || item.payload['planId'] !== planId) continue;
      if (keep !== null && item.payload['dedupe'] === keep) continue;
      try {
        await this.#store.systemItems.close(item.id, outcome);
        closed += 1;
      } catch (error) {
        if (!(error instanceof StoreError && error.code === 'conflict')) throw error;
      }
    }
    return closed;
  }

  /**
   * Plans (D99) hook (D120, `docs/plans.md` → *Stopped items*): "Stopped: <item> (<plan>)", a plan
   * item whose agent ended its turn without finishing its todo, with the agent's last message (cut)
   * as the detail: **Open session** (a link to the item's run session, `sessionId`) and **Dismiss**.
   * Once per `dedupe` (one per stop episode, open or closed); Plans closes it when the item leaves `stopped`.
   * @returns the new item, or `null` when this key already raised one.
   */
  async planStoppedNotice(input: { readonly sessionId: string; readonly planId: string; readonly itemId: string; readonly title: string; readonly detail: string; readonly dedupe: string }): Promise<SystemItemRecord | null> {
    const created = await this.#store.systemItems.createOnceByPayload(
      {
        kind: PLAN_STOPPED,
        source: 'plans',
        status: 'need',
        title: input.title,
        detail: input.detail,
        branches: [],
        actions: PLAN_STOPPED_ACTIONS.map((action) => ({ id: action.id, label: action.label })),
        sessionId: input.sessionId,
        payload: { dedupe: input.dedupe, planId: input.planId, itemId: input.itemId, route: `/plans/${encodeURIComponent(input.planId)}` },
      },
      'dedupe',
      input.dedupe,
    );
    if (created) await this.#publishInbox();
    return created;
  }

  /** Plans (D99) hook (D120): closes the open "Stopped" items of plan item `itemId` with `outcome`; answers how many. */
  async closePlanStoppedNotices(itemId: string, outcome: string): Promise<number> {
    let closed = 0;
    for (const item of await this.#store.systemItems.list(['open'])) {
      if (item.kind !== PLAN_STOPPED || !isPayload(item.payload) || item.payload['itemId'] !== itemId) continue;
      try {
        await this.#store.systemItems.close(item.id, outcome);
        closed += 1;
      } catch (error) {
        if (!(error instanceof StoreError && error.code === 'conflict')) throw error;
      }
    }
    if (closed > 0) await this.#publishInbox();
    return closed;
  }

  /** Plans (D99) hook (D102): closes the open "Ready to merge" items of plan item `itemId` with `outcome`; answers how many. */
  async closePlanMergeNotices(itemId: string, outcome: string): Promise<number> {
    let closed = 0;
    for (const item of await this.#store.systemItems.list(['open'])) {
      const confirm = item.kind === 'plan-confirm' && isPayload(item.payload) && typeof item.payload['dedupe'] === 'string' && item.payload['dedupe'].startsWith(`plan-confirm:${itemId}:`);
      if (!confirm && (item.kind !== PLAN_READY_TO_MERGE || !isPayload(item.payload) || item.payload['itemId'] !== itemId)) continue;
      try {
        await this.#store.systemItems.close(item.id, outcome);
        closed += 1;
      } catch (error) {
        if (!(error instanceof StoreError && error.code === 'conflict')) throw error;
      }
    }
    if (closed > 0) await this.#publishInbox();
    return closed;
  }

  /**
   * D55: closes the open "Update available" items of versions at or below
   * `current` (closed with `updated`: this Switchboard runs that version or a
   * newer one). The updater calls it at start.
   * @returns how many were closed.
   */
  async updatesResolved(current: string, isAtOrBelow: (version: string, current: string) => boolean): Promise<number> {
    let count = 0;
    for (const item of await this.#store.systemItems.list(['open'])) {
      if (item.kind !== UPDATE_AVAILABLE) continue;
      const version = updateItemVersion(item);
      if (version !== null && !isAtOrBelow(version, current)) continue;
      try {
        await this.#store.systemItems.close(item.id, 'updated');
        count++;
      } catch {
        // Closed meanwhile.
      }
    }
    if (count > 0) await this.#publishInbox();
    return count;
  }

  async #closeUpdates(match: (version: string) => boolean, action: string): Promise<boolean> {
    let changed = false;
    for (const item of await this.#store.systemItems.list(['open'])) {
      if (item.kind !== UPDATE_AVAILABLE) continue;
      const version = updateItemVersion(item);
      if (version === null || !match(version)) continue;
      try {
        await this.#store.systemItems.close(item.id, action);
        changed = true;
      } catch {
        // Closed meanwhile.
      }
    }
    return changed;
  }

  /**
   * Raises the items of every failed run and every removable worktree in the
   * database that has none yet (runs, then worktrees, oldest first; D47: then
   * the stacked worktrees whose parent merged). Concurrent calls share one run.
   * @returns the items raised.
   */
  sync(): Promise<SystemItemRecord[]> {
    this.#syncing ??= (async () => {
      try {
        const raised: SystemItemRecord[] = [];
        for (const runId of await this.#store.systemItems.failedRunsWithoutItem(SCHEDULE_RUN_FAILED)) {
          const created = await this.#raiseRun(runId);
          if (created) raised.push(created);
        }
        for (const worktreeId of await this.#store.systemItems.removableWorktreesWithoutItem(WORKTREE_REMOVABLE)) {
          const created = await this.#raiseWorktree(worktreeId);
          if (created) raised.push(created);
        }
        for (const worktreeId of await this.#store.systemItems.parentMergedWorktreesWithoutItem(PARENT_MERGED)) {
          const created = await this.#raiseParent(worktreeId);
          if (created) raised.push(created);
        }
        for (const worktreeId of await this.#store.systemItems.parentClosedWorktreesWithoutItem(PARENT_CLOSED)) {
          const created = await this.#raiseClosed(worktreeId);
          if (created) raised.push(created);
        }
        if (raised.length > 0) await this.#publishInbox();
        return raised;
      } finally {
        this.#syncing = null;
      }
    })();
    return this.#syncing;
  }

  /** Runs {@link sync} now and then every `intervalMs` until {@link stopWatching}. */
  startWatching(options: { readonly intervalMs?: number } = {}): void {
    if (this.#watching) return;
    this.#watching = true;
    const interval = options.intervalMs ?? DEFAULT_SYNC_MS;
    const tick = async (): Promise<void> => {
      this.#timer = undefined;
      if (!this.#watching) return;
      try {
        await this.sync();
      } catch (error) {
        this.#onError(error);
      }
      if (this.#watching) {
        this.#timer = setTimeout(() => void tick(), interval);
        this.#timer.unref();
      }
    };
    void tick();
  }

  /** Stops the timer and waits for a sync that is still running. */
  async stopWatching(): Promise<void> {
    this.#watching = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#syncing) await this.#syncing.catch(() => undefined);
  }

  /** Stops watching and stops listening to the worktree manager. */
  async close(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#unsubscribeParent?.();
    this.#unsubscribeParent = null;
    this.#unsubscribeClosed?.();
    this.#unsubscribeClosed = null;
    await this.stopWatching();
  }

  async #raiseRun(runId: string): Promise<SystemItemRecord | null> {
    const run = await this.#store.schedules.getRun(runId);
    if (!run || run.result !== 'fail') return null;
    const schedule = await this.#store.schedules.get(run.scheduleId);
    if (!schedule) return null;
    const recent = await this.#store.schedules.recentRuns(schedule.id, STREAK_WINDOW);
    const branches = run.sessionId ? await sessionBranches(this.#store, run.sessionId) : [];
    return this.#store.systemItems.createOnce(failedRunItem(schedule, run, recent, branches));
  }

  async #raiseWorktree(worktreeId: string): Promise<SystemItemRecord | null> {
    const worktree = await this.#store.worktrees.get(worktreeId);
    if (!worktree || !worktree.removable || worktree.removedAt) return null;
    return this.#store.systemItems.createOnce(removableWorktreeItem(worktree));
  }

  async #raiseParent(worktreeId: string): Promise<SystemItemRecord | null> {
    const worktree = await this.#store.worktrees.get(worktreeId);
    if (!worktree || worktree.parentMergedAt === null || worktree.parentBranch === null || worktree.parentBase === null) return null;
    const session = worktree.sessionId ? await this.#store.sessions.get(worktree.sessionId) : null;
    const open = session !== null && session.closedAt === null;
    const merged = parentMergedOf(worktree);
    const created = await this.#store.systemItems.createOnce(parentMergedItem(worktree, merged, open));
    if (!created || !open || !session) return created;
    // Once per parent per repo: only the call that raised the item tells the session.
    const text = parentMergedMessage(merged);
    try {
      if (!this.#sessions) throw new Error('no session messenger');
      await this.#sessions.sendMessage(session.id, text, 'service');
    } catch {
      // Detached (a terminal owns it), the service closing, …: the message waits for the session's next run.
      await this.#store.pendingMessages.enqueue({ sessionId: session.id, kind: PARENT_MERGED_KIND, text });
    }
    return created;
  }

  async #raiseClosed(worktreeId: string): Promise<SystemItemRecord | null> {
    const worktree = await this.#store.worktrees.get(worktreeId);
    if (!worktree || worktree.parentClosedAt === null || worktree.parentMergedAt !== null || worktree.parentBranch === null || worktree.removedAt) return null;
    const session = worktree.sessionId ? await this.#store.sessions.get(worktree.sessionId) : null;
    return this.#store.systemItems.createOnce(parentClosedItem(worktree, session?.branching?.epic?.branch ?? null));
  }

  // ── act ───────────────────────────────────────────────────────────────

  /** `true` if `id` is a system item (the actions route also serves permission items). */
  async isSystemItem(id: string): Promise<boolean> {
    return (await this.#store.systemItems.get(id)) !== null;
  }

  /**
   * `POST /api/inbox/{id}/actions/{action}` for a system item: runs the action,
   * then closes the item with it. `retry-run` asks the scheduler for a run now;
   * `remove-worktree` removes the worktree folder (gap #3: refused while it holds
   * uncommitted or unpushed work, never `--force`, the branch is kept; a folder
   * already removed counts as done); every other listed action (`open-fix-session`,
   * `dismiss`, `keep`) only closes the item. A refused action leaves it open.
   * @throws {SystemItemError} `not-found`, `unknown-action`, `not-open`, `busy`, `gone`, `unavailable`.
   * @throws {WorktreeError} when the worktree manager refuses the removal.
   */
  async act(id: string, action: string): Promise<SystemItemRecord> {
    const item = await this.#store.systemItems.get(id);
    if (!item) throw new SystemItemError('not-found', `no Inbox item ${id}`);
    if (!item.actions.some((known) => known.id === action)) throw new SystemItemError('unknown-action', `this item has no action "${action}"`);
    if (item.state !== 'open') throw new SystemItemError('not-open', 'this item is already closed');
    if (this.#busy.has(id)) throw new SystemItemError('busy', 'an action on this item is still running');
    this.#busy.add(id);
    try {
      await this.#perform(item, action);
      // D102: the action may have closed the item itself (a plan's Merge closes its "Ready to merge" item).
      const after = await this.#store.systemItems.get(id);
      if (after && after.state !== 'open') {
        await this.#publishInbox();
        return after;
      }
      let closed: SystemItemRecord;
      try {
        closed = await this.#store.systemItems.close(id, action);
      } catch (error) {
        if (error instanceof StoreError && error.code === 'conflict') throw new SystemItemError('not-open', 'this item is already closed');
        throw error;
      }
      await this.#publishInbox();
      return closed;
    } finally {
      this.#busy.delete(id);
    }
  }

  async #perform(item: SystemItemRecord, action: string): Promise<void> {
    // Plans (D99) hook (D102): a plan item's Merge from its "Ready to merge" item.
    if (action === PLAN_MERGE) {
      const planId = isPayload(item.payload) ? item.payload['planId'] : null;
      const itemId = isPayload(item.payload) ? item.payload['itemId'] : null;
      if (typeof planId !== 'string' || typeof itemId !== 'string') throw new SystemItemError('gone', 'the plan item is no longer known');
      const refused = await plansInboxMerge(this.#store, planId, itemId);
      if (refused !== null) throw new SystemItemError('refused', refused);
      return;
    }
    // D115 follow-ups: a plan's "wait for repositories" item asks the plan's agent again.
    if (action === PLAN_ASK_REPOS) {
      const planId = isPayload(item.payload) ? item.payload['planId'] : null;
      if (typeof planId !== 'string') throw new SystemItemError('gone', 'the plan is no longer known');
      const refused = await plansInboxAskRepos(this.#store, planId);
      if (refused !== null) throw new SystemItemError('refused', refused);
      return;
    }
    if (action === OPEN_PLAN) throw new SystemItemError('refused', 'Open plan is a link: open the plan page');
    // Project memory (D107) hook (follow-up 2026-10-16): copy a moved member's memory again, or keep it on this PC.
    if (action === MEMORY_COPY_RETRY || action === MEMORY_COPY_KEEP) {
      const refused = await memoryInboxAction(this.#store, item.payload, action);
      if (refused !== null) throw new SystemItemError('refused', refused);
      return;
    }
    // D109: the PR watcher's items.
    if (action === CI_OPEN_PR || action === CI_OPEN_SESSION) throw new SystemItemError('refused', 'this action is a link: open it in the app');
    if (action === CI_MERGE_PR || action === CI_TRY_AGAIN) {
      if (!item.worktreeId) throw new SystemItemError('gone', 'the worktree is no longer registered');
      if (!this.#ci) throw new SystemItemError('unavailable', 'the PR watcher is not available');
      if (action === CI_TRY_AGAIN) {
        await this.#ci.tryAgain(item.worktreeId);
        return;
      }
      const refused = await this.#ci.merge(item.worktreeId);
      if (refused !== null) throw new SystemItemError('refused', refused);
      return;
    }
    if (action === RETRY_RUN) {
      if (!item.scheduleId || !(await this.#store.schedules.get(item.scheduleId))) {
        throw new SystemItemError('gone', 'the schedule no longer exists');
      }
      if (!this.#runner) throw new SystemItemError('unavailable', 'the scheduler is not available yet', 'M7.1');
      await this.#runner.runNow(item.scheduleId);
      return;
    }
    if (action === REMOVE_WORKTREE) {
      if (!item.worktreeId) throw new SystemItemError('gone', 'the worktree is no longer registered');
      if (!this.#worktrees) throw new SystemItemError('unavailable', 'the worktree manager is not available');
      try {
        await this.#worktrees.remove(item.worktreeId);
      } catch (error) {
        if (!(error instanceof WorktreeError && error.code === 'removed')) throw error;
      }
    }
  }

  async #publishInbox(): Promise<void> {
    if (!this.#bus) return;
    this.#bus.publish('inboxChanged', { count: await inboxCount(this.#store) });
  }
}

// ── item builders (pure) ───────────────────────────────────────────────

/** D55: what the "Update available" item says. */
export interface UpdateItemInput {
  /** The new release's version (`1.1.0`). */
  readonly version: string;
  readonly tag: string;
  /** This install's version. */
  readonly current: string;
  readonly kind: InstallKind;
}

/** D55: the version an update item is about (`payload.version`), else `null`. */
export function updateItemVersion(item: SystemItemRecord): string | null {
  const payload = item.payload;
  return isRecord(payload) && typeof payload['version'] === 'string' ? payload['version'] : null;
}

/**
 * D55: the "Update available" item: source `switchboard`, title `Switchboard
 * <v> is available`, a detail that says what happens next for this install kind
 * (a release install updates from Settings → Updates; a git checkout only gets
 * the commands), What's new + Dismiss, `payload.version`.
 */
export function updateAvailableItem(update: UpdateItemInput): SystemItemCreate {
  const detail =
    update.kind === 'git'
      ? `You run ${update.current} from a git checkout, so Switchboard does not update itself: fetch ${update.tag}, run npm ci and npm run build, then restart. What's new shows the release notes and the commands.`
      : `You run ${update.current}. What's new shows the release notes and the Update button: Switchboard downloads the release, checks its checksum, installs it next to this one and restarts.`;
  return {
    kind: UPDATE_AVAILABLE,
    source: 'switchboard',
    status: 'idle',
    title: `Switchboard ${update.version} is available`,
    detail,
    branches: [],
    actions: UPDATE_AVAILABLE_ACTIONS.map((action) => ({ id: action.id, label: action.label })),
    sessionId: null,
    payload: { version: update.version, tag: update.tag },
  };
}

/**
 * The green streak before `run`: how many runs right before it (by time) ended
 * `ok`, from `recent` (a schedule's newest runs, oldest first). `null` when `run`
 * is not among them.
 */
export function greenStreak(run: ScheduleRunRecord, recent: readonly ScheduleRunRecord[]): number | null {
  const index = recent.findIndex((candidate) => candidate.id === run.id);
  if (index === -1) return null;
  let count = 0;
  for (let i = index - 1; i >= 0 && recent[i]?.result === 'ok'; i--) count++;
  return count;
}

/** The detail sentence of a green streak (prototype: "The previous 13 runs were green."); empty for none. */
export function streakSentence(count: number | null): string {
  if (count === null || count === 0) return '';
  return count === 1 ? 'The previous run was green.' : `The previous ${count} runs were green.`;
}

/**
 * The "Scheduled run failed" item of a failed run: source = the schedule's name,
 * title = the run's summary (else `<schedule> failed`), detail = the green streak
 * before it, branch chips of the session the run started, the prototype's actions
 * and, in `payload.prefill`, the New-session values of "Open fix session"
 * ({@link fixSessionPrefill}). Dated when the run ended.
 */
export function failedRunItem(
  schedule: ScheduleRecord,
  run: ScheduleRunRecord,
  recent: readonly ScheduleRunRecord[],
  branches: readonly BranchRef[],
): SystemItemCreate {
  const title = run.summary?.trim() || `${schedule.name} failed`;
  return {
    kind: SCHEDULE_RUN_FAILED,
    source: schedule.name,
    status: 'fail',
    title,
    detail: streakSentence(greenStreak(run, recent)),
    branches: branches.map((ref) => ({ solution: ref.solution, branch: ref.branch })),
    actions: SCHEDULE_RUN_FAILED_ACTIONS.map((action) => ({ id: action.id, label: action.label })),
    sessionId: run.sessionId,
    scheduleId: schedule.id,
    scheduleRunId: run.id,
    payload: { prefill: fixSessionPrefill(schedule, title, branches) },
    createdAt: run.finishedAt ?? run.ts,
  };
}

/**
 * The "PR merged" item of a removable worktree (prototype copy): title
 * `PR #<n> merged, so the worktree can be removed`, detail `<worktree path relative
 * to its repo> · branch <b> was merged on GitHub (checked through gh). No
 * uncommitted changes.` (the manager flags a worktree removable only then), the
 * `<repo> ⎇ <branch>` chip. Dated when gh was checked.
 */
export function removableWorktreeItem(worktree: WorktreeRecord): SystemItemCreate {
  const where = path.relative(worktree.repoPath, worktree.path) || worktree.path;
  return {
    kind: WORKTREE_REMOVABLE,
    source: 'worktrees',
    status: 'done',
    title: worktree.prNumber === null ? 'The PR was merged, so the worktree can be removed' : `PR #${worktree.prNumber} merged, so the worktree can be removed`,
    detail: `${where} · branch ${worktree.branch} was merged on GitHub (checked through gh). No uncommitted changes.`,
    branches: [{ solution: worktree.repo, branch: worktree.branch }],
    actions: WORKTREE_REMOVABLE_ACTIONS.map((action) => ({ id: action.id, label: action.label })),
    sessionId: worktree.sessionId,
    worktreeId: worktree.id,
    payload: null,
    ...(worktree.prCheckedAt ? { createdAt: worktree.prCheckedAt } : {}),
  };
}

/** D47: what the parent-merged message and item name, from a stacked worktree's stored parent fields. */
export function parentMergedOf(worktree: WorktreeRecord): ParentMerged {
  const merge: MergeKind = worktree.parentMerge === 'merge' || worktree.parentMerge === 'squash' ? worktree.parentMerge : 'unknown';
  return {
    solution: worktree.repo,
    task: worktree.branch,
    parent: worktree.parentBranch ?? '',
    parentBase: worktree.parentBase ?? '',
    parentPr: worktree.parentPrNumber,
    oldTip: worktree.parentHeadOid,
    merge,
    childPr: worktree.prNumber,
    worktreePath: worktree.path,
  };
}

/**
 * D47: the "Parent … merged" item of a stacked worktree: title `Parent <parent>
 * merged — retarget and rebase <task>`, detail = the repo, the parent's PR and
 * base, the steps asked of the agent (or, for a closed session, that nothing was
 * sent), the `<repo> ⎇ <task>` chip, Dismiss. Dated when the merge was seen.
 */
export function parentMergedItem(worktree: WorktreeRecord, merged: ParentMerged, sessionOpen: boolean): SystemItemCreate {
  const pr = merged.parentPr !== null ? `PR #${merged.parentPr} ` : '';
  const how = merged.merge === 'squash' ? ' (squash-merged)' : merged.merge === 'merge' ? '' : ' (merge kind unknown)';
  const steps = `retarget the PR to ${merged.parentBase} (gh pr edit ${merged.task} --base ${merged.parentBase}) and rebase: ${rebaseCommand(merged)}`;
  return {
    kind: PARENT_MERGED,
    source: 'worktrees',
    status: 'need',
    title: parentMergedTitle(merged),
    detail: sessionOpen
      ? `${merged.solution} · ${pr}${merged.parent} was merged into ${merged.parentBase}${how}. The session was asked to ${steps}, then report.`
      : `${merged.solution} · ${pr}${merged.parent} was merged into ${merged.parentBase}${how}. The session is closed, so nothing was sent to it: ${steps}.`,
    branches: [{ solution: worktree.repo, branch: worktree.branch }],
    actions: PARENT_MERGED_ACTIONS.map((action) => ({ id: action.id, label: action.label })),
    sessionId: worktree.sessionId,
    worktreeId: worktree.id,
    payload: null,
    ...(worktree.parentMergedAt ? { createdAt: worktree.parentMergedAt } : {}),
  };
}

/**
 * D47 ruling D47-closed-parent: the "Parent … closed" item of a stacked worktree
 * whose parent's PR closed without a merge: title `Parent <parent> closed —
 * retarget <task> to <target>` (the session's epic branch, else the parent PR's
 * base, the repo's default branch), detail with the repo and the PR and that
 * nothing was sent to the session, the `<repo> ⎇ <task>` chip, Dismiss. Dated
 * when the close was seen.
 */
export function parentClosedItem(worktree: WorktreeRecord, epicBranch: string | null): SystemItemCreate {
  const parent = worktree.parentBranch ?? '';
  const target = epicBranch ?? worktree.parentBase ?? "the repo's default branch";
  const pr = worktree.parentPrNumber !== null ? `PR #${worktree.parentPrNumber} ` : '';
  return {
    kind: PARENT_CLOSED,
    source: 'worktrees',
    status: 'need',
    title: `Parent ${parent} closed — retarget ${worktree.branch} to ${target}`,
    detail: `${worktree.repo} · ${pr}${parent} was closed without merging. Nothing was sent to the session: retarget the PR of ${worktree.branch} to ${target} (gh pr edit ${worktree.branch} --base ${target}) and take the parent's commits out of it, or ask the session to.`,
    branches: [{ solution: worktree.repo, branch: worktree.branch }],
    actions: PARENT_MERGED_ACTIONS.map((action) => ({ id: action.id, label: action.label })),
    sessionId: worktree.sessionId,
    worktreeId: worktree.id,
    payload: null,
    ...(worktree.parentClosedAt ? { createdAt: worktree.parentClosedAt } : {}),
  };
}

/** Session names are kebab-case, at most 64 characters (`sessions/validate.ts`). */
const NAME_LIMIT = 64;

/** `text` as a kebab-case name part (`Nightly Build` → `nightly-build`). */
export function kebab(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
}

/**
 * The New-session values of "Open fix session" for a failed run (prototype: name,
 * task, solutions, mode single, phase UI-first): name `fix-<schedule>`, task
 * `<schedule>: <title>.` plus ` Fix on <branch>.` when the run's session had a
 * branch, the schedule template's solutions, mode, phase, coordination and toggles
 * where it has valid ones, work type feature, and the router's recommended mode
 * (single) and phase (UI-first) where it has none; D14: the schedule's folder.
 */
export function fixSessionPrefill(schedule: ScheduleRecord, title: string, branches: readonly BranchRef[]): NewSessionPrefill {
  const template = isRecord(schedule.template) ? schedule.template : {};
  const solutions = Array.isArray(template['solutions']) ? template['solutions'].filter((s): s is string => typeof s === 'string' && s !== '') : [];
  const mode = SESSION_MODES.find((known) => known === template['mode']) ?? 'single';
  const phase = PHASES.find((known) => known === template['phase']) ?? 'ui-first';
  const coordination = COORDINATIONS.find((known) => known === template['coordination']);
  const name = `fix-${kebab(schedule.name)}`.slice(0, NAME_LIMIT).replace(/-+$/, '');
  const branch = branches[0]?.branch;
  const sentence = /[.!?]$/.test(title) ? title : `${title}.`;
  const prefill: { -readonly [K in keyof NewSessionPrefill]: NewSessionPrefill[K] } = {
    name,
    task: `${schedule.name}: ${sentence}${branch ? ` Fix on ${branch}.` : ''}`,
    workType: 'feature',
    mode,
    solutions,
    phase,
  };
  if (coordination) prefill.coordination = coordination;
  if (typeof template['worktrees'] === 'boolean') prefill.worktrees = template['worktrees'];
  if (typeof template['ultracode'] === 'boolean') prefill.ultracode = template['ultracode'];
  // D14: the fix session starts in the schedule's folder.
  const folder = schedule.folderId ?? (typeof template['folder'] === 'string' && template['folder'] !== '' ? template['folder'] : null);
  if (folder) prefill.folder = folder;
  return prefill;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
