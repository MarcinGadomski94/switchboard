/**
 * D99 · the seams Plans plugs into the rest of Switchboard (`docs/plans-removal.md` lists
 * every call site). Each is a no-op until a {@link PlanService} registers itself for the store
 * (`registerPlanHooks`). Keyed by the main `Store` object (one app, one store), like Team's.
 */
export interface PlanHooks {
  /** Settings → Experimental → Plans was switched (`PUT /api/settings`). */
  switchChanged(): Promise<void>;
  /** D83: session `from` was continued in the fresh session `to` (its todos, ids kept, moved there). */
  sessionContinued(from: string, to: string): Promise<void>;
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

/** Settings seam: the Plans switch changed. */
export async function plansSwitchChanged(store: object): Promise<void> {
  await registry.get(store)?.switchChanged();
}
