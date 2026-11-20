import { useSyncExternalStore } from 'react';
import { RECENT_COUNT_KEY, RECENT_KEY, RECENT_SHOWN, type RecentMark, parseRecent, readRecentCount, touchRecent } from './recent-model.ts';

export { RECENT_COUNT_MAX, RECENT_OPEN_KEY, RECENT_SHOWN, recentAgents, type RecentMark } from './recent-model.ts';

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

// ── D181 · how many agents Recent shows (per browser, like the marks) ──

let count: number | null = null;
const countListeners = new Set<() => void>();

function readCount(): number {
  if (count === null) {
    try {
      count = readRecentCount(window.localStorage.getItem(RECENT_COUNT_KEY));
    } catch {
      count = RECENT_SHOWN;
    }
  }
  return count;
}

/** Sets how many agents Recent shows in this browser (0–20; Settings › Appearance). */
export function setRecentCount(next: number): void {
  count = readRecentCount(String(Math.max(0, Math.round(next))));
  try {
    window.localStorage.setItem(RECENT_COUNT_KEY, String(count));
  } catch {
    // No storage: the number lasts until the page closes.
  }
  for (const listener of [...countListeners]) listener();
}

/** How many agents Recent shows in this browser, live (default 5). */
export function useRecentCount(): number {
  return useSyncExternalStore(
    (listener) => {
      countListeners.add(listener);
      return () => countListeners.delete(listener);
    },
    readCount,
    () => RECENT_SHOWN,
  );
}
