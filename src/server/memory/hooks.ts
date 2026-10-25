/**
 * D107 · the seams Project memory plugs into the rest of Switchboard (`docs/memory-removal.md`
 * lists every call site). Each is a no-op until a `MemoryService` registers itself for the main
 * `Store` (`registerMemoryHooks`), and answers "nothing" while Project memory is off or
 * `memory.db` is unavailable, so the rest of Switchboard behaves exactly as without it.
 */
export interface MemoryHooks {
  /**
   * The approved-memory block for a session's folder (`null`: none, a chat, or no folder).
   * Built from **approved** entries only (`docs/memory.md` → *The review gate*).
   */
  blockFor(session: MemorySessionRef): Promise<string | null>;
  /** D107 follow-up 2026-10-15: a Team member moved to another machine (D65 / D110): its member-scoped entries go with it. */
  memberMoved?(move: MemoryMemberMove): Promise<void>;
  /** D107 follow-up 2026-10-16: a paired machine's Project memory changed (e.g. switched on there): retry its pending copies. */
  peerMemoryChanged?(machineId: string): void;
  /** D107 follow-up 2026-10-16: Retry / Keep on this PC of a "<member> is missing its memory on <PC>" item; the refusal's text, or `null`. */
  copyAction?(payload: unknown, action: string): Promise<string | null>;
}

/** D107 follow-up 2026-10-16: the Inbox item of a member's memory that could not be copied after a move, and its actions. */
export const MEMORY_COPY_ITEM = 'memory-copy';
export const MEMORY_COPY_RETRY = 'memory-copy-retry';
export const MEMORY_COPY_KEEP = 'memory-copy-keep';

/** A Team member's move, as Project memory needs it. */
export interface MemoryMemberMove {
  readonly memberId: string;
  /** The machine it runs on now. */
  readonly machineId: string;
  /** Its session there (that machine's id). */
  readonly sessionId: string;
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
 * block appended (unchanged for a chat, or without approved entries). Never throws:
 * a broken `memory.db` gives the session its instruction without memory.
 */
export async function withProjectMemory(store: object, session: MemorySessionRef, base: string | null): Promise<string | null> {
  const block = await registry.get(store)?.blockFor(session).catch(() => null);
  if (!block) return base;
  return base ? `${base}\n\n${block}` : block;
}

/**
 * Team seam (D100 move, D107 follow-up 2026-10-15): the member's member-scoped entries move with it
 * to the machine it now runs on. Never throws: a failed copy leaves them here (`docs/memory.md` → *Scopes*).
 */
export async function memoryMemberMoved(store: object, move: MemoryMemberMove): Promise<void> {
  await registry.get(store)?.memberMoved?.(move).catch(() => undefined);
}

/** Peers seam (D107 follow-up 2026-10-16): a paired machine's `memoryChanged` arrived (its switch, its entries). */
export function memoryPeerChanged(store: object, machineId: string): void {
  try {
    registry.get(store)?.peerMemoryChanged?.(machineId);
  } catch {
    // Never breaks the peer stream.
  }
}

/**
 * Inbox seam (D107 follow-up 2026-10-16): Retry / Keep on this PC of a `memory-copy` item.
 * Answers the refusal's text (the item stays open), or `null` when done.
 */
export async function memoryInboxAction(store: object, payload: unknown, action: string): Promise<string | null> {
  const hooks = registry.get(store);
  if (!hooks?.copyAction) return 'Project memory is not available (it has not started)';
  return hooks.copyAction(payload, action);
}

