import type { TeamCurrentItem, TeamMemberStatus, TeamRosterEntry } from '../../core/team.ts';

/**
 * D100 follow-up 2026-10-16 · the sidebar's member rows under each team (`docs/team.md` →
 * *Sidebar*): the status glyph, the short right-aligned status line and the folded team's
 * summary. Pure, so it is unit-tested (`tests/web/team-sidebar.test.ts`).
 */

/** A member row's status glyph (working = the session rows' running dot). */
export const ROSTER_GLYPH: Readonly<Record<TeamMemberStatus, string>> = {
  working: '●',
  'needs-you': '?',
  idle: '○',
  paused: '⏸',
  offline: '⌁',
};

/** The status words of the tooltip and the folded summary. */
const STATUS_WORDS: Readonly<Record<TeamMemberStatus, string>> = {
  working: 'working',
  'needs-you': 'needs you',
  idle: 'idle',
  paused: 'paused',
  offline: 'offline',
};

/** A current item's title is shortened to this many characters (an ellipsis ends it). */
export const ITEM_TITLE_MAX = 16;

/** Milliseconds since `iso` (never negative); `null` for a missing or unreadable time. */
function since(iso: string | null, now: number): number | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}

/** A coarse duration, minute-grained: `0m`, `40m`, `2h`, `3d`. */
export function shortDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** A current item as the row names it: its key (`PROJ-14`), else its title shortened. */
export function itemLabel(item: TeamCurrentItem): string {
  if (item.key) return item.key;
  const title = item.title.trim();
  return title.length > ITEM_TITLE_MAX ? `${title.slice(0, ITEM_TITLE_MAX - 1).trimEnd()}…` : title;
}

/**
 * The row's status line: working → `PROJ-14 · 40m` (the current item and the time since
 * the turn started), `working · 12m` without a known item; needs you → `needs you`; idle →
 * `idle · 2h` (since the last activity); paused → `paused`; offline → `offline`.
 */
export function rosterLine(entry: Pick<TeamRosterEntry, 'status' | 'current' | 'turnStartedAt' | 'lastActivityAt'>, now: number): string {
  switch (entry.status) {
    case 'working': {
      const head = entry.current ? itemLabel(entry.current) : 'working';
      const ms = since(entry.turnStartedAt, now);
      return ms === null ? head : `${head} · ${shortDuration(ms)}`;
    }
    case 'idle': {
      const ms = since(entry.lastActivityAt, now);
      return ms === null ? 'idle' : `idle · ${shortDuration(ms)}`;
    }
    default:
      return STATUS_WORDS[entry.status];
  }
}

/** The row's tooltip: the full role name, the status and (working) the full item; offline names the other PC. */
export function rosterTitle(entry: Pick<TeamRosterEntry, 'name' | 'status' | 'current' | 'machineName'>): string {
  if (entry.status === 'offline') return `${entry.name} · offline: runs on ${entry.machineName}, which is not reachable`;
  if (entry.status === 'working' && entry.current) return `${entry.name} · working on ${entry.current.key ? `${entry.current.key} ${entry.current.title}` : entry.current.title}`;
  return `${entry.name} · ${STATUS_WORDS[entry.status]}`;
}

/**
 * A folded team's summary after its name: `2 working · 1 idle` (working, idle, paused,
 * offline; the members that need you are the row's own count); `''` when there is nothing to say.
 */
export function collapsedSummary(roster: readonly Pick<TeamRosterEntry, 'status'>[]): string {
  const order: readonly TeamMemberStatus[] = ['working', 'idle', 'paused', 'offline'];
  return order
    .map((status) => ({ status, count: roster.filter((entry) => entry.status === status).length }))
    .filter((part) => part.count > 0)
    .map((part) => `${part.count} ${STATUS_WORDS[part.status]}`)
    .join(' · ');
}

/** `true` when a shown row carries a duration (the rows then re-render once a minute). */
export function hasDuration(roster: readonly Pick<TeamRosterEntry, 'status' | 'turnStartedAt' | 'lastActivityAt'>[]): boolean {
  return roster.some((entry) => (entry.status === 'working' && entry.turnStartedAt !== null) || (entry.status === 'idle' && entry.lastActivityAt !== null));
}
