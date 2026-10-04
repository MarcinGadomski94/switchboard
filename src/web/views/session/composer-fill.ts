/**
 * D69 · ▶ Start (`docs/todos.md` → *Start*): a text waiting to go into a
 * session's composer. The todo strip and the Todos page ask for it (the page
 * then opens the session); the session's composer takes it when it is there or
 * as soon as it mounts. It is never sent by itself.
 */
const pending = new Map<string, string>();
const listeners = new Set<(sessionId: string) => void>();

/** Asks `sessionId`'s composer to take `text` (the composer keeps a draft it already has). */
export function requestComposerFill(sessionId: string, text: string): void {
  pending.set(sessionId, text);
  for (const listener of listeners) listener(sessionId);
}

/** The text waiting for `sessionId`'s composer, removed once taken; `null` when none waits. */
export function takeComposerFill(sessionId: string): string | null {
  const text = pending.get(sessionId);
  if (text === undefined) return null;
  pending.delete(sessionId);
  return text;
}

/** Calls `listener` with the session id of every later request; answers the unsubscribe. */
export function onComposerFill(listener: (sessionId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
