import { useSyncExternalStore } from 'react';
import type { TeamSummary } from '../../../core/team.ts';
import { onHubEvent, onHubStatus } from '../../api/useHub.ts';
import { teamApi } from '../../team/api.ts';
import { NO_TEAM_MEMBERS, type TeamMembers, teamMembersOf } from './teammate-name.ts';

export { NO_TEAM_MEMBERS, agentDisplayName, displayNameById, sessionOwnName, teamMembersOf, teammateOf, type TeamMemberRef, type TeamMembers } from './teammate-name.ts';

/**
 * Fix after 2.0 · one live copy of the crews (`GET /api/team/teams`, read again on
 * `teamChanged` and when the hub reconnects), shared by every v2 view that names
 * an agent or leaves teammates out (Agents, the rail, the agent view). A failed
 * read (Team off) keeps what was known: no crews at first.
 */

interface Snapshot {
  readonly teams: readonly TeamSummary[];
  readonly members: TeamMembers;
  readonly loaded: boolean;
}

const EMPTY: Snapshot = { teams: [], members: NO_TEAM_MEMBERS, loaded: false };

let current: Snapshot = EMPTY;
let started = false;
let inFlight = false;
let again = false;
const listeners = new Set<() => void>();

async function load(): Promise<void> {
  if (inFlight) {
    again = true;
    return;
  }
  inFlight = true;
  try {
    const teams = await teamApi.teams();
    current = { teams, members: teamMembersOf(teams), loaded: true };
  } catch {
    if (!current.loaded) current = { ...current, loaded: true };
  } finally {
    inFlight = false;
  }
  for (const listener of [...listeners]) listener();
  if (again) {
    again = false;
    void load();
  }
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

/** Reads the crews again now (after this page changed one, before the hub says so). */
export function reloadTeammates(): Promise<void> {
  return load();
}

/** Every crew with its roster, live. */
export function useCrewsList(): readonly TeamSummary[] {
  return useSyncExternalStore(subscribe, () => current.teams, () => EMPTY.teams);
}

/** Every crew's teammates by session id, live (for {@link agentDisplayName}). */
export function useTeamMembers(): TeamMembers {
  return useSyncExternalStore(subscribe, () => current.members, () => NO_TEAM_MEMBERS);
}
