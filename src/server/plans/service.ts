import { randomBytes } from 'node:crypto';
import type { SessionStatus } from '../../core/model.ts';
import { COORDINATIONS, PHASES, SESSION_MODES, WORK_TYPES } from '../../core/model.ts';
import { shortNameFromTitle } from '../../core/session-title.ts';
import {
  DEFAULT_PLAN_BASE,
  DEFAULT_PLAN_CONCURRENCY,
  DEFAULT_PLAN_USAGE_THRESHOLD,
  PLAN_CONCURRENCY_MAX,
  PLAN_ITEMS_MAX,
  PLAN_MERGE_MODES,
  PLAN_NOTES_MAX,
  PLAN_TITLE_MAX,
  type Plan,
  type PlanAnswers,
  type PlanChecks,
  type PlanEdge,
  type PlanExternalRef,
  type PlanItemFacts,
  type PlanMergeMode,
  type PlanWaitingOn,
  type PlansState,
  PLAN_ITEM_SPANS_MAX,
  planItemSpanKind,
  PLANS_OFF_REASON,
  PLANS_SETTING,
  developerMerges,
  findCycle,
  forbiddenTargetReason,
  isBranchName,
  itemLabel,
  normalizeItemKey,
  planChecksMessage,
  planConflictMessage,
  planItemBranch,
  planItemBrief,
  planRuleChangedMessage,
  planView,
  readyItems,
} from '../../core/plans.ts';
import { PlansDb } from './db.ts';
import { type PlanItemOutcome, registerPlanHooks } from './hooks.ts';
import type { PlanItemPatch, PlanItemRecord, PlanRecord, PlanRepository } from './repo.ts';
import type { TodoRecord } from '../db/repos/todos.ts';
import type { Store } from '../db/store.ts';
import type { HubBus, HubMessage } from '../hub/bus.ts';
import { SYSTEM_CLOCK, type SchedulerClock } from '../schedules/scheduler.ts';
import { TodoError, type TodoService } from '../todos/service.ts';
import type { PlanGitPort, PlanRepoState } from './git.ts';
import { BranchMergeError, BranchMergeGit, type BranchMergeInput, type BranchMergePlan } from '../worktrees/branch-merge.ts';

/** Why the service refused a call: maps to the HTTP answer of the route. */
export class PlanError extends Error {
  override name = 'PlanError';
  readonly status: number;
  readonly code: string;
  readonly field: string | null;
  /** D102: a refused Merge's conflicting files (`conflicts`), else empty. */
  readonly conflicts: readonly string[];
  constructor(status: number, code: string, message: string, field: string | null = null, conflicts: readonly string[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
    this.conflicts = conflicts;
  }

  /** The answer body: `{ error, message }`, with `errors: [{ field, message }]` for a 422 on a field (D102: `conflicts` for a refused Merge). */
  body(): Record<string, unknown> {
    if (this.field !== null) return { error: this.code, message: this.message, errors: [{ field: this.field, message: this.message }] };
    return this.conflicts.length > 0 ? { error: this.code, message: this.message, conflicts: this.conflicts } : { error: this.code, message: this.message };
  }
}

/** A plan repo resolved to its main checkout. */
export interface PlanRepoRef {
  readonly name: string;
  readonly repoPath: string;
}

/** What {@link PlanEnvironment.run} gets: everything a plan item's run needs (D76's machinery with the plan's overrides). */
export interface PlanRunInput {
  readonly plan: PlanRecord;
  readonly item: PlanItemRecord;
  readonly todo: TodoRecord;
  /** The branch's base name (`PROJ-123-<slug>` / `todo/<slug>`). */
  readonly branch: string;
  /** Solution → the ref the worktree is cut from (the target branch). */
  readonly from: Readonly<Record<string, string>>;
  readonly repoPaths: readonly string[];
  readonly task: (branch: string | null) => string;
  readonly answers: { readonly workType: NonNullable<PlanAnswers['workType']>; readonly mode: NonNullable<PlanAnswers['mode']>; readonly phase: NonNullable<PlanAnswers['phase']>; readonly coordination: PlanAnswers['coordination'] } | null;
}

/**
 * D99: what the plan service needs from the rest of Switchboard (the real one is
 * `environment.ts`; the scheduler's unit tests pass fakes).
 */
export interface PlanEnvironment {
  /**
   * The source session's folder kind and the plan repos resolved to their main checkouts:
   * `names` (a workspace's solutions; `null` = the session's own), or the one repo of a repo
   * folder. Throws {@link PlanError} (404 no session, 409 no folder, 422 an unknown repo).
   */
  repos(sourceSessionId: string, names: readonly string[] | null): Promise<{ readonly kind: 'workspace' | 'repo' | 'plain'; readonly repos: readonly PlanRepoRef[] }>;
  /** Starts the item's run (a todo run, D76, with the plan's branch, cut, brief and answers). */
  run(input: PlanRunInput): Promise<{ readonly ok: true; readonly sessionId: string; readonly branch: string | null } | { readonly ok: false; readonly message: string }>;
  /** Why starting this todo now would be held (its account at or above the plan's usage threshold, or spent), `null` = it may start. */
  usageHeld(plan: PlanRecord, todo: TodoRecord): Promise<string | null>;
  /** Sends a service message to a session (red checks, a conflict, a changed merge rule). */
  send(sessionId: string, text: string): Promise<void>;
  /** Raises an Inbox system item (once per `dedupe`). */
  notice(input: { readonly kind: 'plan-ready' | 'plan-conflict'; readonly sessionId: string; readonly title: string; readonly detail: string; readonly dedupe: string }): Promise<void>;
  /** D102: raises the Inbox's "Ready to merge: <item> (<plan>)" item (Merge / Open plan; once per `dedupe`). */
  mergeNotice(input: PlanMergeNotice): Promise<void>;
  /** D102: closes the open "Ready to merge" items of plan item `itemId` (merged, sent back, failed, …) with `outcome`. */
  closeMergeNotice(itemId: string, outcome: string): Promise<void>;
}

/** D102: what the Inbox's "Ready to merge" item says and acts on. */
export interface PlanMergeNotice {
  readonly sessionId: string;
  readonly planId: string;
  readonly itemId: string;
  readonly title: string;
  readonly detail: string;
  readonly dedupe: string;
}

/** D102: the git / gh steps of a plan item's Merge and Open PR (the real one is {@link BranchMergeGit}; tests may pass their own). */
export interface PlanMergePort {
  check(input: BranchMergeInput): Promise<BranchMergePlan>;
  merge(plan: BranchMergePlan): Promise<string>;
  openPullRequest(input: BranchMergeInput, title: string, body: string): Promise<string>;
}

/** Options for {@link PlanService}. */
export interface PlanServiceOptions {
  /** The data folder: `plans.db` is opened there while Plans is on. */
  readonly dataDir: string;
  readonly store: Store;
  readonly bus: HubBus;
  readonly todos: TodoService;
  readonly git: PlanGitPort;
  /** D102: the Merge step's git / gh (default {@link BranchMergeGit} with `gh` from PATH). */
  readonly merger?: PlanMergePort;
  readonly env: PlanEnvironment;
  readonly clock?: SchedulerClock;
  /** How often the checks of items waiting on them are read again (default 60 s). */
  readonly pollMs?: number;
  readonly onError?: (error: unknown) => void;
}

/** Input of {@link PlanService.createFromExternal} (the Jira lane's seam). */
export interface ExternalPlanInput {
  readonly sourceSessionId: string;
  readonly title: string;
  readonly targetBranch: string;
  readonly baseBranch?: string;
  readonly repos?: readonly string[] | null;
  readonly maxConcurrency?: number;
  readonly usageThreshold?: number;
  readonly answers?: Partial<PlanAnswers> | null;
  readonly external: PlanExternalRef | null;
  /** The items; `ref` is the caller's own id for them (e.g. the issue key), used by `edges`. */
  readonly items: ReadonlyArray<{
    readonly ref: string;
    readonly key?: string | null;
    readonly title: string;
    readonly description?: string | null;
    readonly plan?: string | null;
    readonly priority?: string;
    readonly estimateMinutes?: number | null;
    readonly hold?: boolean;
    readonly solutions?: readonly string[];
  }>;
  /** "`to` after `from`", by `ref`. */
  readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string }>;
}

const DEFAULT_POLL_MS = 60_000;

function newId(): string {
  return randomBytes(5).toString('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(field: string, message: string): PlanError {
  return new PlanError(422, 'invalid', message, field);
}

/**
 * D99 · Plans (`docs/plans.md`): the plans' store, validation and view model, and the
 * scheduler that starts ready items as todo runs and moves them to done. Event driven: a run
 * session's status (`sessionUpdated`), the source sessions' todo changes
 * (`todosChanged`), usage updates (`system`), a poll of the PR checks of the items waiting on
 * them, and once at start (plans that were running before a restart resume). Every change
 * publishes `planChanged`. One scheduling cycle at a time.
 *
 * **Experimental, off by default** (Settings → Experimental → Plans): while off it opens
 * nothing (`plans.db` is not created), listens to nothing, runs no timer and answers every
 * call with 404 `plans-off`; while on with a broken `plans.db`, 503 `plans-unavailable` and
 * still nothing runs. Switching it off pauses the running plans ({@link PLANS_OFF_REASON}).
 */
export class PlanService {
  readonly #dataDir: string;
  readonly #store: Store;
  readonly #bus: HubBus;
  readonly #todos: TodoService;
  readonly #git: PlanGitPort;
  readonly #merger: PlanMergePort;
  readonly #env: PlanEnvironment;
  readonly #clock: SchedulerClock;
  readonly #pollMs: number;
  readonly #onError: (error: unknown) => void;
  /** Run session → its item and the status last seen. */
  readonly #runs = new Map<string, { itemId: string; status: SessionStatus | null }>();
  /** Items to read from git at the next cycle; `true` = also check for a conflict (a turn ended). */
  readonly #dirty = new Map<string, boolean>();
  /** D102: items whose Merge / Open PR / Send back runs now (a second click is refused). */
  readonly #acting = new Set<string>();
  #tail: Promise<void> = Promise.resolve();
  #queued = false;
  #unsubscribe: (() => void) | null = null;
  #poll: unknown = null;
  #closed = false;
  /** Settings → Experimental → Plans as last read. */
  #enabled = false;
  /** `plans.db` while Plans is on and the file opened. */
  #db: PlansDb | null = null;
  /** Why `plans.db` could not be opened (while on). */
  #problem: string | null = null;
  #offHooks: (() => void) | null = null;
  /** The switch changes, one at a time. */
  #switching: Promise<void> = Promise.resolve();

  constructor(options: PlanServiceOptions) {
    this.#dataDir = options.dataDir;
    this.#store = options.store;
    this.#bus = options.bus;
    this.#todos = options.todos;
    this.#git = options.git;
    this.#merger = options.merger ?? new BranchMergeGit({ gh: ['gh'] });
    this.#env = options.env;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.#onError = options.onError ?? ((error) => console.error('switchboard plans:', error));
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /**
   * Reads the switch (the app calls it when ready) and registers the settings seam; while
   * Plans is on, opens `plans.db`, starts listening and resumes the running plans.
   */
  async start(): Promise<void> {
    if (this.#closed) return;
    this.#offHooks ??= registerPlanHooks(this.#store, {
      switchChanged: () => this.switchChanged(),
      sessionContinued: (from, to) => this.sessionContinued(from, to),
      inboxMerge: async (planId, itemId) => {
        try {
          await this.mergeItem(planId, itemId);
          return null;
        } catch (error) {
          if (error instanceof PlanError) return error.conflicts.length > 0 ? `${error.message}: ${error.conflicts.join(', ')}` : error.message;
          throw error;
        }
      },
      outcomes: () => this.insightOutcomes(),
    });
    await this.switchChanged();
  }

  /**
   * D108 (Insights, `docs/insights.md` → *Outcomes and rework*): every item that ended:
   * `merged` (stored `done`: its work is in the target), `failed` (stored `failed`: discarded,
   * could not start), `blocked` (any other item whose view state is `blocked`: a dependency
   * failed, its session stopped with an error, a repeated conflict); `null` while Plans is off
   * or `plans.db` is unavailable. Read-only.
   */
  async insightOutcomes(): Promise<PlanItemOutcome[] | null> {
    if (!this.#enabled || this.#db === null) return null;
    const repo = this.#repo();
    const out: PlanItemOutcome[] = [];
    for (const plan of await repo.list()) {
      const records = new Map((await repo.items(plan.id)).map((item) => [item.id, item]));
      // The view states (D99's planView): `blocked` covers dependents of a failed item and stopped sessions.
      for (const view of (await this.#view(plan, repo)).items) {
        const item = records.get(view.id);
        if (!item) continue;
        if (item.state === 'done') out.push({ itemId: item.id, runSessionId: item.runSessionId, outcome: 'merged', at: item.mergedAt ?? item.doneAt ?? item.updatedAt });
        else if (item.state === 'failed') out.push({ itemId: item.id, runSessionId: item.runSessionId, outcome: 'failed', at: item.doneAt ?? item.updatedAt });
        else if (view.state === 'blocked') out.push({ itemId: item.id, runSessionId: item.runSessionId, outcome: 'blocked', at: item.updatedAt });
      }
    }
    return out;
  }

  /** Stops listening and polling, waits for the cycle in flight and closes `plans.db` (the app closes). */
  async close(): Promise<void> {
    this.#closed = true;
    this.#offHooks?.();
    this.#offHooks = null;
    await this.#switching.catch(() => undefined);
    this.#stopListening();
    await this.idle();
    this.#db?.close();
    this.#db = null;
  }

  /**
   * The switch was read again (start, or `PUT /api/settings` changed it). On: `plans.db` is
   * opened (created on first use), the plans whose source session is gone are deleted, the
   * running ones resume. Off: the scheduler stops, every running plan is paused with
   * {@link PLANS_OFF_REASON} (their items' sessions finish their turn; nothing new starts) and
   * the file is closed (it stays on disk; switched on again, the plans show paused).
   */
  switchChanged(): Promise<void> {
    const next = this.#switching.then(() => this.#applySwitch());
    this.#switching = next.catch((error: unknown) => this.#onError(error));
    return next;
  }

  async #applySwitch(): Promise<void> {
    if (this.#closed) return;
    const on = (await this.#store.settings.get(PLANS_SETTING)) === true;
    if (on === this.#enabled) return;
    this.#enabled = on;
    if (!on) {
      await this.#deactivate();
      return;
    }
    try {
      this.#db = await PlansDb.open(this.#dataDir, () => this.#nowIso());
      this.#problem = null;
    } catch (error) {
      // A broken plans.db breaks nothing else: Plans answers 503 and runs nothing.
      this.#db = null;
      this.#problem = `plans.db could not be opened: ${error instanceof Error ? error.message : String(error)}`;
      this.#onError(error);
      return;
    }
    await this.#activate();
  }

  async #activate(): Promise<void> {
    const repo = (this.#db as PlansDb).plans;
    await this.#prune();
    for (const plan of await repo.list()) await this.#syncSpans(repo, plan);
    for (const plan of await repo.list({ states: ['running', 'paused'] })) {
      for (const item of await repo.items(plan.id)) {
        if (item.state !== 'running' || item.runSessionId === null) continue;
        this.#runs.set(item.runSessionId, { itemId: item.id, status: (await this.#store.sessions.get(item.runSessionId))?.status ?? null });
        this.#dirty.set(item.id, false);
      }
    }
    this.#unsubscribe = this.#bus.subscribe((message) => this.#onMessage(message));
    this.#armPoll();
    this.kick();
  }

  async #deactivate(): Promise<void> {
    this.#stopListening();
    await this.idle();
    const db = this.#db;
    this.#db = null;
    this.#problem = null;
    this.#runs.clear();
    this.#dirty.clear();
    if (!db) return;
    const paused: string[] = [];
    try {
      for (const plan of await db.plans.list({ states: ['running'] })) {
        const now = await db.plans.update(plan.id, { state: 'paused', pausedReason: PLANS_OFF_REASON, heldReason: null });
        // The waiting items' spans become paused-plan; running items keep theirs (their turn finishes).
        if (now) await this.#syncSpans(db.plans, now);
        paused.push(plan.id);
      }
    } finally {
      db.close();
    }
    for (const planId of paused) this.#bus.publish('planChanged', { planId, state: 'paused' });
  }

  /**
   * D83 (`docs/plans.md` → *Continue in a fresh session*): the plans whose source is `from` move to
   * the fresh session `to` (their items keep their todo ids: the todos moved with their ids), and
   * items run by `from` are run by `to`. Nothing while Plans is off or `plans.db` is broken: the
   * sweep at activation makes the move from the sessions' links.
   */
  async sessionContinued(from: string, to: string): Promise<void> {
    if (!this.#db || from === to) return;
    await this.#move(from, to);
    this.kick();
  }

  async #move(from: string, to: string): Promise<void> {
    const repo = (this.#db as PlansDb).plans;
    const plans = await repo.list({ sourceSessionId: from });
    await repo.moveSource(from, to);
    const run = this.#runs.get(from);
    if (await repo.moveRunSession(from, to)) {
      this.#runs.delete(from);
      if (run) this.#runs.set(to, { ...run, status: (await this.#store.sessions.get(to))?.status ?? null });
    }
    for (const plan of plans) this.#bus.publish('planChanged', { planId: plan.id, state: plan.state });
    for (const item of await repo.itemsByRunSession(to)) if (!plans.some((plan) => plan.id === item.planId)) this.#bus.publish('planChanged', { planId: item.planId, state: (await repo.get(item.planId))?.state ?? null });
  }

  /** The session `sessionId` was continued into, following the chain (`null` = not continued, or the fresh one is gone). */
  async #successor(sessionId: string): Promise<string | null> {
    let at = sessionId;
    const seen = new Set<string>([at]);
    for (;;) {
      const record = await this.#store.sessions.get(at);
      let next = record?.continuedTo ?? null;
      // The old session may have been deleted (Clean-up): the fresh one still names it.
      if (!record) next = (await this.#store.sessions.list()).find((candidate) => candidate.continuedFrom === at)?.id ?? null;
      if (next === null || seen.has(next) || !(await this.#store.sessions.get(next))) return at === sessionId ? null : at;
      seen.add(next);
      at = next;
    }
  }

  /** Follows continued sessions, then deletes the plans of a source session that is gone (the main database's cascade cannot reach `plans.db`); at activation and with each scheduling cycle. */
  async #prune(): Promise<void> {
    const repo = this.#db?.plans;
    if (!repo) return;
    // D83: a source or run session continued in a fresh one (also while Plans was off) is followed first.
    for (const sessionId of new Set([...(await repo.sourceSessionIds()), ...(await repo.runSessionIds())])) {
      const to = await this.#successor(sessionId);
      if (to !== null) await this.#move(sessionId, to);
    }
    for (const sessionId of await repo.sourceSessionIds()) {
      if (await this.#store.sessions.get(sessionId)) continue;
      for (const plan of await repo.list({ sourceSessionId: sessionId })) {
        for (const item of await repo.items(plan.id)) if (item.runSessionId) this.#runs.delete(item.runSessionId);
        await repo.delete(plan.id);
        this.#bus.publish('planChanged', { planId: plan.id, state: null });
      }
    }
  }

  #stopListening(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#poll !== null) this.#clock.clearTimeout(this.#poll);
    this.#poll = null;
  }

  /** `GET /api/plans/state`: the switch (answered also while Plans is off). */
  state(): PlansState {
    return { enabled: this.#enabled, available: this.#enabled && this.#db !== null, problem: this.#enabled ? this.#problem : null };
  }

  /** Listeners and timers running (tests: none while off). */
  activeTimers(): number {
    return (this.#unsubscribe ? 1 : 0) + (this.#poll !== null ? 1 : 0);
  }

  /** The plans repository. @throws {PlanError} 404 `plans-off` while Plans is off, 503 `plans-unavailable` while `plans.db` is broken. */
  #repo(): PlanRepository {
    if (!this.#enabled) throw new PlanError(404, 'plans-off', 'Plans is off: switch it on in Settings → Experimental');
    if (!this.#db) throw new PlanError(503, 'plans-unavailable', this.#problem ?? 'plans.db is not open');
    return this.#db.plans;
  }

  /** Resolves once the queued cycles have run (tests). */
  async idle(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = this.#tail;
      await seen;
    } while (seen !== this.#tail);
  }

  /** Queues one scheduling cycle (coalesced: a cycle already queued covers this call). */
  kick(): void {
    if (this.#closed || this.#queued || !this.#db) return;
    this.#queued = true;
    this.#tail = this.#tail
      .then(async () => {
        this.#queued = false;
        await this.#cycle();
      })
      .catch((error: unknown) => {
        this.#queued = false;
        this.#onError(error);
      });
  }

  /** Reads the checks of the items waiting on them again (the poll; tests call it directly). */
  pollChecks(): void {
    void this.#pollOnce().catch((error: unknown) => this.#onError(error));
  }

  async #pollOnce(): Promise<void> {
    if (!this.#db) return;
    let any = false;
    for (const plan of await this.#repo().list({ states: ['running', 'paused'] })) {
      for (const item of await this.#repo().items(plan.id)) {
        if (item.state === 'running' && item.waitingOn === 'checks') {
          if (!this.#dirty.has(item.id)) this.#dirty.set(item.id, false);
          any = true;
        }
      }
    }
    if (any) this.kick();
  }

  #armPoll(): void {
    if (this.#closed || !this.#unsubscribe) return;
    this.#poll = this.#clock.setTimeout(() => {
      this.#poll = null;
      this.pollChecks();
      this.#armPoll();
    }, this.#pollMs);
  }

  #onMessage(message: HubMessage): void {
    switch (message.name) {
      case 'sessionUpdated': {
        const run = this.#runs.get(message.payload.id);
        if (!run) return;
        const status = message.payload.status;
        if (status === run.status) return;
        const turnEnded = run.status === 'run' && (status === 'idle' || status === 'done');
        run.status = status;
        this.#dirty.set(run.itemId, turnEnded || this.#dirty.get(run.itemId) === true);
        this.kick();
        return;
      }
      case 'todosChanged':
      case 'system':
        // A source's todo changed (an item's title / estimate, a todo removed), or usage readings moved.
        this.kick();
        return;
      default:
        return;
    }
  }

  // ── reads ───────────────────────────────────────────────────────────────

  /** Every plan of this machine with its view model, oldest first. */
  async list(): Promise<Plan[]> {
    const out: Plan[] = [];
    for (const plan of await this.#repo().list()) out.push(await this.#view(plan));
    return out;
  }

  /** One plan with its view model. @throws {PlanError} 404 */
  async get(planId: string): Promise<Plan> {
    return this.#view(await this.#plan(planId));
  }

  /** D99 seam for the Jira lane: the plans made from external list `system` / `key`, with their view models. */
  async findByExternal(system: string, key: string): Promise<Plan[]> {
    const out: Plan[] = [];
    for (const plan of await this.#repo().findByExternal(system, key)) out.push(await this.#view(plan));
    return out;
  }

  /** The plans whose source is `sessionId` (the agent's `plan_status` without an id). */
  async listOf(sessionId: string): Promise<Plan[]> {
    const out: Plan[] = [];
    for (const plan of await this.#repo().list({ sourceSessionId: sessionId })) out.push(await this.#view(plan));
    return out;
  }

  /** The plan `planId` if session `sessionId` is its source (the agent's routes), else 404. */
  async agentPlan(sessionId: string, planId: string): Promise<PlanRecord> {
    const plan = await this.#repo().get(planId);
    if (!plan || plan.sourceSessionId !== sessionId) throw new PlanError(404, 'not-found', `no plan ${planId} in this session`);
    return plan;
  }

  async #plan(planId: string): Promise<PlanRecord> {
    const plan = await this.#repo().get(planId);
    if (!plan) throw new PlanError(404, 'not-found', `no plan ${planId}`);
    return plan;
  }

  async #view(plan: PlanRecord, repo: PlanRepository = this.#repo()): Promise<Plan> {
    const items = await repo.items(plan.id);
    const edges = await repo.edges(plan.id);
    const spans = await repo.spans(plan.id, PLAN_ITEM_SPANS_MAX);
    const facts: PlanItemFacts[] = [];
    for (const item of items) {
      const session = item.runSessionId ? await this.#store.sessions.get(item.runSessionId) : null;
      const todo = await this.#store.todos.get(item.todoId);
      facts.push({
        ...item,
        title: todo?.title ?? item.title,
        estimateMinutes: todo ? todo.estimateMinutes : item.estimateMinutes,
        sessionStatus: session ? session.status : null,
      });
    }
    const model = planView({ mode: plan.mergeMode, targetBranch: plan.targetBranch, maxConcurrency: plan.maxConcurrency, items: facts, edges, now: this.#clock.now().getTime() });
    return {
      id: plan.id,
      title: plan.title,
      sourceSessionId: plan.sourceSessionId,
      targetBranch: plan.targetBranch,
      repos: plan.repos,
      baseBranch: plan.baseBranch,
      mergeMode: plan.mergeMode,
      maxConcurrency: plan.maxConcurrency,
      usageThreshold: plan.usageThreshold,
      answers: plan.answers,
      state: plan.state,
      external: plan.external,
      held: plan.state === 'paused' ? (plan.pausedReason ?? 'the plan is paused') : plan.state === 'running' ? plan.heldReason : null,
      pausedReason: plan.state === 'paused' ? plan.pausedReason : null,
      items: model.items.map((item) => ({ ...item, spans: spans.get(item.id) ?? [] })),
      edges,
      criticalPath: model.criticalPath,
      progress: model.progress,
      estimatedMinutesLeft: plan.state === 'done' || plan.state === 'cancelled' ? null : model.estimatedMinutesLeft,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      startedAt: plan.startedAt,
      finishedAt: plan.finishedAt,
      machine: null,
    };
  }

  // ── plan CRUD ───────────────────────────────────────────────────────────

  /**
   * `POST /api/plans`: a draft plan over session `sourceSessionId`'s todo list. Body: `title`,
   * `targetBranch`, optional `baseBranch` (default `dev`), `repos` (a workspace's solution names,
   * default the session's), `maxConcurrency` (1–16, default 3), `usageThreshold` (1–100, default
   * 85), `answers` (default the session's start answers), `external`.
   */
  async create(body: unknown): Promise<Plan> {
    this.#repo();
    const input = isRecord(body) ? body : {};
    const sourceSessionId = typeof input['sourceSessionId'] === 'string' ? input['sourceSessionId'] : '';
    if (sourceSessionId === '') throw invalid('sourceSessionId', 'name the session whose todos the plan runs (sourceSessionId)');
    const record = await this.#createRecord(sourceSessionId, input);
    await this.#publish(record.id);
    return this.get(record.id);
  }

  async #createRecord(sourceSessionId: string, input: Readonly<Record<string, unknown>>): Promise<PlanRecord> {
    const source = await this.#store.sessions.get(sourceSessionId);
    if (!source) throw new PlanError(404, 'not-found', `no session ${sourceSessionId}`);
    if (source.closedAt !== null) throw new PlanError(409, 'closed', 'the session is closed: reopen it to plan its todos');
    // D106: a chat is no plan source (its todos are run as sessions only after it is continued as one).
    if (source.kind === 'chat') throw new PlanError(409, 'chat', 'a chat is not a plan source: continue it as a session first');
    const title = checkTitle(input['title']);
    const targetBranch = checkBranch(input['targetBranch'], 'targetBranch', null);
    const baseBranch = checkBranch(input['baseBranch'], 'baseBranch', DEFAULT_PLAN_BASE);
    if (targetBranch === baseBranch) throw invalid('targetBranch', 'the target branch must differ from the base branch');
    const names = input['repos'] === undefined || input['repos'] === null ? null : checkNames(input['repos'], 'repos');
    const resolved = await this.#env.repos(sourceSessionId, names);
    if (resolved.kind === 'plain') throw new PlanError(409, 'not-a-repo', "the session's folder is not a git repository: a plan needs a target branch");
    if (resolved.repos.length === 0) throw invalid('repos', 'name the solution repos the target branch lives in (the session uses none yet)');
    const answers = checkAnswers(input['answers'], { workType: source.workType, mode: source.mode, phase: source.phase, coordination: source.coordination, notes: null });
    return this.#repo().create({
      id: newId(),
      title,
      sourceSessionId,
      targetBranch,
      baseBranch,
      repos: resolved.repos.map((repo) => repo.name),
      maxConcurrency: checkInt(input['maxConcurrency'], 'maxConcurrency', 1, PLAN_CONCURRENCY_MAX, DEFAULT_PLAN_CONCURRENCY),
      usageThreshold: checkInt(input['usageThreshold'], 'usageThreshold', 1, 100, DEFAULT_PLAN_USAGE_THRESHOLD),
      answers,
      external: checkExternal(input['external']),
    });
  }

  /**
   * `PUT /api/plans/{id}`: `title`, `baseBranch`, `maxConcurrency`, `usageThreshold`, `answers`,
   * `external` any time (before it is done or cancelled); `targetBranch` and `repos` only in a draft.
   */
  async update(planId: string, body: unknown): Promise<Plan> {
    const plan = await this.#plan(planId);
    const input = isRecord(body) ? body : {};
    if (plan.state === 'done' || plan.state === 'cancelled') throw new PlanError(409, 'finished', `the plan is ${plan.state}`);
    const patch: Record<string, unknown> = {};
    if (input['title'] !== undefined) patch['title'] = checkTitle(input['title']);
    if (input['baseBranch'] !== undefined) patch['baseBranch'] = checkBranch(input['baseBranch'], 'baseBranch', DEFAULT_PLAN_BASE);
    if (input['maxConcurrency'] !== undefined) patch['maxConcurrency'] = checkInt(input['maxConcurrency'], 'maxConcurrency', 1, PLAN_CONCURRENCY_MAX, DEFAULT_PLAN_CONCURRENCY);
    if (input['usageThreshold'] !== undefined) patch['usageThreshold'] = checkInt(input['usageThreshold'], 'usageThreshold', 1, 100, DEFAULT_PLAN_USAGE_THRESHOLD);
    if (input['answers'] !== undefined) patch['answers'] = checkAnswers(input['answers'], plan.answers ?? { workType: null, mode: null, phase: null, coordination: null, notes: null });
    if (input['external'] !== undefined) patch['external'] = checkExternal(input['external']);
    if (input['targetBranch'] !== undefined || input['repos'] !== undefined) {
      if (plan.state !== 'draft') throw new PlanError(409, 'started', 'the target branch and the repos change only before the plan starts');
      if (input['targetBranch'] !== undefined) patch['targetBranch'] = checkBranch(input['targetBranch'], 'targetBranch', null);
      if (input['repos'] !== undefined) {
        const resolved = await this.#env.repos(plan.sourceSessionId, checkNames(input['repos'], 'repos'));
        patch['repos'] = resolved.repos.map((repo) => repo.name);
      }
    }
    const target = (patch['targetBranch'] as string | undefined) ?? plan.targetBranch;
    const base = (patch['baseBranch'] as string | undefined) ?? plan.baseBranch;
    if (target === base) throw invalid('targetBranch', 'the target branch must differ from the base branch');
    await this.#repo().update(planId, patch);
    await this.#publish(planId);
    this.kick();
    return this.get(planId);
  }

  /** `DELETE /api/plans/{id}`: removes the plan (its items and edges; the todos and run sessions stay). Refused while running. */
  async remove(planId: string): Promise<void> {
    const plan = await this.#plan(planId);
    if (plan.state === 'running') throw new PlanError(409, 'running', 'the plan is running: pause or cancel it first');
    for (const item of await this.#repo().items(planId)) if (item.runSessionId) this.#runs.delete(item.runSessionId);
    await this.#repo().delete(planId);
    this.#bus.publish('planChanged', { planId, state: null });
  }

  // ── items and edges ─────────────────────────────────────────────────────

  /**
   * `POST /api/plans/{id}/items`: adds an existing todo of the source session (`todoId`) or a new
   * one (`todo: { title, description, plan, priority, estimateMinutes }`, added to the source's
   * list by `by`), with an optional `key`, `hold`, `solutions` (a subset of the plan's repos) and
   * `after` (ids or keys of the items it runs after). Answers the plan and the new item's id.
   */
  async addItem(planId: string, body: unknown, by: 'developer' | 'agent' = 'developer'): Promise<{ readonly plan: Plan; readonly itemId: string }> {
    const plan = await this.#plan(planId);
    if (plan.state === 'done' || plan.state === 'cancelled') throw new PlanError(409, 'finished', `the plan is ${plan.state}`);
    const input = isRecord(body) ? body : {};
    const items = await this.#repo().items(planId);
    if (items.length >= PLAN_ITEMS_MAX) throw new PlanError(409, 'too-many', `a plan holds at most ${PLAN_ITEMS_MAX} items`);
    const key = normalizeItemKey(input['key']);
    if (key === undefined) throw invalid('key', 'the key must be a ticket key such as PROJ-123');
    if (key !== null && items.some((item) => item.key === key)) throw invalid('key', `the plan has ${key} already`);
    const solutions = this.#checkSolutions(plan, input['solutions']);
    const hold = input['hold'] === undefined ? false : checkBool(input['hold'], 'hold');
    const after = input['after'] === undefined ? [] : this.#resolveRefs(items, checkNames(input['after'], 'after'), 'after');
    let todo: TodoRecord;
    if (typeof input['todoId'] === 'string' && input['todoId'] !== '') {
      const found = await this.#store.todos.get(input['todoId']);
      if (!found || found.sessionId !== plan.sourceSessionId) throw invalid('todoId', `no todo ${input['todoId']} in the plan's session`);
      if (found.state === 'done') throw invalid('todoId', 'a done todo cannot be planned: reopen it first');
      if (items.some((item) => item.todoId === found.id)) throw invalid('todoId', 'that todo is in the plan already');
      todo = found;
    } else if (isRecord(input['todo'])) {
      try {
        const added = await this.#todos.add(plan.sourceSessionId, input['todo'], by);
        todo = (await this.#store.todos.get(added.todo.id)) as TodoRecord;
      } catch (error) {
        if (error instanceof TodoError) throw new PlanError(error.status, error.code, error.message, error.status === 422 ? 'todo' : null);
        throw error;
      }
    } else {
      throw invalid('todoId', 'give todoId (an existing todo) or todo (a new one: title, description, plan, priority, estimateMinutes)');
    }
    const item = await this.#repo().addItem({ id: newId(), planId, todoId: todo.id, key, title: todo.title, estimateMinutes: todo.estimateMinutes, hold, solutions });
    for (const from of after) await this.#repo().addEdge(planId, from, item.id);
    await this.#repo().touch(planId);
    await this.#publish(planId);
    this.kick();
    return { plan: await this.get(planId), itemId: item.id };
  }

  /** `PUT /api/plans/{id}/items/{itemId}`: `key` and `solutions` (before it starts), `hold` (until it is merged). */
  async updateItem(planId: string, itemId: string, body: unknown): Promise<Plan> {
    const plan = await this.#plan(planId);
    const item = await this.#item(planId, itemId);
    const input = isRecord(body) ? body : {};
    const patch: PlanItemPatch = {};
    if (input['key'] !== undefined || input['solutions'] !== undefined) {
      if (item.state !== 'pending') throw new PlanError(409, 'started', 'the key and the solutions change only before the item starts');
      if (input['key'] !== undefined) {
        const key = normalizeItemKey(input['key']);
        if (key === undefined) throw invalid('key', 'the key must be a ticket key such as PROJ-123');
        Object.assign(patch, { key });
      }
      if (input['solutions'] !== undefined) Object.assign(patch, { solutions: this.#checkSolutions(plan, input['solutions']) });
    }
    if (input['hold'] !== undefined) {
      await this.#setHolds(plan, { [itemId]: checkBool(input['hold'], 'hold') });
    }
    if (Object.keys(patch).length > 0) await this.#repo().updateItem(itemId, patch);
    await this.#repo().touch(planId);
    await this.#publish(planId);
    return this.get(planId);
  }

  /** `DELETE /api/plans/{id}/items/{itemId}`: only an item that has not started (its edges go with it; the todo stays). */
  async removeItem(planId: string, itemId: string): Promise<Plan> {
    const item = await this.#item(planId, itemId);
    if (item.state === 'running' || item.state === 'done') throw new PlanError(409, 'started', `the item is ${item.state}: only an item that has not started can be removed`);
    await this.#repo().removeItem(itemId);
    await this.#repo().touch(planId);
    await this.#publish(planId);
    this.kick();
    return this.get(planId);
  }

  /**
   * `POST /api/plans/{id}/edges` `{ from, to }`: item `to` runs after item `from` (ids or keys).
   * A cycle is refused (409 `cycle`, naming it).
   */
  async addEdge(planId: string, body: unknown): Promise<Plan> {
    const plan = await this.#plan(planId);
    if (plan.state === 'done' || plan.state === 'cancelled') throw new PlanError(409, 'finished', `the plan is ${plan.state}`);
    const input = isRecord(body) ? body : {};
    const items = await this.#repo().items(planId);
    const [from] = this.#resolveRefs(items, [String(input['from'] ?? '')], 'from');
    const [to] = this.#resolveRefs(items, [String(input['to'] ?? '')], 'to');
    await this.#addEdge(planId, items, from as string, to as string);
    await this.#repo().touch(planId);
    await this.#publish(planId);
    return this.get(planId);
  }

  async #addEdge(planId: string, items: readonly PlanItemRecord[], from: string, to: string): Promise<void> {
    const edges = await this.#repo().edges(planId);
    const cycle = findCycle(edges, from, to);
    if (cycle) {
      const byId = new Map(items.map((item) => [item.id, item]));
      const names = cycle.map((id) => (byId.get(id) ? itemLabel(byId.get(id) as PlanItemRecord) : id));
      throw new PlanError(409, 'cycle', `that dependency would make a cycle: ${names.join(' → ')} (each waits for the next)`);
    }
    await this.#repo().addEdge(planId, from, to);
  }

  /** `DELETE /api/plans/{id}/edges/{from}/{to}`. */
  async removeEdge(planId: string, from: string, to: string): Promise<Plan> {
    await this.#plan(planId);
    const items = await this.#repo().items(planId);
    const [a] = this.#resolveRefs(items, [from], 'from');
    const [b] = this.#resolveRefs(items, [to], 'to');
    if (!(await this.#repo().removeEdge(planId, a as string, b as string))) throw new PlanError(404, 'not-found', 'no such dependency');
    await this.#repo().touch(planId);
    await this.#publish(planId);
    this.kick();
    return this.get(planId);
  }

  async #item(planId: string, itemId: string): Promise<PlanItemRecord> {
    const item = await this.#repo().item(itemId);
    if (!item || item.planId !== planId) throw new PlanError(404, 'not-found', `no item ${itemId} in plan ${planId}`);
    return item;
  }

  /** Item ids for refs that are item ids or keys. @throws {PlanError} 422 on `field` for an unknown one. */
  #resolveRefs(items: readonly PlanItemRecord[], refs: readonly string[], field: string): string[] {
    return refs.map((ref) => {
      const value = ref.trim();
      const found = items.find((item) => item.id === value) ?? items.find((item) => item.key !== null && item.key === value.toUpperCase());
      if (!found) throw invalid(field, `no item ${value} in the plan`);
      return found.id;
    });
  }

  #checkSolutions(plan: PlanRecord, value: unknown): string[] {
    if (value === undefined || value === null) return [];
    const names = checkNames(value, 'solutions');
    const unknown = names.filter((name) => !plan.repos.includes(name));
    if (unknown.length > 0) throw invalid('solutions', `not a repo of the plan: ${unknown.join(', ')} (the plan's: ${plan.repos.join(', ')})`);
    return names;
  }

  // ── control ─────────────────────────────────────────────────────────────

  /**
   * `POST /api/plans/{id}/start` `{ mergeMode }`: **requires** the merge mode (422
   * `merge-mode-required`: there is no default, the developer chooses). Refused: a plan without
   * items, one that is not a draft, an agent mode whose target is `dev` / `master` / `main` /
   * the default or a protected branch (422 `target-forbidden`), a target branch that cannot be
   * found or made from the base (409 `no-target`).
   */
  async startPlan(planId: string, body: unknown): Promise<Plan> {
    const plan = await this.#plan(planId);
    const mode = checkMergeMode(isRecord(body) ? body['mergeMode'] : undefined);
    if (plan.state !== 'draft') throw new PlanError(409, plan.state === 'paused' ? 'paused' : 'started', plan.state === 'paused' ? 'the plan is paused: resume it' : `the plan is ${plan.state}`);
    const items = await this.#repo().items(planId);
    if (items.length === 0) throw new PlanError(422, 'empty', 'add items to the plan before starting it');
    const repos = (await this.#env.repos(plan.sourceSessionId, plan.repos)).repos;
    if (mode !== 'developer') await this.#checkTarget(plan.targetBranch, repos);
    for (const repo of repos) {
      const prepared = await this.#git.prepareTarget(repo.repoPath, plan.targetBranch, plan.baseBranch);
      if (!prepared.ok) throw new PlanError(409, 'no-target', prepared.message);
    }
    await this.#repo().update(planId, { mergeMode: mode, state: 'running', startedAt: plan.startedAt ?? this.#nowIso() });
    await this.#publish(planId);
    this.kick();
    return this.get(planId);
  }

  async #checkTarget(target: string, repos: readonly PlanRepoRef[]): Promise<void> {
    const plain = forbiddenTargetReason(target);
    if (plain) throw new PlanError(422, 'target-forbidden', plain, 'targetBranch');
    for (const repo of repos) {
      const reason = forbiddenTargetReason(target, await this.#git.targetFacts(repo.repoPath, target));
      if (reason) throw new PlanError(422, 'target-forbidden', `${reason} (${repo.name})`, 'targetBranch');
    }
  }

  /** `POST /api/plans/{id}/pause`: no new item starts; the running ones go on. */
  async pause(planId: string): Promise<Plan> {
    const plan = await this.#plan(planId);
    if (plan.state !== 'running') throw new PlanError(409, 'not-running', `the plan is ${plan.state}`);
    await this.#repo().update(planId, { state: 'paused', pausedReason: null });
    await this.#publish(planId);
    return this.get(planId);
  }

  /** `POST /api/plans/{id}/resume`: ready items start again (also a plan paused because Plans was switched off). */
  async resume(planId: string): Promise<Plan> {
    const plan = await this.#plan(planId);
    if (plan.state !== 'paused') throw new PlanError(409, 'not-paused', `the plan is ${plan.state}`);
    await this.#repo().update(planId, { state: 'running', pausedReason: null });
    await this.#publish(planId);
    this.kick();
    return this.get(planId);
  }

  /** `POST /api/plans/{id}/cancel`: no item starts again; the running sessions are left as they are (not stopped). */
  async cancel(planId: string): Promise<Plan> {
    const plan = await this.#plan(planId);
    if (plan.state === 'done' || plan.state === 'cancelled') throw new PlanError(409, 'finished', `the plan is ${plan.state}`);
    await this.#repo().update(planId, { state: 'cancelled', finishedAt: this.#nowIso(), heldReason: null, pausedReason: null });
    await this.#publish(planId);
    return this.get(planId);
  }

  /**
   * `PUT /api/plans/{id}/mode` `{ mergeMode }`: changes the merge mode while the plan is a draft,
   * runs or is paused; it applies to the items not merged yet, and their running sessions are told
   * their new rule. An agent mode checks the target branch like `start`.
   */
  async setMode(planId: string, body: unknown): Promise<Plan> {
    const plan = await this.#plan(planId);
    if (plan.state === 'done' || plan.state === 'cancelled') throw new PlanError(409, 'finished', `the plan is ${plan.state}`);
    const mode = checkMergeMode(isRecord(body) ? body['mergeMode'] : undefined);
    if (mode !== 'developer') await this.#checkTarget(plan.targetBranch, (await this.#env.repos(plan.sourceSessionId, plan.repos)).repos);
    const items = await this.#repo().items(planId);
    await this.#repo().update(planId, { mergeMode: mode });
    if (plan.state !== 'draft') await this.#tellChangedRules(plan, plan.mergeMode, mode, items, items);
    await this.#publish(planId);
    this.kick();
    return this.get(planId);
  }

  /** `PUT /api/plans/{id}/holds` `{ holds: { <itemId or key>: boolean } }`: changes the holds of items not merged yet. */
  async setHolds(planId: string, body: unknown): Promise<Plan> {
    const plan = await this.#plan(planId);
    const holds = isRecord(body) && isRecord(body['holds']) ? body['holds'] : null;
    if (!holds) throw invalid('holds', 'give holds: { <item id or key>: true | false }');
    const items = await this.#repo().items(planId);
    const resolved: Record<string, boolean> = {};
    for (const [ref, value] of Object.entries(holds)) {
      const [id] = this.#resolveRefs(items, [ref], 'holds');
      resolved[id as string] = checkBool(value, 'holds');
    }
    await this.#setHolds(plan, resolved);
    await this.#publish(planId);
    this.kick();
    return this.get(planId);
  }

  async #setHolds(plan: PlanRecord, holds: Readonly<Record<string, boolean>>): Promise<void> {
    const before = await this.#repo().items(plan.id);
    for (const [itemId, hold] of Object.entries(holds)) {
      const item = before.find((candidate) => candidate.id === itemId);
      if (!item) continue;
      if (item.state === 'done' && item.hold !== hold) throw new PlanError(409, 'merged', `${itemLabel(item)} is merged already`);
      await this.#repo().updateItem(itemId, { hold });
    }
    if (plan.state === 'running' || plan.state === 'paused') await this.#tellChangedRules(plan, plan.mergeMode, plan.mergeMode, before, await this.#repo().items(plan.id));
  }

  /** Tells each running item whose merge rule changed (the mode, or its hold) its new rule. */
  async #tellChangedRules(plan: PlanRecord, fromMode: PlanMergeMode | null, toMode: PlanMergeMode | null, before: readonly PlanItemRecord[], after: readonly PlanItemRecord[]): Promise<void> {
    for (const item of after) {
      if (item.state !== 'running' || item.runSessionId === null) continue;
      const old = before.find((candidate) => candidate.id === item.id) ?? item;
      const was = developerMerges(fromMode, old);
      const now = developerMerges(toMode, item);
      if (was === now) continue;
      await this.#env.send(item.runSessionId, planRuleChangedMessage({ targetBranch: plan.targetBranch, branch: item.branch ?? '(your branch)', developerMerges: now })).catch((error: unknown) => this.#onError(error));
      this.#dirty.set(item.id, this.#dirty.get(item.id) === true);
    }
  }

  /** `POST /api/plans/{id}/items/{itemId}/retry`: a failed item goes back to waiting (it runs again in a new session when ready). */
  async retryItem(planId: string, itemId: string): Promise<Plan> {
    await this.#plan(planId);
    const item = await this.#item(planId, itemId);
    if (item.state !== 'failed') throw new PlanError(409, 'not-failed', `the item is ${item.state}: only a failed item is retried`);
    if (item.runSessionId) this.#runs.delete(item.runSessionId);
    await this.#repo().updateItem(itemId, { state: 'pending', reason: null, note: null, waitingOn: null, waitingSince: null, runSessionId: null, branch: null, cut: {}, prUrl: null, checks: null, conflicts: 0, startedAt: null });
    await this.#publish(planId);
    this.kick();
    return this.get(planId);
  }

  /** `POST /api/plans/{id}/items/{itemId}/done`: the developer counts the item as done (its dependents may start). */
  async markItemDone(planId: string, itemId: string): Promise<Plan> {
    const plan = await this.#plan(planId);
    const item = await this.#item(planId, itemId);
    if (item.state === 'done') return this.get(planId);
    await this.#done(plan, item, 'marked done by the developer');
    this.kick();
    return this.get(planId);
  }

  // ── the Merge step (D102) ───────────────────────────────────────────────

  /**
   * D102 · `POST /api/plans/{id}/items/{itemId}/merge`: the developer's Merge of a
   * `ready-to-merge` item. Every repo of the item's branch is checked before any is merged
   * (`BranchMergeGit.check`: refused 409 `uncommitted`, `target-dirty`, `target-missing`,
   * `no-branch` or `conflicts` with the files), then merged into the plan's target locally,
   * never pushed, never forced. The item is done and its dependents may start.
   */
  async mergeItem(planId: string, itemId: string): Promise<Plan> {
    return this.#act(planId, itemId, async (plan, item, inputs) => {
      const checked: BranchMergePlan[] = [];
      for (const input of inputs) checked.push(await this.#merger.check(input));
      const notes: string[] = [];
      for (const ready of checked) notes.push(await this.#merger.merge(ready));
      await this.#done(plan, item, `merged by you into ${plan.targetBranch}`);
      return notes;
    });
  }

  /**
   * D102 · `POST /api/plans/{id}/items/{itemId}/open-pr`: pushes the item's branch (never
   * forced) and opens (or reuses) its pull request into the target; the item stays ready to merge.
   */
  async openItemPullRequest(planId: string, itemId: string): Promise<Plan> {
    return this.#act(planId, itemId, async (plan, item, inputs) => {
      const todo = await this.#store.todos.get(item.todoId);
      const title = todo?.title ?? item.title;
      let url: string | null = null;
      for (const input of inputs) url = await this.#merger.openPullRequest(input, title, `${item.key ? `${item.key}: ` : ''}${title}\n\nAn item of the plan "${plan.title}". Opened from Switchboard's Plans page.`);
      if (url !== null) await this.#repo().updateItem(item.id, { prUrl: url });
      return [];
    });
  }

  /**
   * D102 · `POST /api/plans/{id}/items/{itemId}/send-back` `{ comment }` (1–4,000 characters):
   * the comment goes to the item's session as the developer's message, its todo goes back in
   * progress and the item runs again (it is ready to merge again once its run finishes).
   */
  async sendBackItem(planId: string, itemId: string, body: Readonly<Record<string, unknown>>): Promise<Plan> {
    const comment = typeof body['comment'] === 'string' ? body['comment'].trim() : '';
    if (comment === '' || comment.length > 4_000) throw invalid('comment', 'give a comment of 1 to 4,000 characters');
    return this.#act(planId, itemId, async (_plan, item) => {
      const todo = await this.#store.todos.get(item.todoId);
      if (todo && todo.state === 'done') await this.#todos.update(todo.sessionId, todo.id, { state: 'in_progress' }, 'developer').catch((error: unknown) => this.#onError(error));
      try {
        await this.#env.send(item.runSessionId as string, `Plans: your work on "${todo?.title ?? item.title}" was sent back with this comment:\n\n${comment}`);
      } catch (error) {
        throw new PlanError(409, 'send-failed', `the comment could not be sent: ${error instanceof Error ? error.message : String(error)}`);
      }
      await this.#repo().updateItem(item.id, { waitingOn: null, waitingSince: null });
      await this.#env.closeMergeNotice(item.id, 'sent-back').catch((error: unknown) => this.#onError(error));
      return [];
    });
  }

  /**
   * The shared frame of the Merge step's actions: one action per item at a time, run between
   * scheduling cycles; the item must be ready to merge (409 `not-ready`); a git refusal is a 409
   * with its code (and `conflicts`). Publishes and answers the plan.
   */
  async #act(planId: string, itemId: string, run: (plan: PlanRecord, item: PlanItemRecord, inputs: BranchMergeInput[]) => Promise<readonly string[]>): Promise<Plan> {
    const plan = await this.#plan(planId);
    const item = await this.#item(planId, itemId);
    if (plan.state === 'done' || plan.state === 'cancelled') throw new PlanError(409, 'finished', `the plan is ${plan.state}`);
    if (item.state !== 'running' || item.waitingOn !== 'merge' || item.runSessionId === null) throw new PlanError(409, 'not-ready', `${itemLabel(item)} is not waiting for your merge`);
    if (this.#acting.has(item.id)) throw new PlanError(409, 'busy', 'an action on this item is still running');
    const session = await this.#store.sessions.get(item.runSessionId);
    if (session?.status === 'run') throw new PlanError(409, 'busy', "the item's session is working: wait for its turn to end");
    this.#acting.add(item.id);
    try {
      const inputs: BranchMergeInput[] = [];
      if (item.branch !== null) {
        for (const record of await this.#store.worktrees.list({ sessionId: item.runSessionId })) {
          if (record.branch !== item.branch) continue;
          inputs.push({ repo: record.repo, dir: record.path, repoPath: record.repoPath, branch: record.branch, target: plan.targetBranch });
        }
      }
      if (inputs.length === 0) throw new PlanError(409, 'no-branch', `${itemLabel(item)} has no worktree branch to merge (it ran in the source folder): merge it yourself, then Mark done`);
      // Run between scheduling cycles, so the scheduler never reads the item half-merged.
      const work = this.#tail.then(() => run(plan, item, inputs));
      this.#tail = work.then(
        () => undefined,
        () => undefined,
      );
      try {
        await work;
      } catch (error) {
        if (error instanceof BranchMergeError) throw new PlanError(409, error.code, error.message, null, error.conflicts);
        throw error;
      }
    } finally {
      this.#acting.delete(item.id);
    }
    await this.#publish(planId);
    this.kick();
    return this.get(planId);
  }

  // ── the Jira seam ───────────────────────────────────────────────────────

  /**
   * D99 seam for the Jira lane (`docs/plans.md` → *Seam for an external list*): one draft plan
   * from an external list of items and their dependencies. Every item becomes a new todo in the
   * source session's list (`addedBy` developer) and a plan item; `edges` name items by `ref`.
   * Everything is checked before anything is written (an unknown `ref` or a cycle is refused as
   * {@link PlanError}); the rows go in one transaction. Answers the plan and the item id of each `ref`.
   */
  async createFromExternal(input: ExternalPlanInput): Promise<{ readonly plan: Plan; readonly itemIds: Readonly<Record<string, string>> }> {
    this.#repo();
    const refs = new Set<string>();
    for (const item of input.items) {
      if (typeof item.ref !== 'string' || item.ref === '' || refs.has(item.ref)) throw invalid('items', `every item needs its own ref (${String(item.ref)})`);
      refs.add(item.ref);
    }
    if (input.items.length > PLAN_ITEMS_MAX) throw new PlanError(409, 'too-many', `a plan holds at most ${PLAN_ITEMS_MAX} items`);
    const edges: PlanEdge[] = [];
    for (const edge of input.edges) {
      if (!refs.has(edge.from) || !refs.has(edge.to)) throw invalid('edges', `a dependency names an unknown item: ${edge.from} → ${edge.to}`);
      const cycle = findCycle(edges, edge.from, edge.to);
      if (cycle) throw new PlanError(409, 'cycle', `the dependencies make a cycle: ${cycle.join(' → ')}`);
      edges.push({ from: edge.from, to: edge.to });
    }
    const keys = new Map<string, string | null>();
    for (const item of input.items) {
      const key = normalizeItemKey(item.key ?? null);
      if (key === undefined) throw invalid('items', `not a ticket key: ${String(item.key)}`);
      keys.set(item.ref, key);
    }
    const record = await this.#createRecord(input.sourceSessionId, {
      title: input.title,
      targetBranch: input.targetBranch,
      ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
      ...(input.repos !== undefined ? { repos: input.repos } : {}),
      ...(input.maxConcurrency !== undefined ? { maxConcurrency: input.maxConcurrency } : {}),
      ...(input.usageThreshold !== undefined ? { usageThreshold: input.usageThreshold } : {}),
      ...(input.answers !== undefined ? { answers: input.answers } : {}),
      external: input.external,
    });
    const itemIds: Record<string, string> = {};
    try {
      for (const item of input.items) {
        const solutions = this.#checkSolutions(record, item.solutions);
        const added = await this.#todos.add(record.sourceSessionId, { title: item.title, description: item.description ?? null, plan: item.plan ?? undefined, priority: item.priority, estimateMinutes: item.estimateMinutes ?? null }, 'developer');
        const stored = await this.#repo().addItem({ id: newId(), planId: record.id, todoId: added.todo.id, key: keys.get(item.ref) ?? null, title: added.todo.title, estimateMinutes: added.todo.estimateMinutes, hold: item.hold === true, solutions });
        itemIds[item.ref] = stored.id;
      }
      for (const edge of edges) await this.#repo().addEdge(record.id, itemIds[edge.from] as string, itemIds[edge.to] as string);
    } catch (error) {
      // Nothing half-made stays: the plan goes (the todos added stay in the list, like any added todo).
      await this.#repo().delete(record.id);
      if (error instanceof TodoError) throw new PlanError(error.status, error.code, error.message, error.status === 422 ? 'items' : null);
      throw error;
    }
    await this.#publish(record.id);
    return { plan: await this.get(record.id), itemIds };
  }

  // ── the scheduler ───────────────────────────────────────────────────────

  async #cycle(): Promise<void> {
    if (this.#closed || !this.#db) return;
    await this.#prune();
    for (const plan of await this.#repo().list({ states: ['running', 'paused'] })) {
      try {
        await this.#schedule(plan);
      } catch (error) {
        this.#onError(error);
      }
    }
  }

  async #schedule(planAtStart: PlanRecord): Promise<void> {
    let changed = false;
    // 1. Running items: their session's status, then (when asked) git and gh.
    for (const item of await this.#repo().items(planAtStart.id)) {
      if (item.state !== 'running') {
        this.#dirty.delete(item.id);
        continue;
      }
      if (await this.#refresh(planAtStart, item)) changed = true;
    }
    const plan = (await this.#repo().get(planAtStart.id)) as PlanRecord;
    let items = await this.#repo().items(plan.id);
    const edges = await this.#repo().edges(plan.id);
    // 2. Start the ready items (running plans only), as long as a slot is free and usage allows.
    let held: string | null = null;
    if (plan.state === 'running') {
      const running = items.filter((item) => item.state === 'running').length;
      for (const item of readyItems(items, edges, plan.maxConcurrency - running)) {
        const todo = await this.#store.todos.get(item.todoId);
        if (!todo || todo.sessionId !== plan.sourceSessionId) {
          await this.#fail(item, 'could not start: its todo was removed');
          changed = true;
          continue;
        }
        held = await this.#env.usageHeld(plan, todo);
        if (held !== null) break;
        await this.#startItem(plan, item, todo);
        changed = true;
      }
      if (held !== plan.heldReason) {
        await this.#repo().update(plan.id, { heldReason: held });
        changed = true;
      }
      items = await this.#repo().items(plan.id);
      // 3. Every item done: the plan is done; the developer merges the epic.
      if (items.length > 0 && items.every((item) => item.state === 'done')) {
        await this.#repo().update(plan.id, { state: 'done', finishedAt: this.#nowIso(), heldReason: null });
        await this.#env
          .notice({
            kind: 'plan-ready',
            sessionId: plan.sourceSessionId,
            title: `Plan ready: ${plan.targetBranch} → ${plan.baseBranch}`,
            detail: `Every item of the plan "${plan.title}" is merged into ${plan.targetBranch}. Merge ${plan.targetBranch} into ${plan.baseBranch} when you are ready.`,
            dedupe: `plan-ready:${plan.id}`,
          })
          .catch((error: unknown) => this.#onError(error));
        changed = true;
      }
    }
    if (changed) await this.#publish(plan.id);
  }

  async #startItem(plan: PlanRecord, item: PlanItemRecord, todo: TodoRecord): Promise<void> {
    const resolved = await this.#env.repos(plan.sourceSessionId, plan.repos).catch((error: unknown) => error);
    if (resolved instanceof Error) {
      await this.#fail(item, `could not start: ${resolved.message}`);
      return;
    }
    const { kind, repos } = resolved as Awaited<ReturnType<PlanEnvironment['repos']>>;
    const mine = item.solutions.length > 0 ? repos.filter((repo) => item.solutions.includes(repo.name)) : repos;
    const from: Record<string, string> = {};
    const cut: Record<string, string> = {};
    for (const repo of mine) {
      const prepared = await this.#git.prepareTarget(repo.repoPath, plan.targetBranch, plan.baseBranch);
      if (!prepared.ok) {
        await this.#fail(item, `could not start: ${prepared.message}`);
        return;
      }
      from[repo.name] = prepared.ref;
      const tip = await this.#git.tip(repo.repoPath, prepared.ref);
      if (tip) cut[repo.name] = tip;
    }
    const branch = planItemBranch(item.key, shortNameFromTitle(todo.title, []));
    const developer = developerMerges(plan.mergeMode, item);
    const answers = plan.answers;
    const full = kind === 'workspace' && answers !== null && answers.workType !== null && answers.mode !== null && answers.phase !== null;
    const outcome = await this.#env.run({
      plan,
      item,
      todo,
      branch,
      from,
      repoPaths: mine.map((repo) => repo.repoPath),
      task: (final) =>
        planItemBrief({
          planTitle: plan.title,
          targetBranch: plan.targetBranch,
          notes: answers?.notes ?? null,
          key: item.key,
          branch: final ?? branch,
          developerMerges: developer,
          todo: { id: todo.id, title: todo.title, description: todo.description, plan: todo.plan },
        }),
      answers: full ? { workType: answers.workType as NonNullable<PlanAnswers['workType']>, mode: answers.mode as NonNullable<PlanAnswers['mode']>, phase: answers.phase as NonNullable<PlanAnswers['phase']>, coordination: answers.coordination } : null,
    });
    if (!outcome.ok) {
      await this.#fail(item, `could not start: ${outcome.message}`);
      return;
    }
    await this.#repo().updateItem(item.id, {
      state: 'running',
      runSessionId: outcome.sessionId,
      branch: outcome.branch,
      cut,
      title: todo.title,
      estimateMinutes: todo.estimateMinutes,
      startedAt: this.#nowIso(),
      reason: null,
      note: outcome.branch === null ? 'no worktree: the run works in the source folder' : null,
      waitingOn: null,
      waitingSince: null,
    });
    this.#runs.set(outcome.sessionId, { itemId: item.id, status: (await this.#store.sessions.get(outcome.sessionId))?.status ?? null });
  }

  /**
   * Brings a running item up to date: its session's status (a question), and, when the item is
   * dirty (its session's status changed, its checks are polled, D102: its todo was marked done
   * while the developer merges it), what git and gh say: merged, the checks, a conflict, and
   * (D102) whether it is ready for the developer's Merge. Answers whether anything changed.
   */
  async #refresh(plan: PlanRecord, item: PlanItemRecord): Promise<boolean> {
    const session = item.runSessionId ? await this.#store.sessions.get(item.runSessionId) : null;
    if (!session) {
      await this.#fail(item, 'lost its run session');
      return true;
    }
    if (item.runSessionId && !this.#runs.has(item.runSessionId)) this.#runs.set(item.runSessionId, { itemId: item.id, status: session.status });
    const developer = developerMerges(plan.mergeMode, item);
    const todo = await this.#store.todos.get(item.todoId);
    // D102: a run finished (its todo done, its turn over) while the developer merges: ready to merge.
    const finished = developer && todo?.state === 'done' && session.status !== 'run' && session.status !== 'need';
    // The rule changed (agents merge now) while it waited for the developer's Merge.
    const ruleChanged = !developer && item.waitingOn === 'merge';
    // A closed run session is looked at again (closed without work: the item fails).
    const dirty = this.#dirty.has(item.id) || (finished && item.waitingOn !== 'merge') || ruleChanged || (session.closedAt !== null && item.waitingOn !== 'merge');
    const conflicts = this.#dirty.get(item.id) === true;
    this.#dirty.delete(item.id);
    if (!dirty) return this.#setWaiting(plan, item, session.status === 'need' ? 'question' : item.waitingOn === 'question' ? null : item.waitingOn);
    const repos = await this.#inspect(plan, item, conflicts);
    const worked = repos.filter((repo) => repo.hasWork);
    const merged = worked.length > 0 && worked.every((repo) => repo.merged);
    let note: string | null = item.note;
    let waiting: PlanWaitingOn | null = session.status === 'need' ? 'question' : null;
    let checks: PlanChecks | null = item.checks;
    const prUrl = repos.find((repo) => repo.pr?.url)?.pr?.url ?? item.prUrl;

    if (developer) {
      // D102: merged without the developer's Merge (the agent merged it, or someone else did): done.
      if (merged) return this.#done(plan, item, `merged into ${plan.targetBranch} without your Merge`, prUrl);
      const withPr = worked.filter((repo) => repo.pr !== null);
      if (withPr.length > 0) checks = withPr.find((repo) => repo.pr?.checks.state === 'red')?.pr?.checks ?? withPr[0]?.pr?.checks ?? null;
      // D102: ready for the developer's Merge once its run finished: its todo is done, or every PR is open with green checks; it stays ready until merged or sent back.
      const greenPrs = withPr.length > 0 && withPr.every((repo) => repo.pr?.state === 'OPEN' && (repo.pr.checks.state === 'green' || repo.pr.checks.state === 'none'));
      const idle = session.status !== 'run' && session.status !== 'need';
      if (waiting === null && (item.waitingOn === 'merge' || (idle && (finished || greenPrs)))) waiting = 'merge';
    } else {
      const withPr = worked.filter((repo) => repo.pr !== null);
      const offline = worked.some((repo) => !repo.ghAvailable);
      const red = withPr.find((repo) => repo.pr?.checks.state === 'red');
      const pending = withPr.find((repo) => repo.pr?.checks.state === 'pending');
      if (red?.pr) {
        const reading = red.pr.checks;
        const already = item.checks?.state === 'red' && item.checks.sha === reading.sha && item.checks.summary === reading.summary;
        checks = reading;
        note = `checks ${reading.summary ?? 'failed'}`;
        if (waiting === null) waiting = 'checks';
        if (!already) await this.#env.send(session.id, planChecksMessage(plan.targetBranch, reading.summary ?? 'failed')).catch((error: unknown) => this.#onError(error));
      } else if (pending?.pr) {
        checks = pending.pr.checks;
        if (waiting === null) waiting = 'checks';
      } else if (withPr.length > 0) {
        checks = withPr[0]?.pr?.checks ?? null;
      }
      if (merged && !red && !pending) {
        const remark = offline ? `no remote or gh: counted as merged into ${plan.targetBranch} without reading checks` : withPr.length === 0 ? `merged into ${plan.targetBranch} without a pull request: no checks read` : null;
        return this.#done(plan, item, remark, prUrl, checks);
      }
      if (merged && red) note = `merged into ${plan.targetBranch}, but ${note ?? 'its checks failed'}`;
    }

    // A conflict with the target (read when a turn ended and the work is not merged yet).
    let conflictCount = item.conflicts;
    if (conflicts && !merged) {
      const conflicting = repos.some((repo) => repo.conflict);
      if (conflicting) {
        conflictCount += 1;
        if (conflictCount === 1) {
          await this.#env.send(session.id, planConflictMessage(item.branch ?? '(your branch)', plan.targetBranch)).catch((error: unknown) => this.#onError(error));
        } else if (conflictCount === 2) {
          await this.#env
            .notice({
              kind: 'plan-conflict',
              sessionId: session.id,
              title: `Plan "${plan.title}": ${itemLabel(item)} conflicts with ${plan.targetBranch} again`,
              detail: `${item.branch ?? 'The item\'s branch'} still conflicts with ${plan.targetBranch} after its agent was asked to rebase. Resolve it with the agent in its session, or retry the item.`,
              dedupe: `plan-conflict:${item.id}:${item.runSessionId ?? ''}`,
            })
            .catch((error: unknown) => this.#onError(error));
        }
        if (waiting === null || waiting === 'checks') waiting = 'conflict';
      } else if (item.waitingOn === 'conflict' && waiting === null) {
        waiting = null;
      }
    } else if (item.waitingOn === 'conflict' && waiting === null && !merged) {
      waiting = 'conflict';
    }
    if (session.closedAt !== null && worked.length === 0) {
      // Closed with nothing to merge; closed with work, it may still be merged (the developer's Merge, its PR).
      await this.#fail(item, 'was closed without any work to merge');
      return true;
    }
    const patch: PlanItemPatch = {};
    if (note !== item.note) Object.assign(patch, { note });
    if (JSON.stringify(checks) !== JSON.stringify(item.checks)) Object.assign(patch, { checks });
    if (prUrl !== item.prUrl) Object.assign(patch, { prUrl });
    if (conflictCount !== item.conflicts) Object.assign(patch, { conflicts: conflictCount });
    let changed = false;
    if (Object.keys(patch).length > 0) {
      await this.#repo().updateItem(item.id, patch);
      changed = true;
    }
    if (await this.#setWaiting(plan, { ...item, ...patch } as PlanItemRecord, waiting)) changed = true;
    return changed;
  }

  async #inspect(plan: PlanRecord, item: PlanItemRecord, conflicts: boolean): Promise<PlanRepoState[]> {
    if (item.branch === null) return [];
    const records = item.runSessionId ? await this.#store.worktrees.list({ sessionId: item.runSessionId }) : [];
    const out: PlanRepoState[] = [];
    for (const record of records) {
      if (record.branch !== item.branch) continue;
      out.push(await this.#git.inspect({ repo: record.repo, repoPath: record.repoPath, branch: record.branch, target: plan.targetBranch, cut: item.cut[record.repo] ?? null }, { conflicts }));
    }
    return out;
  }

  /**
   * Sets what the item waits on (and since when); answers whether it changed. D102: entering
   * `merge` raises the Inbox's "Ready to merge" item; leaving it closes it.
   */
  async #setWaiting(plan: PlanRecord, item: PlanItemRecord, on: PlanWaitingOn | null): Promise<boolean> {
    if (item.waitingOn === on) return false;
    const since = on === null ? null : this.#nowIso();
    await this.#repo().updateItem(item.id, { waitingOn: on, waitingSince: since });
    if (on === 'merge' && item.runSessionId) {
      const todo = await this.#store.todos.get(item.todoId);
      const title = todo?.title ?? item.title;
      await this.#env
        .mergeNotice({
          sessionId: item.runSessionId,
          planId: plan.id,
          itemId: item.id,
          title: `Ready to merge: ${title} (${plan.title})`,
          detail: `${item.branch ?? 'Its branch'} → ${plan.targetBranch}. Merge it into ${plan.targetBranch}, or open the plan to send it back.`,
          dedupe: `plan-merge:${item.id}:${since ?? ''}`,
        })
        .catch((error: unknown) => this.#onError(error));
    } else if (item.waitingOn === 'merge') {
      await this.#env.closeMergeNotice(item.id, on === 'question' ? 'question' : 'not-ready').catch((error: unknown) => this.#onError(error));
    }
    return true;
  }

  async #done(plan: PlanRecord, item: PlanItemRecord, note: string | null, prUrl: string | null = item.prUrl, checks: PlanChecks | null = item.checks): Promise<true> {
    const now = this.#nowIso();
    await this.#repo().updateItem(item.id, { state: 'done', note, prUrl, checks, waitingOn: null, waitingSince: null, mergedAt: item.mergedAt ?? now, doneAt: now, reason: null });
    // D102: its "Ready to merge" Inbox item (if any) is closed.
    if (item.waitingOn === 'merge') await this.#env.closeMergeNotice(item.id, 'merged').catch((error: unknown) => this.#onError(error));
    // The todo is done too.
    const todo = await this.#store.todos.get(item.todoId);
    if (todo && todo.state !== 'done') await this.#todos.update(todo.sessionId, todo.id, { state: 'done' }, 'developer').catch((error: unknown) => this.#onError(error));
    if (item.runSessionId) this.#runs.delete(item.runSessionId);
    await this.#publish(plan.id);
    this.kick();
    return true;
  }

  async #fail(item: PlanItemRecord, reason: string): Promise<void> {
    await this.#repo().updateItem(item.id, { state: 'failed', reason, waitingOn: null, waitingSince: null });
    if (item.waitingOn === 'merge') await this.#env.closeMergeNotice(item.id, 'failed').catch((error: unknown) => this.#onError(error));
    if (item.runSessionId) this.#runs.delete(item.runSessionId);
  }

  async #publish(planId: string): Promise<void> {
    const plan = await this.#repo().get(planId);
    if (plan) await this.#syncSpans(this.#repo(), plan);
    this.#bus.publish('planChanged', { planId, state: plan?.state ?? null });
  }

  /**
   * Brings the plan's item spans (the Timeline's history, `plan_item_spans`) up to date with the
   * items' states now: an item whose kind changed has its open span closed and a new one opened;
   * a finished or cancelled plan has none open. Every change publishes, so every change lands here;
   * at activation every plan is brought up to date (a restart keeps one open span per item).
   */
  async #syncSpans(repo: PlanRepository, plan: PlanRecord): Promise<void> {
    const view = await this.#view(plan, repo);
    const now = this.#nowIso();
    const open = await repo.openSpans(plan.id);
    for (const item of view.items) {
      const want = planItemSpanKind(plan, item);
      const mine = open.filter((span) => span.itemId === item.id);
      const keep = want === null ? undefined : mine.find((span) => span.kind === want);
      for (const span of mine) if (span !== keep) await repo.closeSpan(span.id, now);
      if (want !== null && !keep) await repo.openSpan(plan.id, item.id, want, now);
    }
  }

  #nowIso(): string {
    return this.#clock.now().toISOString();
  }
}

// ── input checks ──────────────────────────────────────────────────────────

function checkTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid('title', 'give the plan a title');
  const title = value.trim();
  if (title.length > PLAN_TITLE_MAX) throw invalid('title', `the title is at most ${PLAN_TITLE_MAX} characters`);
  return title;
}

function checkBranch(value: unknown, field: string, fallback: string | null): string {
  if ((value === undefined || value === null || value === '') && fallback !== null) return fallback;
  if (typeof value !== 'string' || value.trim() === '') throw invalid(field, `give the ${field === 'targetBranch' ? 'target branch (the epic feature branch, e.g. feature/PROJ-100-acme-epic)' : 'base branch'}`);
  const name = value.trim().replace(/^refs\/heads\//, '');
  if (!isBranchName(name)) throw invalid(field, `${name} is not a branch name`);
  return name;
}

function checkNames(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) throw invalid(field, `${field} must be a list of names`);
  return [...new Set((value as string[]).map((entry) => entry.trim()))];
}

function checkInt(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(field, `${field} must be a whole number from ${min} to ${max}`);
  return value;
}

function checkBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalid(field, `${field} must be true or false`);
  return value;
}

function checkMergeMode(value: unknown): PlanMergeMode {
  if (value === undefined || value === null || value === '') {
    throw new PlanError(422, 'merge-mode-required', `choose the merge mode: ${PLAN_MERGE_MODES.join(', ')} (there is no default: ask the developer)`, 'mergeMode');
  }
  if (typeof value !== 'string' || !(PLAN_MERGE_MODES as readonly string[]).includes(value)) throw invalid('mergeMode', `the merge mode is one of ${PLAN_MERGE_MODES.join(', ')}`);
  return value as PlanMergeMode;
}

function checkExternal(value: unknown): PlanExternalRef | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || value['system'] !== 'jira' || typeof value['key'] !== 'string' || value['key'].trim() === '') throw invalid('external', "external is { system: 'jira', key }");
  return { system: 'jira', key: value['key'].trim() };
}

function pick<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback: T | null): T | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw invalid(`answers.${field}`, `${field} is one of ${allowed.join(', ')}`);
  return value as T;
}

function checkAnswers(value: unknown, fallback: PlanAnswers): PlanAnswers {
  if (value === undefined || value === null) return fallback;
  if (!isRecord(value)) throw invalid('answers', 'answers is { workType, mode, phase, coordination, notes }');
  const notes = value['notes'] === undefined ? fallback.notes : value['notes'] === null || value['notes'] === '' ? null : value['notes'];
  if (notes !== null && (typeof notes !== 'string' || notes.length > PLAN_NOTES_MAX)) throw invalid('answers.notes', `notes is text of at most ${PLAN_NOTES_MAX} characters`);
  return {
    workType: pick(value['workType'], WORK_TYPES, 'workType', fallback.workType),
    mode: pick(value['mode'], SESSION_MODES, 'mode', fallback.mode),
    phase: pick(value['phase'], PHASES, 'phase', fallback.phase),
    coordination: pick(value['coordination'], COORDINATIONS, 'coordination', fallback.coordination),
    notes: typeof notes === 'string' ? notes.trim() : null,
  };
}
