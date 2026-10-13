import { useEffect, useSyncExternalStore } from 'react';
import type { TeamNeedsYouItem, TeamView } from '../../core/team.ts';
import { onHubEvent, onHubStatus } from '../api/useHub.ts';
import { teamApi } from './api.ts';
import { useTeamSwitch } from './hidden.ts';

/**
 * D100 · the team as the page shows it: `GET /api/team` (members, hand-offs,
 * activity) and `GET /api/team/needs-you`, shared by the Team page and the sidebar's
 * Team entry. Read only while Team is on and something shows it; read again on
 * `teamChanged`, on `inboxChanged` (Needs you derives the members' Inbox items), on
 * a member session's `sessionUpdated` (its status; at most once a second) and when
 * the hub reconnects.
 */

/** The shared data. */
export interface TeamData {
  readonly view: TeamView | null;
  readonly needsYou: readonly TeamNeedsYouItem[];
  /** The last read failed (the Team page shows it); `null` after a success. */
  readonly error: string | null;
  readonly loaded: boolean;
}

const EMPTY: TeamData = { view: null, needsYou: [], error: null, loaded: false };

/** Session events reload the team at most this often. */
const SESSION_RELOAD_MS = 1_000;

let data: TeamData = EMPTY;
let users = 0;
let wired = false;
let inFlight: Promise<void> | null = null;
let again = false;
let sessionTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function publish(next: TeamData): void {
  data = next;
  for (const listener of [...listeners]) listener();
}

/** Reads the team again (coalesced: a read asked for while one runs runs once after it). */
export function reloadTeam(): Promise<void> {
  if (users === 0) return Promise.resolve();
  if (inFlight) {
    again = true;
    return inFlight;
  }
  inFlight = (async () => {
    try {
      const [view, needsYou] = await Promise.all([teamApi.view(), teamApi.needsYou()]);
      publish({ view, needsYou, error: null, loaded: true });
    } catch (error) {
      const status = (error as { status?: number }).status;
      // 404 team-off: Team was switched off meanwhile; nothing to show.
      publish(status === 404 ? EMPTY : { ...data, error: error instanceof Error ? error.message : String(error), loaded: true });
    } finally {
      inFlight = null;
      if (again) {
        again = false;
        void reloadTeam();
      }
    }
  })();
  return inFlight;
}

function wire(): void {
  if (wired) return;
  wired = true;
  onHubEvent('teamChanged', () => void reloadTeam());
  onHubEvent('inboxChanged', () => void reloadTeam());
  onHubEvent('sessionUpdated', (session) => {
    if (!data.view?.members.some((member) => member.sessionRef === session.id)) return;
    if (sessionTimer) return;
    sessionTimer = setTimeout(() => {
      sessionTimer = null;
      void reloadTeam();
    }, SESSION_RELOAD_MS);
  });
  onHubStatus((status) => {
    if (status === 'open') void reloadTeam();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The team while Team is on (`EMPTY` while it is off). Reads it when the first user mounts. */
export function useTeamData(): TeamData {
  const { on } = useTeamSwitch();
  useEffect(() => {
    if (!on) return undefined;
    wire();
    users += 1;
    void reloadTeam();
    return () => {
      users -= 1;
      if (users === 0) publish(EMPTY);
    };
  }, [on]);
  const value = useSyncExternalStore(subscribe, () => data, () => EMPTY);
  return on ? value : EMPTY;
}
