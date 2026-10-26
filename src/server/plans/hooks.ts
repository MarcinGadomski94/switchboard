/**
 * D99 · the seams Plans plugs into the rest of Switchboard (`docs/plans-removal.md` lists
 * every call site). Each is a no-op until a {@link PlanService} registers itself for the store
 * (`registerPlanHooks`). Keyed by the main `Store` object (one app, one store), like Team's.
 */
export interface PlanHooks {
  /** D83: session `from` was continued in the fresh session `to` (its todos, ids kept, moved there). */
  sessionContinued(from: string, to: string): Promise<void>;
  /** D102: the Inbox's "Ready to merge" item's Merge: answers `null` when merged, else why not. */
  inboxMerge(planId: string, itemId: string): Promise<string | null>;
  /** D115 follow-ups: the Inbox's "wait for repositories" item's Ask again: answers `null` when asked, else why not (absent: refused). */
  inboxAskRepos?(planId: string): Promise<string | null>;
  /** D108: every plan item that ended (merged, failed, blocked), for Insights; `null` while Plans is off or `plans.db` is unavailable. */
  outcomes(): Promise<PlanItemOutcome[] | null>;
  /** Team (D100) hook (docs/team-removal.md), D100 follow-up 2026-10-16: the plan items of these todos (Team's sidebar member rows name them); empty while off. */
  itemsOfTodos(todoIds: readonly string[]): Promise<PlanItemRef[]>;
  /** D134 (Usage breakdown): the sessions that run plan items (their kind is "plan step"); empty while unavailable. */
  runSessionIds?(): Promise<string[]>;
}

/** D100 follow-up 2026-10-16: a plan item as Team's sidebar names a member's current item. */
export interface PlanItemRef {
  readonly todoId: string;
  /** Its ticket key (`PROJ-14`), `null` when it has none. */
  readonly key: string | null;
  readonly title: string;
}

/** D108: a plan item's outcome as Insights reads it (`docs/insights.md` → *Outcomes and rework*). */
export interface PlanItemOutcome {
  readonly itemId: string;
  readonly runSessionId: string | null;
  readonly outcome: 'merged' | 'failed' | 'blocked';
  /** When it ended: merged / done / last change (ISO). */
  readonly at: string;
}

const registry = new WeakMap<object, PlanHooks>();

/** Registers Plans' hooks for `store`; returns the unregister function. */
export function registerPlanHooks(store: object, hooks: PlanHooks): () => void {
  registry.set(store, hooks);
  return () => {
    if (registry.get(store) === hooks) registry.delete(store);
  };
}

/**
 * D83 seam (Continue in a fresh session): the plans whose source is `from` follow it to `to`, and
 * items run by `from` are run by `to`. A no-op while Plans is off: the move is then made when Plans
 * is switched on (from the sessions' `continuedTo` / `continuedFrom` links, `docs/plans.md`).
 */
export async function plansFollowContinuation(store: object, from: string, to: string): Promise<void> {
  await registry.get(store)?.sessionContinued(from, to);
}

/**
 * D102 seam (the Inbox's "Ready to merge" item, `system-items.ts`): merges plan item `itemId`
 * of plan `planId`. Answers `null` when merged, else the refusal's message (Plans off included).
 */
export async function plansInboxMerge(store: object, planId: string, itemId: string): Promise<string | null> {
  const hooks = registry.get(store);
  return hooks ? hooks.inboxMerge(planId, itemId) : 'Plans is not available (it has not started)';
}

/**
 * D115 follow-ups seam (the Inbox's "wait for repositories" item, `system-items.ts`): asks plan
 * `planId`'s agent again to pick its items' repositories. Answers `null` when asked, else the
 * refusal's message (Plans off included).
 */
export async function plansInboxAskRepos(store: object, planId: string): Promise<string | null> {
  const hooks = registry.get(store);
  if (!hooks) return 'Plans is not available (it has not started)';
  return hooks.inboxAskRepos ? hooks.inboxAskRepos(planId) : 'this Switchboard cannot ask the plan\'s agent';
}

/**
 * D108 seam (Insights, `src/server/insights/service.ts`): the plan items' outcomes; `null`
 * while Plans is off (no hooks registered) or its database is unavailable.
 */
export async function plansInsightOutcomes(store: object): Promise<PlanItemOutcome[] | null> {
  const hooks = registry.get(store);
  return hooks ? hooks.outcomes() : null;
}

/**
 * Team (D100) hook (docs/team-removal.md), D100 follow-up 2026-10-16 seam (Team's sidebar member rows, `src/server/team/service.ts`): the
 * plan items of the todos `todoIds` (their keys and titles); empty while Plans is off.
 */
export async function plansItemsOfTodos(store: object, todoIds: readonly string[]): Promise<PlanItemRef[]> {
  const hooks = registry.get(store);
  return hooks && todoIds.length > 0 ? hooks.itemsOfTodos(todoIds) : [];
}

/**
 * D134 seam (Insights → Usage breakdown, `src/server/insights/usage.ts`): the sessions that run
 * plan items; empty while Plans is unavailable.
 */
export async function plansRunSessionIds(store: object): Promise<string[]> {
  const hooks = registry.get(store);
  return hooks?.runSessionIds ? hooks.runSessionIds() : [];
}
