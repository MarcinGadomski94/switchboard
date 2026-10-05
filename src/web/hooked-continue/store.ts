import { useSyncExternalStore } from 'react';

/** D72: what the Continue-in-Switchboard dialog is opened for. */
export interface ContinueHookedRequest {
  /** The session's id as this machine knows it (a remote id for a peer's session). */
  readonly sessionId: string;
  readonly title: string;
  /** The machine the terminal runs on, `null` for this machine. */
  readonly machineName: string | null;
}

/**
 * D72: which Continue-in-Switchboard dialog is open. A small module store (as the
 * D65 take-over's): the session header, the sidebar row menu and History open it.
 */
let current: ContinueHookedRequest | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Opens the dialog for `request` (it starts the continue at once). */
export function openContinueHooked(request: ContinueHookedRequest): void {
  current = request;
  notify();
}

/** Closes it. */
export function closeContinueHooked(): void {
  current = null;
  notify();
}

/** The open request, live. */
export function useContinueHookedRequest(): ContinueHookedRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
