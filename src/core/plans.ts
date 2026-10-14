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
 * D102: the developer's Merge is Plans' own step (it was a Review card, D79, until those were
 * removed): a finished item waits `ready-to-merge` on the Plans page and in the Inbox.
 */
export const PLAN_MERGE_MODES = ['agents', 'agents-with-holds', 'developer'] as const;
/** One of {@link PLAN_MERGE_MODES}. */
export type PlanMergeMode = (typeof PLAN_MERGE_MODES)[number];

/** The merge mode the UI pre-selects (never applied by the server: `start` requires the field). */
export const RECOMMENDED_MERGE_MODE: PlanMergeMode = 'agents-with-holds';

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
 * - `ready-to-merge` (D102): its run finished (its todo is done, or its PR is open with green
 *   checks) and it waits for the developer's Merge ("Waiting for your merge");
 * - `done`: merged into the target branch (and the checks are green, in agent modes);
 * - `blocked`: it failed (discarded, could not start), its session stopped with an error, a
 *   conflict went to the developer, or a dependency is blocked; {@link PlanItem.reason} says why.
 */
export const PLAN_ITEM_STATES = ['waiting', 'ready', 'running', 'question', 'ready-to-merge', 'done', 'blocked'] as const;
/** One of {@link PLAN_ITEM_STATES}. */
export type PlanItemState = (typeof PLAN_ITEM_STATES)[number];

/**
 * What a running item waits on (stored, with `waitingSince`): the developer's Merge (D102;
 * stored as `review` in `plans.db`, the name its CHECK has), its PR's checks, the developer's
 * answer, a conflict.
 */
export type PlanWaitingOn = 'merge' | 'checks' | 'question' | 'conflict';

/** The state of an item's PR checks: `pending` (running), `green`, `red`, `none` (no checks configured: counts as green). D109: the shared watcher's {@link PrChecksState}. */
export type PlanChecksState = PrChecksState;

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

/** Branches agents may never merge into (D99 safeguard), besides the repo's default branch and its protected branches. */
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
  /** The plan repos it works in (empty = all of them). */
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
}

/**
 * What an item was doing over a span of time (the Plans page's Timeline; `docs/plans.md` → *Item history*):
 * - `running`: its agent works (including while its PR's checks run);
 * - `waiting-you`: a question, its merge (`ready-to-merge`), a second conflict or a stopped session waits for the developer;
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
    case 'ready-to-merge':
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

/** A plan with its computed view model (`GET /api/plans/{id}`). */
export interface Plan {
  readonly id: string;
  readonly title: string;
  readonly sourceSessionId: string;
  readonly targetBranch: string;
  readonly repos: readonly string[];
  readonly baseBranch: string;
  /** `null` until started (a draft). */
  readonly mergeMode: PlanMergeMode | null;
  readonly maxConcurrency: number;
  readonly usageThreshold: number;
  readonly answers: PlanAnswers | null;
  readonly state: PlanState;
  readonly external: PlanExternalRef | null;
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

/** The setting of Settings → Experimental → **Plans** (off by default; `docs/plans.md` → *The switch*). */
export const PLANS_SETTING = 'experimental.plans';

/** Why a running plan was paused when Plans was switched off (shown on the plan; the developer resumes it). */
export const PLANS_OFF_REASON = 'Plans was switched off';

/** `GET /api/plans/state`: the switch (always answered, also while Plans is off). */
export interface PlansState {
  /** Settings → Experimental → Plans. */
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
}

/** A short label of an item in reasons: its key, else its title in quotes. */
export function itemLabel(item: Pick<PlanItemFacts, 'key' | 'title'>): string {
  return item.key ?? `"${item.title}"`;
}

/** Whether the developer merges item `item` under `mode` (`null` mode = a draft: the agents' rule is not known yet). */
export function developerMerges(mode: PlanMergeMode | null, item: Pick<PlanItemFacts, 'hold'>): boolean {
  return mode === 'developer' || (mode === 'agents-with-holds' && item.hold);
}

/** Minutes between two ISO times (at least 0), rounded. */
function minutesBetween(from: string, to: number): number {
  return Math.max(0, Math.round((to - Date.parse(from)) / 60_000));
}

/** An item's own view state and reason, before its dependencies are looked at. */
function ownState(item: PlanItemFacts, mode: PlanMergeMode | null, targetBranch: string): { state: PlanItemState; reason: string | null } | null {
  switch (item.state) {
    case 'done':
      return { state: 'done', reason: null };
    case 'failed':
      return { state: 'blocked', reason: item.reason ?? 'it failed' };
    case 'running':
      if (item.sessionStatus === 'fail') return { state: 'blocked', reason: 'its session stopped with an error' };
      if (item.waitingOn === 'conflict' && item.conflicts >= 2) return { state: 'blocked', reason: `its branch conflicts with ${targetBranch} again: waiting for you in the Inbox` };
      if (item.sessionStatus === 'need') return { state: 'question', reason: 'its session waits for your answer in the Inbox' };
      if (developerMerges(mode, item) && item.waitingOn === 'merge') return { state: 'ready-to-merge', reason: 'waiting for your merge' };
      return { state: 'running', reason: null };
    case 'pending':
      return null;
  }
}

/** Input of {@link planView}. */
export interface PlanViewInput {
  readonly mode: PlanMergeMode | null;
  readonly targetBranch: string;
  readonly maxConcurrency: number;
  readonly items: readonly PlanItemFacts[];
  readonly edges: readonly PlanEdge[];
  /** Now (epoch ms). */
  readonly now: number;
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
  const views = new Map<string, { state: PlanItemState; reason: string | null }>();
  for (const id of order) {
    const item = byId.get(id) as PlanItemFacts;
    const own = ownState(item, input.mode, input.targetBranch);
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
    const view = views.get(id) as { state: PlanItemState; reason: string | null };
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
      estimateMinutes: item.estimateMinutes,
      actualMinutes,
      onCriticalPath: onPath.has(id),
      position: item.position,
      startedAt: item.startedAt,
      waitingSince: item.waitingSince,
      mergedAt: item.mergedAt,
      doneAt: item.doneAt,
      spans: [],
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

/** A git branch name Switchboard accepts for a plan's target / base (no spaces, no `..`, no leading `-`, …). */
export function isBranchName(value: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(value) && !value.startsWith('-') && !value.startsWith('/') && !value.endsWith('/') && !value.endsWith('.lock') && !value.includes('..') && !value.includes('//');
}

/**
 * D99 safeguard: why agents may not merge into `target`, or `null` when they may. Refused:
 * `dev`, `develop`, `master`, `main` ({@link PLAN_FORBIDDEN_TARGETS}), `origin/…` of those,
 * the repo's default branch, and a protected branch (as gh reports it).
 */
export function forbiddenTargetReason(target: string, facts: { readonly defaultBranches?: readonly string[]; readonly protectedBranches?: readonly string[] } = {}): string | null {
  const name = target.replace(/^origin\//, '');
  if (PLAN_FORBIDDEN_TARGETS.includes(name.toLowerCase())) return `agents never merge into ${name}: give the plan its own feature branch (e.g. feature/PROJ-100-acme-epic)`;
  if ((facts.defaultBranches ?? []).includes(name)) return `${name} is the repository's default branch: agents never merge into it`;
  if ((facts.protectedBranches ?? []).includes(name)) return `${name} is a protected branch: agents never merge into it`;
  return null;
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
  readonly targetBranch: string;
  readonly notes: string | null;
  readonly key: string | null;
  readonly branch: string;
  readonly developerMerges: boolean;
  readonly todo: { readonly id: string; readonly title: string; readonly description: string | null; readonly plan: string | null };
}

/** The merge rule lines of a brief (also sent again when the plan's mode or the item's hold changes). */
export function planMergeRule(input: { readonly targetBranch: string; readonly branch: string; readonly developerMerges: boolean }): string {
  return input.developerMerges
    ? `Do not merge it yourself: the developer merges it into ${input.targetBranch} from the Plans page in Switchboard once you mark the todo done.`
    : `Once its checks are green, merge the pull request into ${input.targetBranch} yourself (gh pr merge). Never merge into dev, master, main or any branch other than ${input.targetBranch}. If a check fails, fix it and push again first. If the repository has no remote or gh is not available, merge ${input.branch} into ${input.targetBranch} locally instead.`;
}

/**
 * D99: the first message of an item's run session: the todo's title, description and plan
 * (its acceptance criteria), the plan's notes, and what to do at the end: push, open a PR into
 * the target branch, and (agent modes) merge it once the checks are green, then mark the todo done.
 */
export function planItemBrief(input: PlanItemBriefInput): string {
  const head = `Work on todo [${input.todo.id}]: ${input.todo.title}`;
  const lines: string[] = [head, `This is ${input.key ? `${input.key}, ` : ''}an item of the plan "${input.planTitle}". Your branch is ${input.branch}, cut from ${input.targetBranch}.`];
  if (input.todo.description && input.todo.description.trim() !== '') lines.push(input.todo.description.trim());
  if (todoHasPlan(input.todo.plan)) lines.push(`Plan and acceptance criteria:\n${(input.todo.plan as string).trim()}`);
  if (input.notes && input.notes.trim() !== '') lines.push(`Notes for every item of this plan:\n${input.notes.trim()}`);
  lines.push(
    [
      'When the work is done:',
      `1. Commit it on ${input.branch} and push the branch.`,
      `2. Open a pull request into ${input.targetBranch} (gh pr create --base ${input.targetBranch}).`,
      `3. ${planMergeRule(input)}`,
      `4. ${todoFinishLine(input.todo.id)}`,
      `If ${input.targetBranch} moved on and your branch conflicts with it, rebase onto ${input.targetBranch} first.`,
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

/** D99: sent to a running item's session when the plan's merge mode or its hold changed. */
export function planRuleChangedMessage(input: { readonly targetBranch: string; readonly branch: string; readonly developerMerges: boolean }): string {
  return `The plan's merge rule changed for this item. ${planMergeRule(input)}`;
}

// ── MCP tools (the `switchboard` server) ──────────────────────────────────

const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const PLAN_ID = { type: 'string', description: 'The plan id, as plan_create or plan_status shows it in brackets.' } as const;

/** D99: the plan tools of the `switchboard` MCP server (`src/hook/sb-mcp.ts`). */
export const PLAN_TOOLS: readonly TodoToolDefinition[] = [
  {
    name: 'plan_create',
    description:
      "Create a plan (a draft): todo items of this session grouped into a dependency graph that Switchboard runs by itself, each item in its own session and worktree cut from the plan's target branch, with up to max_concurrency running at once. Use it when the developer wants several todos worked on in parallel or in order, e.g. the tasks of an epic. Give a title and the target branch (the epic's feature branch, e.g. feature/PROJ-100-acme-epic; never dev, master, main or the default branch). Then add items with plan_add_item, order them with plan_add_dependency, check with plan_status, and start it with plan_start after asking the developer for the merge mode. Returns the plan id.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The plan name, e.g. the epic: "PROJ-100 Acme checkout".' },
        target_branch: { type: 'string', description: "The branch every item's work is merged into (the epic feature branch). It is created from base_branch when a repo does not have it." },
        base_branch: { type: 'string', description: 'The branch the developer merges the target into at the end (default dev).' },
        repos: { type: 'array', items: { type: 'string' }, description: "In a workspace: the solution repos the target branch lives in (default: this session's solutions). Ignored in a repo folder." },
        max_concurrency: { type: 'integer', minimum: 1, maximum: PLAN_CONCURRENCY_MAX, description: 'At most this many items run at once (default 3).' },
        usage_threshold: { type: 'integer', minimum: 1, maximum: 100, description: 'No new item starts while the account it would use is at or above this percent of its 5-hour or weekly limit (default 85).' },
        work_type: { type: 'string', enum: ['feature', 'qa'], description: "Workspace start answer for every item's session (like a Full start); default this session's." },
        mode: { type: 'string', enum: ['single', 'orchestrator'], description: "Workspace start answer for every item's session; default this session's." },
        phase: { type: 'string', enum: ['ui-first', 'integration'], description: "Workspace start answer for every item's session; default this session's." },
        notes: { type: 'string', description: "Extra notes added to every item's brief, e.g. a testing carve-out." },
      },
      required: ['title', 'target_branch'],
      additionalProperties: false,
    },
    annotations: { title: 'Create a plan', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'plan_add_item',
    description:
      "Add an item to a plan: an existing todo of this session (todo_id) or a new one (title, description, plan with the acceptance criteria, priority, estimate_minutes; it is added to this session's todo list). Optionally a ticket key (names the item's branch), hold (in the agents-with-holds mode the developer merges this one), its solutions (a subset of the plan's repos) and after (ids or keys of items it runs after). Returns the item id.",
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
        solutions: { type: 'array', items: { type: 'string' }, description: "The plan repos this item works in (default all of the plan's)." },
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
      "Show a plan: its state, merge mode, progress, the time left, and each item's state (waiting, ready, running, question, ready-to-merge, done or blocked with the reason), branch and dependencies. Without plan_id: this session's plans.",
    inputSchema: { type: 'object', properties: { plan_id: PLAN_ID }, additionalProperties: false },
    annotations: { title: 'Plan status', ...READS },
  },
  {
    name: 'plan_start',
    description:
      "Start a plan: Switchboard starts the ready items as runs by itself. merge_mode is required and is the developer's decision: ASK the developer which one they want before calling this, and never choose it yourself. Explain the options: agents (each item's agent merges its PR into the target branch once the checks are green), agents-with-holds (the same, but items marked hold wait for the developer's Merge; recommended) and developer (the developer merges every item from the Plans page).",
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: PLAN_ID,
        merge_mode: { type: 'string', enum: [...PLAN_MERGE_MODES], description: 'The merge mode the developer chose (ask them; never pick it yourself): agents, agents-with-holds or developer.' },
      },
      required: ['plan_id', 'merge_mode'],
      additionalProperties: false,
    },
    annotations: { title: 'Start a plan', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];


/** One line per item for `plan_status`. */
export function planStatusText(plan: Plan): string {
  const head = `[${plan.id}] ${plan.title}: ${plan.state}${plan.mergeMode ? ` · ${plan.mergeMode}` : ' · merge mode not chosen'} · ${plan.targetBranch} → ${plan.baseBranch} · ${plan.progress.done}/${plan.progress.total} done${plan.estimatedMinutesLeft !== null ? ` · about ${plan.estimatedMinutesLeft} min left` : ''}${plan.held ? ` · held: ${plan.held}` : ''}`;
  const keyOf = new Map(plan.items.map((item) => [item.id, item.key ?? item.id]));
  const lines = plan.items.map((item) => {
    const after = item.dependsOn.length > 0 ? ` after ${item.dependsOn.map((id) => keyOf.get(id) ?? id).join(', ')}` : '';
    const extra = [item.reason, item.note].filter(Boolean).join('; ');
    return `- [${item.id}]${item.key ? ` ${item.key}` : ''} ${item.title}: ${item.state}${item.hold ? ' (hold)' : ''}${after}${item.branch ? ` · ${item.branch}` : ''}${extra ? ` · ${extra}` : ''}`;
  });
  return [head, ...lines].join('\n');
}
