import { useSyncExternalStore } from 'react';
import { RECENT_KEY, type RecentMark, parseRecent, touchRecent } from './recent-model.ts';

export { RECENT_OPEN_KEY, RECENT_SHOWN, recentAgents, type RecentMark } from './recent-model.ts';

/**
 * Fix after 2.0 · this browser's Recent marks, live (`recent-model.ts`): the agent
 * view and the peek mark an agent when they open it, the composer when it sends,
 * an answer card in an agent's chat when it answers. Other tabs follow through the
 * `storage` event.
 */

const EMPTY: readonly RecentMark[] = [];
let current: readonly RecentMark[] | null = null;
const listeners = new Set<() => void>();
let wired = false;

function read(): readonly RecentMark[] {
  try {
    return parseRecent(window.localStorage.getItem(RECENT_KEY));
  } catch {
    return EMPTY;
  }
}

function snapshot(): readonly RecentMark[] {
  if (current === null) current = read();
  return current;
}

function publish(next: readonly RecentMark[]): void {
  current = next;
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // No storage: Recent lasts until the page closes.
  }
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  if (!wired && typeof window !== 'undefined') {
    wired = true;
    window.addEventListener('storage', (event) => {
      if (event.key !== RECENT_KEY) return;
      current = read();
      for (const each of [...listeners]) each();
    });
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Marks `sessionId` as interacted with now (opened, sent to, answered). */
export function markRecent(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  const marks = snapshot();
  if (marks[0]?.id === sessionId && Date.now() - marks[0].at < 1_000) return;
  publish(touchRecent(marks, sessionId, Date.now()));
}

/** Clears Recent (the section's ⋯ › Clear recent). */
export function clearRecent(): void {
  publish([]);
}

/** The marks, newest first, live. */
export function useRecentMarks(): readonly RecentMark[] {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}
