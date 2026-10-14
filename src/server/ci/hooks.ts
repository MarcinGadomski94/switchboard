/**
 * D109 · seams other features plug into the PR watcher (`docs/ci.md`). Keyed by the main
 * `Store` object (one app, one store), like Plans' and Team's hooks; the CI code never
 * imports an experimental feature: the feature registers itself here.
 */

/** Answers whether a session's PR is merged through another feature's own Merge step (Plans, D99 / D102). */
export type CiMergeOwner = (sessionId: string) => Promise<boolean>;

const owners = new WeakMap<object, CiMergeOwner>();

/**
 * Registers the feature that merges some sessions' PRs itself (Plans: its items' runs keep
 * their own Merge step and "Ready to merge" Inbox item, so the watcher raises no second one).
 * Answers the unregister function.
 */
export function registerCiMergeOwner(store: object, owner: CiMergeOwner): () => void {
  owners.set(store, owner);
  return () => {
    if (owners.get(store) === owner) owners.delete(store);
  };
}

/** `true` when a registered feature merges this session's PR itself (no "ready to merge" item from the watcher). */
export async function ciMergeOwnedElsewhere(store: object, sessionId: string): Promise<boolean> {
  const owner = owners.get(store);
  if (!owner) return false;
  try {
    return await owner(sessionId);
  } catch {
    return false;
  }
}
