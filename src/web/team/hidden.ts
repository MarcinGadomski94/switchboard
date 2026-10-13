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
 *
 * T3: the same read also tells the nav and the sidebar's Team entry whether Team is
 * on ({@link useTeamSwitch}); nothing of Team shows while it is off.
 */

const EMPTY: ReadonlySet<string> = new Set();

/** What the page knows of the switch. */
export interface TeamSwitch {
  /** The switch is on and `team.db` is open (the Team page, its nav entry and the sidebar entry show). */
  readonly on: boolean;
  readonly hidden: ReadonlySet<string>;
  /** Role name per hidden session id. */
  readonly roles: Readonly<Record<string, string>>;
}

const OFF: TeamSwitch = { on: false, hidden: EMPTY, roles: {} };

let current: TeamSwitch = OFF;
let started = false;
const listeners = new Set<() => void>();

async function load(): Promise<void> {
  try {
    const response = await fetch('/api/team/state', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!response.ok) return set(OFF);
    const state = (await response.json()) as Partial<TeamState>;
    const available = state.available === true && state.enabled === true;
    set({
      on: available,
      hidden: available && Array.isArray(state.hiddenSessionIds) ? new Set(state.hiddenSessionIds) : EMPTY,
      roles: available && state.roles && typeof state.roles === 'object' ? state.roles : {},
    });
  } catch {
    // Unreachable: keep what was known (nothing hidden on a first failure).
  }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

function set(next: TeamSwitch): void {
  const rolesSame = JSON.stringify(next.roles) === JSON.stringify(current.roles);
  const hiddenSame = sameSet(next.hidden, current.hidden);
  if (next.on === current.on && hiddenSame && rolesSame) return;
  // Keep the hidden set's identity when only the switch or the roles changed (the sidebar re-renders only for the set).
  current = { on: next.on, hidden: hiddenSame ? current.hidden : next.hidden, roles: rolesSame ? current.roles : next.roles };
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

/** Reads the switch again now (after Settings changed it on this page). */
export function reloadTeamSwitch(): Promise<void> {
  return load();
}

/** The session ids the sidebar leaves out (team members' sessions while Team is on). */
export function useTeamHiddenSessions(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => current.hidden, () => EMPTY);
}

/** D100 follow-up 2026-10-14: `true` when `sessionId` is a member's session of any team (outside React). */
export function isTeamMemberSession(sessionId: string): boolean {
  return current.hidden.has(sessionId);
}

/** The switch as the page knows it (`on` = Team is on and available). */
export function useTeamSwitch(): TeamSwitch {
  return useSyncExternalStore(subscribe, () => current, () => OFF);
}

/** `sessions` without the hidden ones (the same array when nothing is hidden, so nothing re-renders). */
export function withoutTeamMembers<T extends { readonly id: string }>(sessions: readonly T[], hiddenIds: ReadonlySet<string>): readonly T[] {
  if (hiddenIds.size === 0) return sessions;
  return sessions.filter((session) => !hiddenIds.has(session.id));
}
