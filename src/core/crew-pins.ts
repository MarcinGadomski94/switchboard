/**
 * Fix after 2.0 (2.4.4) · a pinned crew in the shared sidebar layout (D54 / D71).
 *
 * A crew is pinned by putting `crew~<team id>` into the layout's `pinned` list, next to
 * the pinned agents' session ids, so it is stored, ordered and synced exactly like a
 * pinned agent (no migration; `docs/sidebar.md` → *Pinned crews*). A team's id is the
 * same on every paired machine (D100's team sync), so the id travels as it is: its D71
 * wire key is the id itself, never `<machine>:<id>` ({@link crewPinKey}). Every view that
 * looks pinned ids up as sessions simply finds no session for it (hidden, like an
 * unknown id); the v2 rail shows it as the crew.
 */

/** The prefix of a crew pin id. */
export const CREW_PIN_PREFIX = 'crew~';

/** A team id as a crew pin may carry it (`team`, a UUID, …): letters, digits, `-` and `_`. */
const TEAM_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** The pin id of a crew (team) id. */
export function crewPinId(teamId: string): string {
  return `${CREW_PIN_PREFIX}${teamId}`;
}

/** The crew (team) id of a crew pin id, `null` for anything else (a session id, a remote id, a malformed one). */
export function crewOfPin(id: unknown): string | null {
  if (typeof id !== 'string' || !id.startsWith(CREW_PIN_PREFIX)) return null;
  const teamId = id.slice(CREW_PIN_PREFIX.length);
  return TEAM_ID.test(teamId) ? teamId : null;
}

/** `true` for a well-formed crew pin id. */
export function isCrewPinId(id: unknown): boolean {
  return crewOfPin(id) !== null;
}

