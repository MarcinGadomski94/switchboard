import { useEffect, useSyncExternalStore } from 'react';

/**
 * A one-shot request to select a solution in the Solutions view, made by the
 * ⌘K palette's "solution" results (M8.3, prototype `go('solutions', { solSel })`).
 * The Solutions view keeps its selection in local state and has no URL for it,
 * so the palette records the solution's `path` here before it navigates; the view
 * reads it when it mounts (or right away when it is already open) and clears it.
 */
export interface SolutionFocus {
  readonly path: string;
  /** Increases with every request, so asking for the same solution twice selects it again. */
  readonly seq: number;
}

let current: SolutionFocus | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): SolutionFocus | null {
  return current;
}

/** Asks the Solutions view to select the solution at `path`. */
export function requestSolutionFocus(path: string): void {
  seq += 1;
  current = { path, seq };
  emit();
}

/** The pending request, without clearing it (safe to call while rendering). */
export function peekSolutionFocus(): SolutionFocus | null {
  return current;
}

/** Clears the request `seq` (a newer one stays). */
export function clearSolutionFocus(done: number): void {
  if (current?.seq !== done) return;
  current = null;
  emit();
}

/**
 * Calls `select(path)` for each palette request, including one made just before
 * the calling view mounted, and clears it once handled.
 */
export function useSolutionFocus(select: (path: string) => void): void {
  const focus = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (!focus) return;
    select(focus.path);
    clearSolutionFocus(focus.seq);
    // `select` is a state setter; only a new request should run this.
  }, [focus]);
}
