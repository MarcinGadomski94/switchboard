import { useSyncExternalStore } from 'react';
import type { TeamState } from '../../core/team.ts';
import { onHubEvent, onHubStatus } from '../api/useHub.ts';

/**
 * D100 · the sidebar's one Team filter (`docs/team.md` → *Leaving the sidebar*): a
 * team member's session is listed on the Team page, not in SESSIONS. The page reads
 * `GET /api/team/state` (the switch and the hidden ids; answered also while Team is
 * off, then with nothing hidden) once, again on `teamChanged` and after the hub
 * reconnects. Hiding is only this filter: the session, its sidebar place (D54 / D71)
 * and everything else stay as they are, so switching Team off (or a broken
 * `team.db`, which the server reports as nothing hidden) shows every session again
 * in its place. Search, the Inbox and notifications still find member sessions.
 */

const EMPTY: ReadonlySet<string> = new Set();

let hidden: ReadonlySet<string> = EMPTY;
let started = false;
const listeners = new Set<() => void>();

async function load(): Promise<void> {
  try {
    const response = await fetch('/api/team/state', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!response.ok) return set(EMPTY);
    const state = (await response.json()) as Partial<TeamState>;
    set(state.available === true && Array.isArray(state.hiddenSessionIds) ? new Set(state.hiddenSessionIds) : EMPTY);
  } catch {
    // Unreachable: keep what was known (nothing hidden on a first failure).
  }
}

function set(next: ReadonlySet<string>): void {
  const same = next.size === hidden.size && [...next].every((id) => hidden.has(id));
  if (same) return;
  hidden = next;
  for (const listener of [...listeners]) listener();
}

function start(): void {
  if (started) return;
  started = true;
  void load();
  onHubEvent('teamChanged', () => void load());
  onHubStatus((status) => {
    if (status === 'open') void load();
  });
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The session ids the sidebar leaves out (team members' sessions while Team is on). */
export function useTeamHiddenSessions(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => hidden, () => EMPTY);
}

/** `sessions` without the hidden ones (the same array when nothing is hidden, so nothing re-renders). */
export function withoutTeamMembers<T extends { readonly id: string }>(sessions: readonly T[], hiddenIds: ReadonlySet<string>): readonly T[] {
  if (hiddenIds.size === 0) return sessions;
  return sessions.filter((session) => !hiddenIds.has(session.id));
}
