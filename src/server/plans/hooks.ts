/**
 * D99 · the seams Plans plugs into the rest of Switchboard (`docs/plans-removal.md` lists
 * every call site). Each is a no-op until a {@link PlanService} registers itself for the store
 * (`registerPlanHooks`). Keyed by the main `Store` object (one app, one store), like Team's.
 */
export interface PlanHooks {
  /** Settings → Experimental → Plans was switched (`PUT /api/settings`). */
  switchChanged(): Promise<void>;
}

const registry = new WeakMap<object, PlanHooks>();

/** Registers Plans' hooks for `store`; returns the unregister function. */
export function registerPlanHooks(store: object, hooks: PlanHooks): () => void {
  registry.set(store, hooks);
  return () => {
    if (registry.get(store) === hooks) registry.delete(store);
  };
}

/** Settings seam: the Plans switch changed. */
export async function plansSwitchChanged(store: object): Promise<void> {
  await registry.get(store)?.switchChanged();
}
