/**
 * D99 · Plans (`docs/plans.md`; contract → *Plans (D99)* in
 * `docs/handoff/contracts/local-api.md`): todo items grouped into a dependency graph
 * ("B after A") that a scheduler starts as todo runs (D76) by itself, each into the plan's
 * target branch (the epic feature branch). This module holds the shared shapes and the pure
 * rules: the graph (cycles, readiness, blocked reasons, the critical path, the time left),
 * the item's branch name, the target-branch safeguard, the PR checks' reading, the texts sent
 * to an item's session, and the MCP tool definitions of the `switchboard` server.
 */
import type { Coordination, Phase, SessionMode, SessionStatus, WorkType } from './model.ts';
import type { PrChecks, PrChecksState } from './ci.ts';
import { todoFinishLine, todoHasPlan, type TodoToolDefinition } from './todos.ts';

// ── enumerations ──────────────────────────────────────────────────────────

/**
 * How an item counts as done (D99; the developer must choose one when the plan starts: there
 * is no default):
 * - `agents`: the item's agent merges its PR into the target branch once the checks are green;
 * - `agents-with-holds`: the same, except items flagged `hold` wait for the developer's Merge
 *   (the recommended option; the UI pre-selects it);
 * - `developer`: every item waits for the developer's Merge.
 *
 * - `none` (D99 follow-up 2026-10-15, plans for anything): no merge step at all. An item is done
 *   when its todo is done (its agent marks it done); nothing is merged, no PR or checks are
 *   watched. A held item waits for the developer to confirm it (Mark done). The only mode of a
 *   plan without a target branch.
 *
 * D102: the developer's Merge is Plans' own step (it was a Review card, D79, until those were
 * removed): a finished item waits `ready-to-merge` on the Plans page and in the Inbox.
 */
export const PLAN_MERGE_MODES = ['agents', 'agents-with-holds', 'developer', 'none'] as const;
/** One of {@link PLAN_MERGE_MODES}. */
export type PlanMergeMode = (typeof PLAN_MERGE_MODES)[number];

/** The merge mode the UI pre-selects (never applied by the server: `start` requires the field). */
export const RECOMMENDED_MERGE_MODE: PlanMergeMode = 'agents-with-holds';

/** Whether agents merge into the target under `mode` (`agents`, `agents-with-holds`): the modes that need the protected-target acknowledgement. */
export function agentsMerge(mode: PlanMergeMode | null): boolean {
  return mode === 'agents' || mode === 'agents-with-holds';
}

/** Whether `mode` has a merge step (every mode but `none`; a draft's `null` counts as one, its mode is not chosen yet). */
export function hasMergeStep(mode: PlanMergeMode | null): boolean {
  return mode !== 'none';
}

/** What `targetBranch` says "no target branch" with (the MCP tools; the REST API also takes `null` or an empty value). */
export const PLAN_NO_TARGET = 'none';

/** A plan's state: `draft` (being built) → `running` ↔ `paused` → `done` | `cancelled`. */
export const PLAN_STATES = ['draft', 'running', 'paused', 'done', 'cancelled'] as const;
/** One of {@link PLAN_STATES}. */
export type PlanState = (typeof PLAN_STATES)[number];

/** An item's stored state: `pending` (not started), `running` (its run session works), `done`, `failed` (discarded, could not start, …). */
export const PLAN_ITEM_STORED_STATES = ['pending', 'running', 'done', 'failed'] as const;
/** One of {@link PLAN_ITEM_STORED_STATES}. */
export type PlanItemStoredState = (typeof PLAN_ITEM_STORED_STATES)[number];

/**
 * An item's state as the view model computes it:
 * - `waiting`: a dependency is not done yet;
 * - `ready`: every dependency is done; it starts when a slot is free (and the plan runs);
 * - `running`: its run session works on it (including while its PR's checks run);
 * - `question`: its session waits for the developer (a question or a permission request, in the Inbox);
 * - `stopped` (D120): its session's turn is over and it is not working (no subagent, no GitHub
 *   Actions wait, no counted background work: its status is not `run`), its todo is not done,
 *   and nothing else covers it (a question, the developer's merge or confirmation, a second
 *   conflict) for at least {@link PLAN_STOPPED_GRACE_MS}: the agent ended its turn without
 *   finishing ("Stopped — needs you"). It keeps its slot and its dependents wait; it goes back to
 *   `running` once its session works again;
 * - `needs-you` (D124): its session's turn is over and not working, and the turn waits for the
 *   developer (its agent's `turn_status` `waiting_for_you` / `blocked`, or the text check of its
 *   last message): amber "Needs you" with the ask as its reason, in place of D120's `stopped`
 *   (and without its Inbox item: the session raises "Waiting for you"). It keeps its slot like
 *   `stopped` and goes back to `running` once its session works again;
 * - `ready-to-merge` (D102): its run finished (its todo is done, or its PR is open with green
 *   checks) and it waits for the developer's Merge ("Waiting for your merge");
 * - `to-confirm` (D99 follow-up 2026-10-15): a held item of a plan without a merge step (`none`)
 *   whose todo is done waits for the developer to confirm it (Mark done);
 * - `done`: merged into the target branch (and the checks are green, in agent modes);
 * - `blocked`: it failed (discarded, could not start), its session stopped with an error, a
 *   conflict went to the developer, or a dependency is blocked; {@link PlanItem.reason} says why.
 */
export const PLAN_ITEM_STATES = ['waiting', 'ready', 'running', 'question', 'stopped', 'needs-you', 'ready-to-merge', 'to-confirm', 'done', 'blocked'] as const;
/** One of {@link PLAN_ITEM_STATES}. */
export type PlanItemState = (typeof PLAN_ITEM_STATES)[number];

/**
 * What a running item waits on (stored, with `waitingSince`): the developer's Merge (D102;
 * stored as `review` in `plans.db`, the name its CHECK has), its PR's checks, the developer's
 * answer, a conflict; `confirm` (D99 follow-up 2026-10-15): a held item of a plan without a merge
 * step waits for the developer to confirm it is done (stored like `merge`, as `review`; answered
 * as `confirm` in a `none` plan).
 */
export type PlanWaitingOn = 'merge' | 'checks' | 'question' | 'conflict' | 'confirm';

/** The state of an item's PR checks: `pending` (running), `green`, `red`, `none` (no checks configured: counts as green). D109: the shared watcher's {@link PrChecksState}. */
export type PlanChecksState = PrChecksState;

/**
 * D120: how long an item's session must have been idle with its todo open before the item shows
 * `stopped` (so the usual "turn ends, then the todo is marked done" does not flash red). Test
 * servers shorten it (`SWITCHBOARD_PLAN_STOPPED_GRACE_MS`).
 */
export const PLAN_STOPPED_GRACE_MS = 2 * 60_000;

/** D120: at most this many characters of the agent's last message are the reason of a `stopped` item. */
export const PLAN_STOPPED_EXCERPT_MAX = 300;

/** D120: a `stopped` item's reason when its agent's last message cannot be read. */
export const PLAN_STOPPED_NO_MESSAGE = 'its agent ended its turn without finishing its todo';

/** D120: an agent's last message cut for a `stopped` item's reason (whitespace folded, at most {@link PLAN_STOPPED_EXCERPT_MAX} characters). */
export function stoppedExcerpt(text: string | null | undefined): string {
  const folded = (text ?? '').replace(/\s+/g, ' ').trim();
  if (folded === '') return PLAN_STOPPED_NO_MESSAGE;
  return folded.length > PLAN_STOPPED_EXCERPT_MAX ? `${folded.slice(0, PLAN_STOPPED_EXCERPT_MAX - 1).trimEnd()}…` : folded;
}

/** Defaults. */
export const DEFAULT_PLAN_CONCURRENCY = 3;
export const PLAN_CONCURRENCY_MAX = 16;
export const DEFAULT_PLAN_USAGE_THRESHOLD = 85;
export const DEFAULT_PLAN_BASE = 'dev';
/** An item without an estimate counts this many minutes on the critical path and in the time left. */
export const DEFAULT_ITEM_MINUTES = 30;
export const PLAN_TITLE_MAX = 120;
export const PLAN_NOTES_MAX = 4_000;
/** The most items one plan holds. */
export const PLAN_ITEMS_MAX = 100;

/**
 * Branches agents merge into only with the developer's acknowledgement (D99 safeguard; D99
 * follow-up 2026-10-15: `allowProtectedTarget`), besides the repo's default branch and its
 * protected branches.
 */
export const PLAN_FORBIDDEN_TARGETS: readonly string[] = ['dev', 'develop', 'master', 'main'];

// ── API shapes ────────────────────────────────────────────────────────────

/**
 * The plan-level start answers, given once and pre-filled into every item's run like a Full
 * start (a workspace source; D76-workspace). `notes` (e.g. a testing carve-out) is added to
 * every item's brief. All `null` = a simple start (a repo folder's source).
 */
export interface PlanAnswers {
  readonly workType: WorkType | null;
  readonly mode: SessionMode | null;
  readonly phase: Phase | null;
  readonly coordination: Coordination | null;
  readonly notes: string | null;
}

/** The list a plan came from (the Jira lane fills it; Switchboard only stores and shows it). */
/**
 * D130: a plan's runs' sidebar subfolder, chosen at Start (`docs/plans.md` → *The runs' sidebar
 * subfolder*): the folder's id in the sidebar layout of the machine that owns the plan, and its name.
 */
export interface PlanSidebarFolderRef {
  readonly id: string;
  readonly name: string;
}

export interface PlanExternalRef {
  readonly system: 'jira';
  readonly key: string;
}

/** The last PR checks read for an item (D109: the shared watcher's {@link PrChecks}). */
export type PlanChecks = PrChecks;

/** One item of a plan as the API answers it (the computed view model). */
export interface PlanItem {
  readonly id: string;
  readonly todoId: string;
  /** Optional ticket key (`PROJ-123`). */
  readonly key: string | null;
  readonly title: string;
  readonly hold: boolean;
  /**
   * The plan repos it works in (empty = all of them). D115: in a plan whose repositories are
   * picked per item ({@link Plan.reposPerItem}), empty = not picked yet (the item waits).
   */
  readonly solutions: readonly string[];
  readonly state: PlanItemState;
  /** Why it is blocked / waiting, human-readable ("waiting on PROJ-12, which was discarded"); `null` otherwise. */
  readonly reason: string | null;
  /** A remark (red checks, no remote: merged into the target only, …); `null` = none. */
  readonly note: string | null;
  readonly storedState: PlanItemStoredState;
  readonly waitingOn: PlanWaitingOn | null;
  /** The ids of the items it runs after. */
  readonly dependsOn: readonly string[];
  readonly runSessionId: string | null;
  readonly branch: string | null;
  readonly prUrl: string | null;
  readonly checks: PlanChecks | null;
  /** Whether the developer merges this item (developer mode, or a hold in agents-with-holds). */
  readonly developerMerges: boolean;
  /** D99 follow-up 2026-10-15: whether the developer confirms this item is done (a hold in a plan without a merge step). */
  readonly developerConfirms: boolean;
  readonly estimateMinutes: number | null;
  /** Minutes from start to done (done items), or so far (running ones); `null` before it starts. */
  readonly actualMinutes: number | null;
  readonly onCriticalPath: boolean;
  readonly position: number;
  readonly startedAt: string | null;
  readonly waitingSince: string | null;
  readonly mergedAt: string | null;
  readonly doneAt: string | null;
  /** Its history, oldest first (at most {@link PLAN_ITEM_SPANS_MAX}, the newest); additive. */
  readonly spans: readonly PlanItemSpan[];
  /**
   * D120: a `stopped` item: since when its session has been idle with its todo open (its {@link reason}
   * is the agent's last message, cut); `null` otherwise. Additive: absent from older machines.
   */
  readonly stoppedSince?: string | null;
}

/**
 * What an item was doing over a span of time (the Plans page's Timeline; `docs/plans.md` → *Item history*):
 * - `running`: its agent works (including while its PR's checks run);
 * - `waiting-you`: a question, its merge (`ready-to-merge`), a second conflict, a session stopped with an error, or (D120) an agent that ended its turn without finishing (`stopped`) waits for the developer;
 * - `waiting-dependency`: an item it runs after is not done (or is blocked);
 * - `paused-usage`: it is ready, but new starts are held by the usage threshold;
 * - `paused-plan`: the plan is paused (by the developer, or because Plans was switched off).
 */
export const PLAN_ITEM_SPAN_KINDS = ['running', 'waiting-you', 'waiting-dependency', 'paused-usage', 'paused-plan'] as const;
/** One of {@link PLAN_ITEM_SPAN_KINDS}. */
export type PlanItemSpanKind = (typeof PLAN_ITEM_SPAN_KINDS)[number];

/** One span of an item's history; `endedAt` `null` = still open. */
export interface PlanItemSpan {
  readonly kind: PlanItemSpanKind;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

/** At most this many spans per item in a plan's answer (the newest). */
export const PLAN_ITEM_SPANS_MAX = 200;

/**
 * The span kind an item is in now (`null` = none: a draft, a finished or cancelled plan, a done or
 * failed item, or a ready item about to start).
 */
export function planItemSpanKind(plan: { readonly state: PlanState; readonly heldReason: string | null }, item: Pick<PlanItem, 'state' | 'storedState'>): PlanItemSpanKind | null {
  if (plan.state !== 'running' && plan.state !== 'paused') return null;
  switch (item.state) {
    case 'running':
      return 'running';
    case 'question':
    case 'stopped':
    case 'needs-you':
    case 'ready-to-merge':
    case 'to-confirm':
      return 'waiting-you';
    case 'blocked':
      return item.storedState === 'running' ? 'waiting-you' : item.storedState === 'pending' ? 'waiting-dependency' : null;
    case 'waiting':
      return plan.state === 'paused' ? 'paused-plan' : 'waiting-dependency';
    case 'ready':
      return plan.state === 'paused' ? 'paused-plan' : plan.heldReason !== null ? 'paused-usage' : null;
    case 'done':
      return null;
  }
}

/** "B after A": `to` runs after `from`. */
export interface PlanEdge {
  readonly from: string;
  readonly to: string;
}

/** D138: a Project's (plan's) account per CLI: profile id; a missing CLI = Automatic. */
export type PlanAccounts = Readonly<Partial<Record<'claude' | 'codex' | 'opencode', string>>>;

/** D138: a stored / sent `accounts` value read defensively (unknown CLIs and empty ids dropped). */
export function readPlanAccounts(value: unknown): PlanAccounts {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Partial<Record<'claude' | 'codex' | 'opencode', string>> = {};
  for (const cli of ['claude', 'codex', 'opencode'] as const) {
    const id = (value as Record<string, unknown>)[cli];
    if (typeof id === 'string' && id.trim() !== '') out[cli] = id.trim();
  }
  return out;
}

/** A plan with its computed view model (`GET /api/plans/{id}`). */
export interface Plan {
  readonly id: string;
  readonly title: string;
  readonly sourceSessionId: string;
  /**
   * The branch every item's work is merged into; `null` = no target branch (D99 follow-up
   * 2026-10-15): a plan without a merge step, whose items are done when their todos are.
   */
  readonly targetBranch: string | null;
  /** The plan's repos; D115: with {@link reposPerItem}, the union of its items' solutions (empty until the agent picks). */
  readonly repos: readonly string[];
  /**
   * D115: the plan's agent picks each item's repositories (`plan_set_solutions`): a workspace plan
   * with a target branch made without repos (a Jira import into a workspace). An item without
   * solutions then waits ({@link PLAN_PICK_REPOS_REASON}) instead of running in every repo.
   * Additive: absent (a paired machine's older Switchboard) = `false`.
   */
  readonly reposPerItem?: boolean;
  readonly baseBranch: string;
  /** `null` until started (a draft; a plan without a target starts as `none`). */
  readonly mergeMode: PlanMergeMode | null;
  /**
   * D99 follow-up 2026-10-15: the developer acknowledged that agents merge straight into a
   * protected target (`dev`, `main`, `master`, `develop`, the default or a protected branch).
   */
  readonly allowProtectedTarget: boolean;
  readonly maxConcurrency: number;
  readonly usageThreshold: number;
  readonly answers: PlanAnswers | null;
  readonly state: PlanState;
  readonly external: PlanExternalRef | null;
  /**
   * D130: the sidebar subfolder the plan's runs go into (chosen at Start), `null` = none (next to
   * the source session). Additive: absent (a paired machine's older Switchboard) = none.
   */
  readonly sidebarFolder?: PlanSidebarFolderRef | null;
  /**
   * D138 (`docs/accounts.md` → *Choosing the account*): the Project's account per CLI (profile
   * id; a missing CLI = Automatic). Every step session it starts, and its own session, use it.
   * Additive: absent (a paired machine's older Switchboard) = Automatic for every CLI.
   */
  readonly accounts?: PlanAccounts;
  /** Why new starts are held right now (paused, an account above the usage threshold); `null` = not held. */
  readonly held: string | null;
  /** Why Switchboard paused the plan ({@link PLANS_OFF_REASON}); `null` = the developer paused it, or it is not paused. */
  readonly pausedReason: string | null;
  readonly items: readonly PlanItem[];
  readonly edges: readonly PlanEdge[];
  readonly criticalPath: { readonly itemIds: readonly string[]; readonly minutes: number };
  readonly progress: { readonly done: number; readonly total: number; readonly percent: number };
  /** Estimated minutes until every item is done; `null` when an item is blocked or nothing is left. */
  readonly estimatedMinutesLeft: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** A paired machine's plan (D48): its machine; `null` = this machine. */
  readonly machine: { readonly id: string; readonly name: string; readonly state: string } | null;
}

/** D115: why an item of a plan whose repositories are picked per item waits while it has none. */
export const PLAN_PICK_REPOS_REASON = "Waiting for the plan's agent to pick repositories";

/** Why a running plan was paused when a 1.x build's Plans switch went off (shown on the plan; the developer resumes it). D132: 2.0 has no switch, so nothing pauses for it any more. */
export const PLANS_OFF_REASON = 'Plans was switched off';

/** `GET /api/plans/state` (always answered, also while `plans.db` is broken). */
export interface PlansState {
  /** Always `true` since D132 (2.0: no switch); a 1.x paired machine may still answer `false`. */
  readonly enabled: boolean;
  /** On and `plans.db` open (the plan routes answer). */
  readonly available: boolean;
  /** Why `plans.db` could not be opened while on (the plan routes answer 503); `null` otherwise. */
  readonly problem: string | null;
}

/** `/hub` `planChanged`: any change of a plan (created, edited, an item's state, deleted: `state` `null`). */
export interface PlanChanged {
  readonly planId: string;
  readonly state: PlanState | null;
}

// ── the graph ─────────────────────────────────────────────────────────────

/**
 * The cycle adding "`to` after `from`" would close, as item ids from `from` back to `from`
 * (`[from, to, …, from]`), or `null` when the edge is safe. A cycle exists when `from` is
 * already reachable from `to` through the existing edges (or `from === to`).
 */
export function findCycle(edges: readonly PlanEdge[], from: string, to: string): string[] | null {
  if (from === to) return [from, from];
  const next = new Map<string, string[]>();
  for (const edge of edges) next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  // Breadth-first from `to`, remembering parents, until `from` is found.
  const parent = new Map<string, string>();
  const queue = [to];
  const seen = new Set([to]);
  while (queue.length > 0) {
    const node = queue.shift() as string;
    if (node === from) {
      const path = [from];
      let at = from;
      while (at !== to) {
        at = parent.get(at) as string;
        path.unshift(at);
      }
      return [from, ...path];
    }
    for (const child of next.get(node) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      parent.set(child, node);
      queue.push(child);
    }
  }
  return null;
}

/** `true` when the edges have no cycle (every node can be ordered). */
export function isAcyclic(ids: readonly string[], edges: readonly PlanEdge[]): boolean {
  return topologicalOrder(ids, edges) !== null;
}

/** The item ids in dependency order (dependencies first, ties by the given order), or `null` when there is a cycle. */
export function topologicalOrder(ids: readonly string[], edges: readonly PlanEdge[]): string[] | null {
  const known = new Set(ids);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  }
  const order: string[] = [];
  const ready = ids.filter((id) => indegree.get(id) === 0);
  while (ready.length > 0) {
    const id = ready.shift() as string;
    order.push(id);
    for (const child of next.get(id) ?? []) {
      const left = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, left);
      if (left === 0) ready.push(child);
    }
    ready.sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
  }
  return order.length === ids.length ? order : null;
}

/** The ids of the items `id` runs after. */
export function dependenciesOf(id: string, edges: readonly PlanEdge[]): string[] {
  return edges.filter((edge) => edge.to === id).map((edge) => edge.from);
}

// ── the view model ────────────────────────────────────────────────────────

/** What the view needs to know about one stored item (plus the live facts the service reads). */
export interface PlanItemFacts {
  readonly id: string;
  readonly todoId: string;
  readonly key: string | null;
  readonly title: string;
  readonly hold: boolean;
  readonly solutions: readonly string[];
  readonly state: PlanItemStoredState;
  readonly reason: string | null;
  readonly note: string | null;
  readonly waitingOn: PlanWaitingOn | null;
  readonly runSessionId: string | null;
  readonly branch: string | null;
  readonly prUrl: string | null;
  readonly checks: PlanChecks | null;
  readonly conflicts: number;
  readonly estimateMinutes: number | null;
  readonly position: number;
  readonly startedAt: string | null;
  readonly waitingSince: string | null;
  readonly mergedAt: string | null;
  readonly doneAt: string | null;
  /** The run session's status now (`null` = no run session, or it is gone). */
  readonly sessionStatus: SessionStatus | null;
  /** D120: whether its todo is done (absent = unknown: never `stopped`). */
  readonly todoDone?: boolean;
  /** D120: since when its run session has been idle (its last activity); absent / `null` = unknown. */
  readonly idleSince?: string | null;
  /**
   * D124: the ask of its run session's turn that ended waiting for the developer (with
   * `sessionStatus` `need`); absent / `null` = none (a `need` is then a question or a permission).
   */
  readonly sessionAsk?: string | null;
}

/** A short label of an item in reasons: its key, else its title in quotes. */
export function itemLabel(item: Pick<PlanItemFacts, 'key' | 'title'>): string {
  return item.key ?? `"${item.title}"`;
}

/** Whether the developer merges item `item` under `mode` (`null` mode = a draft: the agents' rule is not known yet). */
export function developerMerges(mode: PlanMergeMode | null, item: Pick<PlanItemFacts, 'hold'>): boolean {
  return mode === 'developer' || (mode === 'agents-with-holds' && item.hold);
}

/** D99 follow-up 2026-10-15: whether the developer confirms item `item` is done (a hold in a plan without a merge step). */
export function developerConfirms(mode: PlanMergeMode | null, item: Pick<PlanItemFacts, 'hold'>): boolean {
  return mode === 'none' && item.hold;
}

/** Minutes between two ISO times (at least 0), rounded. */
function minutesBetween(from: string, to: number): number {
  return Math.max(0, Math.round((to - Date.parse(from)) / 60_000));
}

/**
 * D120: since when item `item` has been stopped: its stored state is `running`, its session's turn
 * is over and it is not working (the session's status is `done`, `idle` or `paused`: a subagent, a
 * GitHub Actions wait or counted background work keeps it `run`, 1.23), its todo is not done, and
 * nothing else covers it (the developer's merge or confirmation, a second conflict). Answers the
 * time its session went idle, else `null`. The grace period ({@link PLAN_STOPPED_GRACE_MS}) is the
 * caller's: {@link planView} shows `stopped` only once it has passed.
 */
export function stoppedSince(item: Pick<PlanItemFacts, 'state' | 'sessionStatus' | 'todoDone' | 'idleSince' | 'waitingOn' | 'conflicts' | 'hold' | 'startedAt'>, mode: PlanMergeMode | null): string | null {
  if (item.state !== 'running' || item.todoDone !== false) return null;
  if (item.sessionStatus !== 'done' && item.sessionStatus !== 'idle' && item.sessionStatus !== 'paused') return null;
  if (item.waitingOn === 'conflict' && item.conflicts >= 2) return null;
  if (developerMerges(mode, item) && item.waitingOn === 'merge') return null;
  if (developerConfirms(mode, item) && (item.waitingOn === 'confirm' || item.waitingOn === 'merge')) return null;
  return item.idleSince ?? item.startedAt ?? null;
}

/** An item's own view state and reason, before its dependencies are looked at. */
function ownState(item: PlanItemFacts, mode: PlanMergeMode | null, targetBranch: string | null, now: number, graceMs: number): { state: PlanItemState; reason: string | null; stoppedSince?: string } | null {
  switch (item.state) {
    case 'done':
      return { state: 'done', reason: null };
    case 'failed':
      return { state: 'blocked', reason: item.reason ?? 'it failed' };
    case 'running':
      if (item.sessionStatus === 'fail') return { state: 'blocked', reason: 'its session stopped with an error' };
      if (item.waitingOn === 'conflict' && item.conflicts >= 2) return { state: 'blocked', reason: `its branch conflicts with ${targetBranch ?? 'its base'} again: waiting for you in the Inbox` };
      // D124: a turn that ended waiting for the developer (its turn_status or the text check): amber, with the ask.
      if (item.sessionStatus === 'need' && item.sessionAsk) return { state: 'needs-you', reason: item.sessionAsk };
      if (item.sessionStatus === 'need') return { state: 'question', reason: 'its session waits for your answer in the Inbox' };
      if (developerMerges(mode, item) && item.waitingOn === 'merge') return { state: 'ready-to-merge', reason: 'waiting for your merge' };
      if (developerConfirms(mode, item) && (item.waitingOn === 'confirm' || item.waitingOn === 'merge')) return { state: 'to-confirm', reason: 'its todo is done: waiting for you to confirm it' };
      {
        // D120: its agent ended its turn without finishing, longer ago than the grace period.
        const since = stoppedSince(item, mode);
        if (since !== null && now - Date.parse(since) >= graceMs) return { state: 'stopped', reason: PLAN_STOPPED_NO_MESSAGE, stoppedSince: since };
      }
      return { state: 'running', reason: null };
    case 'pending':
      return null;
  }
}

/** Input of {@link planView}. */
export interface PlanViewInput {
  readonly mode: PlanMergeMode | null;
  readonly targetBranch: string | null;
  readonly maxConcurrency: number;
  readonly items: readonly PlanItemFacts[];
  readonly edges: readonly PlanEdge[];
  /** Now (epoch ms). */
  readonly now: number;
  /** D115: the plan's agent picks each item's repositories: a pending item without solutions waits ({@link PLAN_PICK_REPOS_REASON}). */
  readonly reposPerItem?: boolean;
  /** D120: the grace period before an idle item with its todo open shows `stopped` (default {@link PLAN_STOPPED_GRACE_MS}). */
  readonly stoppedGraceMs?: number;
}

/** The computed part of a {@link Plan}: the items' view states, the critical path, progress and the time left. */
export interface PlanViewModel {
  readonly items: readonly PlanItem[];
  readonly criticalPath: Plan['criticalPath'];
  readonly progress: Plan['progress'];
  readonly estimatedMinutesLeft: number | null;
}

/**
 * D99: the view model of a plan. Each item's state ({@link PLAN_ITEM_STATES}): a pending item
 * is `ready` when every dependency is done, `blocked` when a dependency is blocked (the reason
 * names the nearest one: "waiting on PROJ-12, which was discarded"), else `waiting`. The
 * critical path is the longest chain by duration (done items: their actual time; running ones:
 * the larger of their estimate and the time so far; the rest: the estimate, or
 * {@link DEFAULT_ITEM_MINUTES}). The time left is the larger of the longest remaining chain and
 * the remaining work spread over the concurrency; `null` while an item is blocked.
 */
export function planView(input: PlanViewInput): PlanViewModel {
  const ids = [...input.items].sort((a, b) => a.position - b.position).map((item) => item.id);
  const byId = new Map(input.items.map((item) => [item.id, item]));
  const order = topologicalOrder(ids, input.edges) ?? ids;
  const views = new Map<string, { state: PlanItemState; reason: string | null; stoppedSince?: string }>();
  for (const id of order) {
    const item = byId.get(id) as PlanItemFacts;
    const own = ownState(item, input.mode, input.targetBranch, input.now, input.stoppedGraceMs ?? PLAN_STOPPED_GRACE_MS);
    if (own) {
      views.set(id, own);
      continue;
    }
    const deps = dependenciesOf(id, input.edges).filter((dep) => byId.has(dep));
    const blockedDep = deps.map((dep) => ({ dep, view: views.get(dep) })).find((entry) => entry.view?.state === 'blocked');
    if (blockedDep) {
      const dep = byId.get(blockedDep.dep) as PlanItemFacts;
      const why = dep.state === 'failed' ? (dep.reason ?? 'failed') : 'is blocked';
      views.set(id, { state: 'blocked', reason: `waiting on ${itemLabel(dep)}, which ${why}` });
      continue;
    }
    // D115: it cannot start before the plan's agent picks its repositories.
    if (input.reposPerItem === true && item.solutions.length === 0) {
      views.set(id, { state: 'waiting', reason: PLAN_PICK_REPOS_REASON });
      continue;
    }
    const open = deps.filter((dep) => views.get(dep)?.state !== 'done');
    views.set(id, open.length === 0 ? { state: 'ready', reason: null } : { state: 'waiting', reason: `waiting on ${open.map((dep) => itemLabel(byId.get(dep) as PlanItemFacts)).join(', ')}` });
  }

  // Durations (minutes) for the critical path, and what is left of each.
  const total = new Map<string, number>();
  const left = new Map<string, number>();
  for (const id of ids) {
    const item = byId.get(id) as PlanItemFacts;
    const estimate = item.estimateMinutes ?? DEFAULT_ITEM_MINUTES;
    if (item.state === 'done') {
      total.set(id, item.startedAt && item.doneAt ? minutesBetween(item.startedAt, Date.parse(item.doneAt)) : estimate);
      left.set(id, 0);
    } else if (item.state === 'running' && item.startedAt) {
      const elapsed = minutesBetween(item.startedAt, input.now);
      total.set(id, Math.max(estimate, elapsed));
      left.set(id, Math.max(estimate - elapsed, 1));
    } else {
      total.set(id, estimate);
      left.set(id, estimate);
    }
  }
  const longest = (weights: Map<string, number>): { path: string[]; minutes: number } => {
    const best = new Map<string, { minutes: number; via: string | null }>();
    for (const id of order) {
      let via: string | null = null;
      let before = 0;
      for (const dep of dependenciesOf(id, input.edges)) {
        const entry = best.get(dep);
        if (entry && entry.minutes > before) {
          before = entry.minutes;
          via = dep;
        }
      }
      best.set(id, { minutes: before + (weights.get(id) ?? 0), via });
    }
    let end: string | null = null;
    let minutes = 0;
    for (const id of order) {
      const entry = best.get(id) as { minutes: number };
      if (end === null || entry.minutes > minutes) {
        end = id;
        minutes = entry.minutes;
      }
    }
    const path: string[] = [];
    for (let at = end; at !== null; at = best.get(at)?.via ?? null) path.unshift(at);
    return { path, minutes };
  };
  const critical = ids.length > 0 ? longest(total) : { path: [], minutes: 0 };
  const onPath = new Set(critical.path);
  const done = input.items.filter((item) => item.state === 'done').length;
  const anyBlocked = [...views.values()].some((view) => view.state === 'blocked');
  const remaining = [...left.values()].reduce((sum, value) => sum + value, 0);
  const estimatedMinutesLeft = anyBlocked || remaining === 0 ? null : Math.max(longest(left).minutes, Math.ceil(remaining / Math.max(1, input.maxConcurrency)));

  const items: PlanItem[] = ids.map((id) => {
    const item = byId.get(id) as PlanItemFacts;
    const view = views.get(id) as { state: PlanItemState; reason: string | null; stoppedSince?: string };
    const actualMinutes = item.startedAt ? (item.doneAt ? minutesBetween(item.startedAt, Date.parse(item.doneAt)) : item.state === 'running' ? minutesBetween(item.startedAt, input.now) : null) : null;
    return {
      id,
      todoId: item.todoId,
      key: item.key,
      title: item.title,
      hold: item.hold,
      solutions: item.solutions,
      state: view.state,
      reason: view.reason,
      note: item.note,
      storedState: item.state,
      waitingOn: item.waitingOn,
      dependsOn: dependenciesOf(id, input.edges),
      runSessionId: item.runSessionId,
      branch: item.branch,
      prUrl: item.prUrl,
      checks: item.checks,
      developerMerges: developerMerges(input.mode, item),
      developerConfirms: developerConfirms(input.mode, item),
      estimateMinutes: item.estimateMinutes,
      actualMinutes,
      onCriticalPath: onPath.has(id),
      position: item.position,
      startedAt: item.startedAt,
      waitingSince: item.waitingSince,
      mergedAt: item.mergedAt,
      doneAt: item.doneAt,
      spans: [],
      stoppedSince: view.stoppedSince ?? null,
    };
  });
  return {
    items,
    criticalPath: { itemIds: critical.path, minutes: critical.minutes },
    progress: { done, total: ids.length, percent: ids.length === 0 ? 0 : Math.round((done / ids.length) * 100) },
    estimatedMinutesLeft,
  };
}

/**
 * The items that may start now: stored `pending`, every dependency `done`, in plan order,
 * at most `slots` of them. A failed dependency keeps its dependents from ever starting here
 * (they are `blocked` in the view).
 */
export function readyItems<T extends Pick<PlanItemFacts, 'id' | 'state' | 'position'>>(items: readonly T[], edges: readonly PlanEdge[], slots: number): T[] {
  if (slots <= 0) return [];
  const state = new Map(items.map((item) => [item.id, item.state]));
  return [...items]
    .sort((a, b) => a.position - b.position)
    .filter((item) => item.state === 'pending' && dependenciesOf(item.id, edges).every((dep) => state.get(dep) === 'done'))
    .slice(0, slots);
}

// ── names and safeguards ──────────────────────────────────────────────────

/** A ticket key (`PROJ-123`): letters / digits starting with a letter, a dash, a number. */
export const PLAN_ITEM_KEY = /^[A-Z][A-Z0-9]*-[0-9]+$/;

/** The key as stored (trimmed, upper-cased), `null` when blank; `undefined` when it is not a ticket key. */
export function normalizeItemKey(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const key = value.trim().toUpperCase();
  if (key === '') return null;
  return PLAN_ITEM_KEY.test(key) ? key : undefined;
}

/**
 * The base of an item's run branch (D99): `<KEY>-<slug>` (D32's ticket-branch form) with a
 * key, else `todo/<slug>` (D76's form). `slug` is the D22 short name of the title. The run
 * makes it unique (`-2`, `-3`, … when a repo has it already).
 */
export function planItemBranch(key: string | null, slug: string): string {
  return key ? `${key}-${slug}` : `todo/${slug}`;
}

// ── D122: Plan PRs and commits reference only their own ticket ────────────

/** D122: a ticket key anywhere in a text (`PROJ-123`), as tracker automations find them. */
const TICKET_KEY_IN_TEXT = /\b[A-Z][A-Z0-9]*-[0-9]+\b/g;

/**
 * D122: `text` without any ticket key other than `ownKey` (`null` = keep none): a tracker's
 * automation acts on every key it finds in a PR, a branch or a commit (a merged PR naming another
 * ticket moves that ticket to Done). Spaces and stray separators left behind are folded.
 */
export function withoutOtherKeys(text: string, ownKey: string | null): string {
  const stripped = text.replace(TICKET_KEY_IN_TEXT, (key) => (key === ownKey ? key : ''));
  if (stripped === text) return text;
  return stripped
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s+([,.;:)\]])/g, '$1')
    .replace(/([(\[])\s+/g, '$1')
    .replace(/^[\s,.;:\-–—/]+|[\s,;:\-–—/]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** D122: the ticket keys in `text` other than `ownKey` (tests and checks). */
export function otherKeysIn(text: string, ownKey: string | null): string[] {
  return [...new Set((text.match(TICKET_KEY_IN_TEXT) ?? []).filter((key) => key !== ownKey))];
}

/**
 * D122: the brief's rule on ticket keys (next to the D118 context, which names other tickets the
 * agent needs to know about): the PR title and description, the branch name and every commit
 * message name only the item's own key.
 */
export function planOwnKeyRule(key: string | null): string {
  const own = key ? `only this item's own ticket key, ${key}` : 'no ticket key at all (this item has none of its own)';
  return `Ticket keys: the pull request title, the pull request description, the branch name and every commit message may name ${own}, never any other key (not the epic, not a dependency, not a related ticket), because the tracker's automation acts on every key it finds (a merged pull request that names another ticket moves that ticket to Done). If you need to refer to other work, describe it without its key.`;
}

/** D122: the message of the developer's Merge commit (no target branch name: it may carry the epic's key). */
export function planMergeMessage(key: string | null): string {
  return key ? `Merge ${key} into the plan's target` : "Merge a plan item into the plan's target";
}

// ── D121: a fresh item branch is never "merged"; falsely done items are reopened ──

/** D102: the note of an item the developer merged with the Merge step. */
export function planMergedByYouNote(target: string): string {
  return `merged by you into ${target}`;
}

/** D99: the note of an item the developer counted as done (Mark done). */
export const PLAN_MARKED_DONE_NOTE = 'marked done by the developer';

/**
 * D121: whether a done item's done came from the git detection (its branch read as merged into
 * the target: the agent's merge, a PR merged on GitHub): not the developer's Merge, not Mark done.
 * Only these are re-checked by the auto-repair.
 */
export function doneByGitDetection(item: Pick<PlanItemFacts, 'state' | 'note'>): boolean {
  if (item.state !== 'done') return false;
  return item.note !== PLAN_MARKED_DONE_NOTE && !(item.note ?? '').startsWith('merged by you into ');
}

/** D121: the start of a reopened item's note and of the dependents' warning (the UI marks them). */
export const PLAN_REOPENED_PREFIX = 'Reopened';
export const PLAN_EARLY_START_PREFIX = 'started before';

/** D121: why an item was reopened (`auto`: the auto-repair; `developer`: Reopen). */
export function planReopenedWhy(how: 'auto' | 'developer', target: string | null): string {
  return how === 'auto' ? `it was marked merged but its branch isn't in ${target ?? 'the target'}` : 'reopened by you';
}

/** D121: the warning on a dependent that started while item `key` was falsely done. */
export function planEarlyStartWarning(label: string): string {
  return `${PLAN_EARLY_START_PREFIX} ${label} was merged — its branch may lack that work`;
}

/** D121: the note on a reopened item whose ticket was told it was merged / Done. */
export function planJiraToldNote(key: string): string {
  return `Jira was told this was merged/Done — check ${key}`;
}

/** A git branch name Switchboard accepts for a plan's target / base (no spaces, no `..`, no leading `-`, …). */
export function isBranchName(value: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(value) && !value.startsWith('-') && !value.startsWith('/') && !value.endsWith('/') && !value.endsWith('.lock') && !value.includes('..') && !value.includes('//');
}

/**
 * D99 safeguard: why agents merging into `target` needs the developer's acknowledgement, or
 * `null` when it does not. Protected: `dev`, `develop`, `master`, `main`
 * ({@link PLAN_FORBIDDEN_TARGETS}), `origin/…` of those, the repo's default branch, and a
 * protected branch (as gh reports it). D99 follow-up 2026-10-15: no longer a hard refusal; an
 * agent mode starts with `allowProtectedTarget: true` (`docs/plans.md` → *Safeguards*).
 */
export function forbiddenTargetReason(target: string, facts: { readonly defaultBranches?: readonly string[]; readonly protectedBranches?: readonly string[] } = {}): string | null {
  const name = target.replace(/^origin\//, '');
  if (PLAN_FORBIDDEN_TARGETS.includes(name.toLowerCase())) return `agents would merge straight into ${name}`;
  if ((facts.defaultBranches ?? []).includes(name)) return `${name} is the repository's default branch: agents would merge straight into it`;
  if ((facts.protectedBranches ?? []).includes(name)) return `${name} is a protected branch: agents would merge straight into it`;
  return null;
}

/** The refusal of an agent mode on a protected target without the acknowledgement (422 `target-forbidden`). */
export function protectedTargetRefusal(reason: string): string {
  return `${reason}. Ask the developer whether agents may merge straight into it; if they agree, start again with allowProtectedTarget: true (or give the plan its own feature branch).`;
}

// ── PR checks ─────────────────────────────────────────────────────────────

/**
 * D109: the rollup reading moved to the shared PR watcher's `core/ci.ts` (Plans reads its
 * PR checks through that watcher); re-exported here for Plans' own callers.
 */
export { checksFromRollup } from './ci.ts';

// ── texts sent to an item's session ───────────────────────────────────────

/** Input of {@link planItemBrief}. */
export interface PlanItemBriefInput {
  readonly planTitle: string;
  /** `null` = no target branch (a plan without a merge step). */
  readonly targetBranch: string | null;
  /** D99 follow-up 2026-10-15: the plan has no merge step (`none`): the brief asks for no PR and no merge. */
  readonly noMerge?: boolean;
  /** D99 follow-up 2026-10-15: in a plan without a merge step, the developer confirms this item (a hold). */
  readonly developerConfirms?: boolean;
  readonly notes: string | null;
  readonly key: string | null;
  /** The run's branch; `null` = no worktree (the run works in the source folder). */
  readonly branch: string | null;
  readonly developerMerges: boolean;
  readonly todo: { readonly id: string; readonly title: string; readonly description: string | null; readonly plan: string | null };
  /**
   * D118: a block read from the plan's external list when the run starts (a Jira plan's "Jira
   * context"), put after the brief and before the merge rule; `null` / omitted = none.
   */
  readonly context?: string | null;
  /** D118: the todo's description is the external list's own text and {@link context} has it fresh: leave it out. */
  readonly omitDescription?: boolean;
}

/** D118: the longest first message of an item's run with a context block (the block gets what the brief leaves). */
export const PLAN_RUN_MESSAGE_MAX = 40_000;

/** The merge rule lines of a brief (also sent again when the plan's mode or the item's hold changes). */
export function planMergeRule(input: { readonly targetBranch: string; readonly branch: string; readonly developerMerges: boolean }): string {
  return input.developerMerges
    ? `Do not merge it yourself: the developer merges it into ${input.targetBranch} from the Plans page in Switchboard once you mark the todo done.`
    : `Once its checks are green, merge the pull request into ${input.targetBranch} yourself (gh pr merge). Never merge into any branch other than ${input.targetBranch}. If a check fails, fix it and push again first. If the repository has no remote or gh is not available, merge ${input.branch} into ${input.targetBranch} locally instead.`;
}

/**
 * D99: the first message of an item's run session: the todo's title, description and plan
 * (its acceptance criteria), the plan's notes, and what to do at the end: push, open a PR into
 * the target branch, and (agent modes) merge it once the checks are green, then mark the todo done.
 */
export function planItemBrief(input: PlanItemBriefInput): string {
  const head = `Work on todo [${input.todo.id}]: ${input.todo.title}`;
  const where =
    input.branch === null
      ? 'You work in the source folder (no worktree of your own).'
      : input.targetBranch === null
        ? `Your branch is ${input.branch}.`
        : `Your branch is ${input.branch}, cut from ${input.targetBranch}.`;
  const lines: string[] = [head, `This is ${input.key ? `${input.key}, ` : ''}an item of the plan "${input.planTitle}". ${where}`];
  if (input.todo.description && input.todo.description.trim() !== '' && input.omitDescription !== true) lines.push(input.todo.description.trim());
  if (todoHasPlan(input.todo.plan)) lines.push(`Plan and acceptance criteria:\n${(input.todo.plan as string).trim()}`);
  if (input.notes && input.notes.trim() !== '') lines.push(`Notes for every item of this plan:\n${input.notes.trim()}`);
  // D122: the rule on ticket keys sits right next to the D118 context (which names the other tickets).
  const keyRule = planOwnKeyRule(input.key);
  if (input.context && input.context.trim() !== '') lines.push(`${input.context.trim()}\n\n${keyRule}`);
  else lines.push(keyRule);
  if (input.noMerge === true || input.targetBranch === null) {
    // D99 follow-up 2026-10-15: a plan without a merge step: the item is done when its todo is.
    lines.push(
      [
        'When the work is done:',
        '1. This plan has no merge step: Switchboard merges nothing and watches no pull request for it. Commit, push or open a pull request only if the todo asks for it.',
        `2. ${todoFinishLine(input.todo.id)}${input.developerConfirms === true ? ' The developer then confirms it on the Plans page.' : ' That finishes this item: the items that wait on it start then.'}`,
      ].join('\n'),
    );
    return lines.join('\n\n');
  }
  const target = input.targetBranch;
  const branch = input.branch ?? 'your branch';
  lines.push(
    [
      'When the work is done:',
      `1. Commit it on ${branch} and push the branch.`,
      `2. Open a pull request into ${target} (gh pr create --base ${target}).`,
      `3. ${planMergeRule({ targetBranch: target, branch, developerMerges: input.developerMerges })}`,
      `4. ${todoFinishLine(input.todo.id)}`,
      `If ${target} moved on and your branch conflicts with it, rebase onto ${target} first.`,
    ].join('\n'),
  );
  return lines.join('\n\n');
}

/** D99: sent to an item's session when its PR's checks are red (once per head and failure). */
export function planChecksMessage(targetBranch: string, summary: string): string {
  return `The checks of your pull request into ${targetBranch} ${summary.startsWith('failed') ? summary : `failed: ${summary}`}. Fix them and push again; merge only once they are green. The items that depend on yours wait until then.`;
}

/** D99: sent to an item's session the first time its branch conflicts with the target branch. */
export function planConflictMessage(branch: string, targetBranch: string): string {
  return `Your branch ${branch} conflicts with ${targetBranch} (other work of the plan was merged into it). Rebase onto ${targetBranch}, resolve the conflicts, run the tests and push again.`;
}

/** D99: sent to a running item's session when the plan's merge mode or its hold changed (merging modes only: `none` is fixed once started). */
export function planRuleChangedMessage(input: { readonly targetBranch: string; readonly branch: string; readonly developerMerges: boolean }): string {
  return `The plan's merge rule changed for this item. ${planMergeRule(input)}`;
}

// ── MCP tools (the `switchboard` server) ──────────────────────────────────

const PLAN_ID = { type: 'string', description: 'The plan id, as plan_create or plan_status shows it in brackets.' } as const;

/** D99: the plan tools of the `switchboard` MCP server (`src/hook/sb-mcp.ts`). */
export const PLAN_TOOLS: readonly TodoToolDefinition[] = [
  {
    name: 'plan_create',
    description:
      "Create a plan (a draft): todo items of this session grouped into a dependency graph that Switchboard runs by itself, each item in its own session (and worktree, in a git repository), with up to max_concurrency running at once. Plans are for anything: the tasks of an epic merged into a feature branch, work merged straight into dev or main, or work with no merge at all (research, docs elsewhere, ops tasks, agents that push on their own). Give a title and, optionally, the target branch: the branch every item's work is merged into (e.g. the epic's feature branch feature/PROJ-100-acme-epic; dev, main, master or the default branch are allowed too, but agents merging into one needs the developer's acknowledgement at plan_start). Leave target_branch out (or give \"none\") for a plan without a merge step: an item is done when its agent marks its todo done. Then add items with plan_add_item, order them with plan_add_dependency, check with plan_status, and start it with plan_start after asking the developer for the merge mode. Returns the plan id.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The plan name, e.g. the epic: "PROJ-100 Acme checkout".' },
        target_branch: { type: 'string', description: "Optional: the branch every item's work is merged into (e.g. the epic feature branch; dev, main or master are allowed). It is created from base_branch when a repo does not have it. Leave it out, or give \"none\", for a plan without a merge step (items are done when their todos are)." },
        base_branch: { type: 'string', description: 'The branch the developer merges the target into at the end (default dev).' },
        repos: { type: 'array', items: { type: 'string' }, description: "In a workspace: the solution repos the target branch lives in (default: this session's solutions). Ignored in a repo folder." },
        max_concurrency: { type: 'integer', minimum: 1, maximum: PLAN_CONCURRENCY_MAX, description: 'At most this many items run at once (default 3).' },
        usage_threshold: { type: 'integer', minimum: 1, maximum: 100, description: 'No new item starts while the account it would use is at or above this percent of its 5-hour or weekly limit (default 85).' },
        work_type: { type: 'string', enum: ['feature', 'qa'], description: "Workspace start answer for every item's session (like a Full start); default this session's." },
        mode: { type: 'string', enum: ['single', 'orchestrator'], description: "Workspace start answer for every item's session; default this session's." },
        phase: { type: 'string', enum: ['ui-first', 'integration'], description: "Workspace start answer for every item's session; default this session's." },
        notes: { type: 'string', description: "Extra notes added to every item's brief, e.g. a testing carve-out." },
      },
      required: ['title'],
      additionalProperties: false,
    },
    annotations: { title: 'Create a plan', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'plan_add_item',
    description:
      "Add an item to a plan: an existing todo of this session (todo_id) or a new one (title, description, plan with the acceptance criteria, priority, estimate_minutes; it is added to this session's todo list). Optionally a ticket key (names the item's branch), hold (in the agents-with-holds mode the developer merges this one), its solutions (a subset of the plan's repos) and after (ids or keys of items it runs after). Returns the item id. Only for a todo that is not in the plan yet: to change an item that is already in the plan (its hold, title, description or estimate) use plan_update_item; never add it again.",
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: PLAN_ID,
        todo_id: { type: 'string', description: 'An existing todo item of this session, as todo_list shows it in brackets.' },
        title: { type: 'string', description: 'A new todo: one short line naming the work.' },
        description: { type: 'string', description: 'A new todo: for the developer, a plain and brief explanation.' },
        plan: { type: 'string', description: 'A new todo: the handover for the agent who runs it: context, files, steps and acceptance criteria.' },
        priority: { type: 'string', enum: ['urgent', 'high', 'medium', 'low'], description: 'A new todo: its priority (default medium).' },
        estimate_minutes: { type: 'integer', minimum: 1, maximum: 10_080, description: 'A new todo: minutes an AI agent would take (used for the critical path and the time left).' },
        key: { type: 'string', description: 'Optional ticket key, e.g. PROJ-123: the item branch becomes PROJ-123-<slug>.' },
        hold: { type: 'boolean', description: 'In the agents-with-holds mode, the developer merges this item from the Plans page (default false).' },
        solutions: { type: 'array', items: { type: 'string' }, description: "The plan repos this item works in (default all of the plan's; in a plan whose repositories are picked per item, the workspace's solutions it works in: without them it waits)." },
        after: { type: 'array', items: { type: 'string' }, description: 'Ids or keys of the items this one runs after.' },
      },
      required: ['plan_id'],
      additionalProperties: false,
    },
    annotations: { title: 'Add a plan item', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'plan_add_dependency',
    description: 'Make an item of a plan run after another one ("item after after"): it starts only once that one is done. A dependency that would make a cycle is refused.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: PLAN_ID,
        item: { type: 'string', description: 'The id or key of the item that waits.' },
        after: { type: 'string', description: 'The id or key of the item it runs after.' },
      },
      required: ['plan_id', 'item', 'after'],
      additionalProperties: false,
    },
    annotations: { title: 'Add a plan dependency', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'plan_status',
    description:
      "Show a plan: its state, merge mode, progress, the time left, and each item's state (waiting, ready, running, question, stopped (its agent ended its turn without finishing: its last message is the reason), needs-you (its agent ended its turn waiting for the developer: its ask is the reason), ready-to-merge, done or blocked with the reason), branch and dependencies. Without plan_id: this session's plans.",
    inputSchema: { type: 'object', properties: { plan_id: PLAN_ID }, additionalProperties: false },
    annotations: { title: 'Plan status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'plan_start',
    description:
      "Start a plan: Switchboard starts the ready items as runs by itself. merge_mode is the developer's decision: ASK the developer which one they want before calling this, and never choose it yourself. Explain the options: agents (each item's agent merges its PR into the target branch once the checks are green), agents-with-holds (the same, but items marked hold wait for the developer's Merge; recommended), developer (the developer merges every item from the Plans page) and none (no merging: an item is done when its agent marks its todo done; items marked hold wait for the developer to confirm them). A plan without a target branch can only be none (merge_mode may be left out then). If the target is dev, develop, main, master, the default or a protected branch and the developer picks agents or agents-with-holds, agents merge straight into it: ASK the developer to confirm that too, and only then pass allow_protected_target: true; never set it on your own. Together with the merge mode, ASK the developer for the sidebar subfolder the plan's runs go into (suggest the plan's title): pass its name as sidebar_folder (it is made inside the source session's sidebar folder, or reused when one with that name is there already); an empty string means no subfolder (the runs go next to this session); leave it out only when the developer has no preference to give.",
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: PLAN_ID,
        merge_mode: { type: 'string', enum: [...PLAN_MERGE_MODES], description: 'The merge mode the developer chose (ask them; never pick it yourself): agents, agents-with-holds, developer or none. Required when the plan has a target branch; a plan without one is none.' },
        allow_protected_target: { type: 'boolean', description: 'The developer confirmed that agents may merge straight into a protected target (dev, develop, main, master, the default or a protected branch). Ask them first; never set it yourself. Needed only for agents / agents-with-holds on such a target.' },
        sidebar_folder: { type: 'string', maxLength: 60, description: "The name of the sidebar subfolder the plan's runs go into, as the developer gave it (ask them; suggest the plan's title, at most 60 characters). Made inside this session's sidebar folder (the top level when it has none), or reused when a folder with that exact name is there already. An empty string = no subfolder (the runs go next to this session)." },
      },
      required: ['plan_id'],
      additionalProperties: false,
    },
    annotations: { title: 'Start a plan', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'plan_set_solutions',
    description:
      "Set the repositories (workspace solutions) items of a plan of this session work in. Use it when Switchboard asks you to pick the repositories of a plan's items, e.g. after a Jira import into a workspace: read each item (todo_get for the details) and give every item the solutions its work touches, from the list of the workspace's solutions in the ask (read-only ones are refused). Your choice is applied at once (it is not a proposal): an item can start only once it has solutions, and the plan's repos become the union of its items' solutions. Give every item in one call when you can. An item that already started keeps its solutions. Unknown or read-only names refuse the whole call with the reason; nothing changes then.",
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: PLAN_ID,
        items: {
          type: 'array',
          minItems: 1,
          maxItems: PLAN_ITEMS_MAX,
          description: 'One entry per item: the item and the solutions it works in.',
          items: {
            type: 'object',
            properties: {
              item: { type: 'string', description: 'The key (PROJ-123) or the item id of the item.' },
              solutions: { type: 'array', minItems: 1, items: { type: 'string' }, description: "The names of the workspace's solutions this item works in, e.g. [\"web-front\", \"mobile\"]." },
            },
            required: ['item', 'solutions'],
            additionalProperties: false,
          },
        },
      },
      required: ['plan_id', 'items'],
      additionalProperties: false,
    },
    // Destructive: it overwrites a pending item's solutions (docs/mcp.md → Tool annotations).
    annotations: { title: "Set plan items' repositories", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'plan_update_item',
    description:
      "Change an item that is already in a plan of this session (use this, not plan_add_item, for an item in the plan). hold: in the agents-with-holds mode the developer merges a held item from the Plans page (in a plan without a merge step, the developer confirms it); it can change while the plan is a draft, runs or is paused, until the item is merged or done, and a running item's session is told its new merge rule. Clearing a hold lets the item's agent merge it on its own: do that only when the developer asked. title, description and estimate_minutes change the item's todo, only before the item starts. To change its dependencies use plan_add_dependency and plan_remove_dependency. Switchboard refuses what it would refuse the developer, with the reason; nothing changes then.",
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: PLAN_ID,
        item: { type: 'string', description: 'The id or key of the item, as plan_status shows it.' },
        hold: { type: 'boolean', description: 'true: the developer merges (or, without a merge step, confirms) this item; false: it follows the plan\'s merge mode. Until the item is merged or done.' },
        title: { type: 'string', description: "The item's new title (its todo's): one short line naming the work. Only before the item starts." },
        description: { type: 'string', description: "The item's new description (its todo's), for the developer; an empty string removes it. Only before the item starts." },
        estimate_minutes: { type: 'integer', minimum: 1, maximum: 10_080, description: "The item's new estimate (its todo's): minutes an AI agent would take. Only before the item starts." },
      },
      required: ['plan_id', 'item'],
      additionalProperties: false,
    },
    annotations: { title: 'Update a plan item', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'plan_remove_item',
    description:
      "Remove an item that has not started from a plan of this session; its dependencies go with it. Its todo stays in this session's todo list (todo_remove deletes it if it should go too). An item that runs or is done is refused.",
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: PLAN_ID,
        item: { type: 'string', description: 'The id or key of the item, as plan_status shows it.' },
      },
      required: ['plan_id', 'item'],
      additionalProperties: false,
    },
    annotations: { title: 'Remove a plan item', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'plan_remove_dependency',
    description: 'Remove a dependency of a plan of this session: item to no longer waits for item from (the reverse of plan_add_dependency, where to is item and from is after). A dependency that does not exist is refused.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: PLAN_ID,
        from: { type: 'string', description: 'The id or key of the item that goes first (plan_add_dependency\'s after).' },
        to: { type: 'string', description: 'The id or key of the item that waits for it (plan_add_dependency\'s item).' },
      },
      required: ['plan_id', 'from', 'to'],
      additionalProperties: false,
    },
    annotations: { title: 'Remove a plan dependency', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'plan_set_mode',
    description:
      "Change the merge mode of a plan of this session that is a draft, runs or is paused. It applies to the items not merged yet, and running items whose merge rule changed are told their new rule. merge_mode is the developer's decision: ASK the developer before calling this, and never change it on your own. The options: agents (each item's agent merges its PR into the target branch once the checks are green), agents-with-holds (the same, but held items wait for the developer's Merge), developer (the developer merges every item) and none (no merge step). A started plan keeps whether it has a merge step (none to a merging mode or back is refused). If the target is dev, develop, main, master, the default or a protected branch and the new mode is agents or agents-with-holds, agents merge straight into it: ASK the developer to confirm that too, and only then pass allow_protected_target: true; never set it on your own. For an item's hold use plan_update_item.",
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: PLAN_ID,
        merge_mode: { type: 'string', enum: [...PLAN_MERGE_MODES], description: 'The merge mode the developer chose (ask them; never pick it yourself): agents, agents-with-holds, developer or none.' },
        allow_protected_target: { type: 'boolean', description: 'The developer confirmed that agents may merge straight into a protected target (dev, develop, main, master, the default or a protected branch). Ask them first; never set it yourself. Needed only for agents / agents-with-holds on such a target.' },
      },
      required: ['plan_id', 'merge_mode'],
      additionalProperties: false,
    },
    // Open-world like plan_start: the mode decides whether agents merge PRs, and the protected-target check asks gh.
    annotations: { title: "Change a plan's merge mode", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

/** D115: an item's description in the ask is cut to this many characters (the agent reads the rest with todo_get). */
export const PICK_REPOS_DESCRIPTION_MAX = 600;

/**
 * D115: the ask to a plan's source session to pick each item's repositories with
 * `plan_set_solutions`: the workspace's solutions (read-only ones left out) and the items without
 * solutions (key, title, description). `also` = it follows the ask for the missing order in the same message.
 */
export function pickReposMessage(input: {
  readonly planId: string;
  readonly planTitle: string;
  readonly solutions: readonly string[];
  readonly items: ReadonlyArray<{ readonly label: string; readonly id: string; readonly todoId: string; readonly title: string; readonly description: string | null }>;
  readonly also?: boolean;
}): string {
  const cut = (text: string): string => (text.length > PICK_REPOS_DESCRIPTION_MAX ? `${text.slice(0, PICK_REPOS_DESCRIPTION_MAX - 1).trimEnd()}… (the rest: todo_get)` : text);
  const items = input.items.map((item) => {
    const description = (item.description ?? '').trim();
    return `- ${item.label} [${item.id}] (todo [${item.todoId}]): ${item.title}${description === '' ? '' : `\n  ${cut(description).replace(/\n+/g, '\n  ')}`}`;
  });
  return [
    input.also === true
      ? `Also pick the repositories of the plan "${input.planTitle}" [${input.planId}]: its items have none yet, and an item starts only once it has some.`
      : `Please pick the repositories of the plan "${input.planTitle}" [${input.planId}]: its items have none yet, and an item starts only once it has some.`,
    `The workspace's solutions you can pick from: ${input.solutions.length > 0 ? input.solutions.join(', ') : '(none found: say so to the developer)'}.`,
    `Items without repositories:\n${items.join('\n')}`,
    `Decide which solutions each item's work touches (todo_get for an item's full details), then call plan_set_solutions once with plan_id ${input.planId} and items: [{ item: <key or id>, solutions: [...] }] for every item above. It is applied at once; the developer can change an item's repositories later. Do not start any work yourself.`,
  ].join('\n\n');
}

/** One line per item for `plan_status`. */
export function planStatusText(plan: Plan): string {
  const target = plan.targetBranch === null ? 'no target branch (no merge step)' : plan.mergeMode === 'none' ? `${plan.targetBranch} (no merge step)` : `${plan.targetBranch} → ${plan.baseBranch}${plan.allowProtectedTarget ? ' (agents merge: acknowledged)' : ''}`;
  const repos = plan.reposPerItem === true ? ` · repos picked per item${plan.repos.length > 0 ? ` (${plan.repos.join(', ')})` : ''}` : '';
  const head = `[${plan.id}] ${plan.title}: ${plan.state}${plan.mergeMode ? ` · ${plan.mergeMode}` : ' · merge mode not chosen'} · ${target}${repos} · ${plan.progress.done}/${plan.progress.total} done${plan.estimatedMinutesLeft !== null ? ` · about ${plan.estimatedMinutesLeft} min left` : ''}${plan.held ? ` · held: ${plan.held}` : ''}`;
  const keyOf = new Map(plan.items.map((item) => [item.id, item.key ?? item.id]));
  const lines = plan.items.map((item) => {
    const after = item.dependsOn.length > 0 ? ` after ${item.dependsOn.map((id) => keyOf.get(id) ?? id).join(', ')}` : '';
    const extra = [item.reason, item.note].filter(Boolean).join('; ');
    const solutions = item.solutions.length > 0 ? ` · repos ${item.solutions.join(', ')}` : '';
    return `- [${item.id}]${item.key ? ` ${item.key}` : ''} ${item.title}: ${item.state}${item.hold ? ' (hold)' : ''}${after}${solutions}${item.branch ? ` · ${item.branch}` : ''}${extra ? ` · ${extra}` : ''}`;
  });
  return [head, ...lines].join('\n');
}
