import type { SessionListItem } from '../../../core/api.ts';
import { crewOfPin, crewPinId } from '../../../core/crew-pins.ts';
import type { SidebarPlaceInput } from '../../../core/sidebar-layout.ts';
import type { TeamSummary } from '../../../core/team.ts';
import { visibleTeam } from '../../team/model.ts';
import { type V2Status, teammateStatusToV2 } from '../glossary.ts';

/**
 * Fix after 2.0 (2.4.4) · the rail's Pinned list with pinned crews (`docs/v2.md` → *Shell*,
 * `docs/sidebar.md` → *Pinned crews*). DOM-free, unit-tested in `tests/web/v2-pinned.test.ts`.
 *
 * A crew is pinned through the shared sidebar layout (D54 / D71): its pin id
 * (`crew~<team id>`, `core/crew-pins.ts`) sits in `pinned` next to the pinned agents, so the
 * order is the layout's (a new pin goes to the end: pin time) and it syncs to the paired
 * computers the layout is shared with, like a pinned agent.
 */

/** One teammate row under an expanded pinned crew. */
export interface PinnedMate {
  readonly id: string;
  /** How this computer addresses its agent (a paired computer's: `r~<machine>~<id>`). */
  readonly sessionRef: string;
  readonly name: string;
  readonly status: V2Status;
  /** Its Needs-you items (the badge; 0 = none). */
  readonly needs: number;
}

/** A pinned crew as the rail shows it. */
export interface PinnedCrew {
  readonly teamId: string;
  readonly name: string;
  readonly working: number;
  readonly needs: number;
  /** Its teammates in the crew's order, archived ones left out (D137 follow-up, option B). */
  readonly mates: readonly PinnedMate[];
  /** How many archived teammates are hidden ("1 archived"). */
  readonly archived: number;
}

/** One row of the Pinned list, in the layout's order. */
export type PinnedEntry = { readonly kind: 'agent'; readonly id: string; readonly session: SessionListItem } | { readonly kind: 'crew'; readonly id: string; readonly crew: PinnedCrew };

/** The Needs-you items per agent (`agent.sessionId`; a crew's own items carry the teammate's session too). */
export function needsByAgent(items: readonly { readonly agent: { readonly sessionId: string | null } | null }[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const id = item.agent?.sessionId;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** A crew as the rail shows it: its shown teammates with their status and Needs-you count, and its counts. */
export function pinnedCrewOf(crew: TeamSummary, needs: ReadonlyMap<string, number>): PinnedCrew {
  const shown = visibleTeam(crew);
  // The roster's status already reads needs-you while its Needs-you items are open (offline / paused win).
  const mates = (shown.roster ?? []).map((entry): PinnedMate => ({ id: entry.id, sessionRef: entry.sessionRef, name: entry.name, status: teammateStatusToV2(entry.status), needs: needs.get(entry.sessionRef) ?? 0 }));
  return { teamId: crew.id, name: crew.name, working: mates.filter((mate) => mate.status === 'working').length, needs: crew.needsYou, mates, archived: shown.archived };
}

/**
 * The Pinned list: the layout's `pinned` ids in order, each an open agent or a crew this
 * computer knows. A closed agent, an unknown id and a deleted (or not yet synced) crew
 * are left out, as before.
 */
export function pinnedEntries(pinned: readonly string[], sessions: readonly SessionListItem[], crews: readonly TeamSummary[], needs: ReadonlyMap<string, number>): PinnedEntry[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const crewById = new Map(crews.map((crew) => [crew.id, crew]));
  const entries: PinnedEntry[] = [];
  for (const id of pinned) {
    const teamId = crewOfPin(id);
    if (teamId !== null) {
      const crew = crewById.get(teamId);
      if (crew) entries.push({ kind: 'crew', id, crew: pinnedCrewOf(crew, needs) });
      continue;
    }
    const session = byId.get(id);
    if (session && !session.closedAt) entries.push({ kind: 'agent', id, session });
  }
  return entries;
}

/** `true` while the crew is pinned in the layout. */
export function isCrewPinned(pinned: readonly string[], teamId: string): boolean {
  return pinned.includes(crewPinId(teamId));
}

/**
 * What Pin to sidebar / Unpin sends (`POST /api/sidebar/place`): pinned at the end (pin
 * time) or at `index` (Undo of an Unpin puts it back where it was), or out of the layout
 * (unplaced). The layout sync (D71) carries it from there.
 */
export function crewPinInput(teamId: string, pin: boolean, index?: number): SidebarPlaceInput {
  if (!pin) return { sessionId: crewPinId(teamId), place: 'loose' };
  return index === undefined || index < 0 ? { sessionId: crewPinId(teamId), place: 'pinned' } : { sessionId: crewPinId(teamId), place: 'pinned', index };
}

/** The crew row's short status: "2 working", "" when nothing works (the needs count is its badge). */
export function pinnedCrewLine(crew: Pick<PinnedCrew, 'working'>): string {
  return crew.working > 0 ? `${crew.working} working` : '';
}

/** The crew row's accessible name: "Acme Mobile, crew, 2 working, 1 needs you". */
export function pinnedCrewLabel(crew: Pick<PinnedCrew, 'name' | 'working' | 'needs'>): string {
  const parts = [crew.name, 'crew'];
  if (crew.working > 0) parts.push(`${crew.working} working`);
  if (crew.needs > 0) parts.push(`${crew.needs} need${crew.needs === 1 ? 's' : ''} you`);
  return parts.join(', ');
}

// ── which pinned crews are expanded (per browser) ───────────────────────

/** Where this browser remembers the expanded pinned crews (collapsed by default). */
export const OPEN_CREWS_KEY = 'switchboard.v2.rail.openCrews';

/** The stored expanded crews (team ids); anything unreadable is none. */
export function readOpenCrews(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, 100) : [];
  } catch {
    return [];
  }
}

/** The expanded crews after opening (`open: true`) or closing one. */
export function setCrewOpen(open: readonly string[], teamId: string, value: boolean): string[] {
  const rest = open.filter((id) => id !== teamId);
  return value ? [...rest, teamId] : rest;
}
