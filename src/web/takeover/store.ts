import { useSyncExternalStore } from 'react';
import type { TakeoverRequest } from './takeover.ts';

/**
 * D65: which take-over dialog is open. A small module store (not the modal
 * provider: Esc must not close a take-over that is running, and the session
 * header and the sidebar's row menu both open it).
 */
let current: TakeoverRequest | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Opens the take-over dialog for `request`. */
export function openTakeover(request: TakeoverRequest): void {
  current = request;
  notify();
}

/** Closes it. */
export function closeTakeover(): void {
  current = null;
  notify();
}

/** The open request, live. */
export function useTakeoverRequest(): TakeoverRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
