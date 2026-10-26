import type { SessionListItem } from '../../../core/api.ts';

/**
 * Fix after 2.0 · "Recent" under the rail's Pinned (pure; unit-tested in
 * `tests/web/v2-recent.test.ts`): the agents and conversations the developer last
 * interacted with in this browser (opened their view, sent a message, answered
 * from their chat), newest first. The service keeps no per-session time of the
 * developer's own activity (`lastActivityAt` moves with the agent too), so the
 * marks are per browser, in `localStorage`.
 */

/** One mark: the session and when the developer last interacted with it (ms). */
export interface RecentMark {
  readonly id: string;
  readonly at: number;
}

/** Where the marks live (per browser). */
export const RECENT_KEY = 'switchboard.v2.recent';
/** Whether the rail's Recent section is open (per browser; open by default). */
export const RECENT_OPEN_KEY = 'switchboard.v2.recentOpen';
/** How many agents Recent shows. */
export const RECENT_SHOWN = 5;
/** How many marks are kept (more than shown, so a pin or a close does not empty the list). */
export const RECENT_KEPT = 30;

/** `marks` with `id` marked at `at`: moved to the front, no duplicate, at most {@link RECENT_KEPT}. */
export function touchRecent(marks: readonly RecentMark[], id: string, at: number): RecentMark[] {
  return [{ id, at }, ...marks.filter((mark) => mark.id !== id)].slice(0, RECENT_KEPT);
}

/** The stored marks, read safely (anything malformed is dropped), newest first. */
export function parseRecent(raw: string | null): RecentMark[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const out: RecentMark[] = [];
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const { id, at } = item as { id?: unknown; at?: unknown };
      if (typeof id !== 'string' || typeof at !== 'number' || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, at });
    }
    return out.sort((a, b) => b.at - a.at).slice(0, RECENT_KEPT);
  } catch {
    return [];
  }
}

/**
 * The Recent list: the open sessions among `marks`, newest first, without the
 * pinned ones (Pinned shows them), at most `cap`. A closed or deleted agent (not
 * in `sessions`, or with `closedAt`) drops out.
 */
export function recentAgents<T extends Pick<SessionListItem, 'id' | 'closedAt'>>(marks: readonly RecentMark[], sessions: readonly T[], pinned: readonly string[], cap = RECENT_SHOWN): T[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const pins = new Set(pinned);
  const out: T[] = [];
  const seen = new Set<string>();
  for (const mark of [...marks].sort((a, b) => b.at - a.at)) {
    if (out.length >= cap) break;
    if (seen.has(mark.id) || pins.has(mark.id)) continue;
    seen.add(mark.id);
    const session = byId.get(mark.id);
    if (session && !session.closedAt) out.push(session);
  }
  return out;
}
