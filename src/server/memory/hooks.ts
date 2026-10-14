/**
 * D107 · the seams Project memory plugs into the rest of Switchboard (`docs/memory-removal.md`
 * lists every call site). Each is a no-op until a `MemoryService` registers itself for the main
 * `Store` (`registerMemoryHooks`), and answers "nothing" while Project memory is off or
 * `memory.db` is unavailable, so the rest of Switchboard behaves exactly as without it.
 */
export interface MemoryHooks {
  /**
   * The approved-memory block for a session's folder (`null`: none, off, a chat, or no folder).
   * Built from **approved** entries only (`docs/memory.md` → *The review gate*).
   */
  blockFor(session: MemorySessionRef): Promise<string | null>;
  /** Settings → Experimental → Project memory was switched (`PUT /api/settings`). */
  switchChanged(): Promise<void>;
}

/** What the block needs of a session (a `SessionRecord` has all of it). */
export interface MemorySessionRef {
  readonly id: string;
  readonly kind?: string;
  readonly root?: string | null;
  readonly cwd?: string | null;
}

const registry = new WeakMap<object, MemoryHooks>();

/** Registers Project memory's hooks for `store`; returns the unregister function. */
export function registerMemoryHooks(store: object, hooks: MemoryHooks): () => void {
  registry.set(store, hooks);
  return () => {
    if (registry.get(store) === hooks) registry.delete(store);
  };
}

/**
 * D64 seam (`sessions/instruction.ts`): the instruction `base` with the folder's approved memory
 * block appended (unchanged while off, for a chat, or without approved entries). Never throws:
 * a broken `memory.db` gives the session its instruction without memory.
 */
export async function withProjectMemory(store: object, session: MemorySessionRef, base: string | null): Promise<string | null> {
  const block = await registry.get(store)?.blockFor(session).catch(() => null);
  if (!block) return base;
  return base ? `${base}\n\n${block}` : block;
}

/** Settings seam: the Project memory switch changed. */
export async function memorySwitchChanged(store: object): Promise<void> {
  await registry.get(store)?.switchChanged();
}
