import { DEFAULT_TEAM_ID, DEFAULT_TEAM_NAME, type TeamCurrentItem, type TeamMemberStatus, type TeamRosterEntry, type TeamSummary, type TeamWaitKind } from '../../core/team.ts';
import { formatClockTime } from '../activity/activity.ts';

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

/** 2026-10-16: the glyph of a member that works only through its subagents (its main turn is over): half a dot, in the running colour. */
export const SUBAGENTS_GLYPH = '◐';

/**
 * A row's glyph: {@link ROSTER_GLYPH}, or {@link SUBAGENTS_GLYPH} while it waits on
 * subagents or (2026-10-16) on background work: working, but not in a turn.
 */
export function rosterGlyph(entry: Pick<TeamRosterEntry, 'status' | 'subagents' | 'waitingOn'>): string {
  return entry.status === 'working' && ((entry.subagents ?? 0) > 0 || (entry.waitingOn ?? null) !== null) ? SUBAGENTS_GLYPH : ROSTER_GLYPH[entry.status];
}

/** 2026-10-16: the row's words for a background wait: `⏳ GitHub Actions`, `⏳ background task`, `⏰ waking up at 18:40`. */
export function waitLabel(kind: TeamWaitKind, wakeAt: string | null | undefined): string {
  if (kind === 'github') return '⏳ GitHub Actions';
  if (kind === 'background') return '⏳ background task';
  const at = wakeAt ? formatClockTime(wakeAt) : '';
  return at ? `⏰ waking up at ${at}` : '⏰ waking up';
}

/** 2026-10-16: the tooltip's words for a background wait: `waiting on GitHub Actions`, `waiting on a background task`, `waking up at 18:40`. */
function waitTitle(kind: TeamWaitKind, wakeAt: string | null | undefined): string {
  if (kind === 'github') return 'waiting on GitHub Actions';
  if (kind === 'background') return 'waiting on a background task';
  const at = wakeAt ? formatClockTime(wakeAt) : '';
  return at ? `waking up at ${at}` : 'waking up';
}

/** `1 subagent`, `3 subagents`. */
export function subagentsLabel(count: number): string {
  return `${count} subagent${count === 1 ? '' : 's'}`;
}

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
 * the turn started), `working · 12m` without a known item, `3 subagents · 25m` while only
 * its subagents work (since the oldest started), 2026-10-16: `⏳ GitHub Actions · 12m` /
 * `⏳ background task · 12m` while it waits on background work, `⏰ waking up at 18:40`
 * while it waits for its wake-up; needs you → `needs you`; idle → `idle · 2h` (since the
 * last activity); paused → `paused`; offline → `offline`.
 */
export function rosterLine(entry: Pick<TeamRosterEntry, 'status' | 'current' | 'turnStartedAt' | 'lastActivityAt' | 'subagents' | 'waitingOn' | 'wakeAt'>, now: number): string {
  switch (entry.status) {
    case 'working': {
      // 2026-10-16: the main turn is over, its subagents work: `3 subagents · 25m` (since the oldest started).
      const subagents = entry.subagents ?? 0;
      const waitingOn = entry.waitingOn ?? null;
      if (subagents === 0 && waitingOn === 'wakeup') return waitLabel(waitingOn, entry.wakeAt);
      if (subagents === 0 && waitingOn !== null) {
        const waited = since(entry.turnStartedAt, now);
        return waited === null ? waitLabel(waitingOn, null) : `${waitLabel(waitingOn, null)} · ${shortDuration(waited)}`;
      }
      const head = subagents > 0 ? subagentsLabel(subagents) : entry.current ? itemLabel(entry.current) : 'working';
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
export function rosterTitle(entry: Pick<TeamRosterEntry, 'name' | 'status' | 'current' | 'machineName' | 'subagents' | 'waitingOn' | 'wakeAt'>): string {
  if (entry.status === 'working' && (entry.subagents ?? 0) > 0) return `${entry.name} · waiting on ${subagentsLabel(entry.subagents ?? 0)}`;
  if (entry.status === 'working' && entry.waitingOn) return `${entry.name} · ${waitTitle(entry.waitingOn, entry.wakeAt)}`;
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

/**
 * D132: `true` while Team was never used: no team read yet, or only the first team with its
 * default name and no member. The sidebar then shows no team entry (Team is always on since 2.0,
 * and a user who never touched it sees the sidebar as before; the nav grid's Team cell opens it).
 */
export function untouchedTeams(teams: readonly Pick<TeamSummary, 'id' | 'name' | 'members'>[]): boolean {
  if (teams.length === 0) return true;
  const [only] = teams;
  return teams.length === 1 && only !== undefined && only.id === DEFAULT_TEAM_ID && only.name === DEFAULT_TEAM_NAME && only.members === 0;
}
