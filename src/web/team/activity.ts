import type { TeamActivityKind, TeamActivityRecord } from '../../core/team.ts';

/**
 * D100 follow-up 2026-10-14 (activity redesign) · the Team page's Activity feed as rows:
 * each entry is two lines (kind icon · actor · time, then the text without the actor),
 * and a run of the same event by different members within a few minutes collapses into
 * one group row ("✓ 4 new charters accepted · 09:12–09:13"). Pure: `docs/team.md` →
 * *The Team page → Activity*.
 */

/** Consecutive same-variant entries at most this far apart join one group. */
export const GROUP_WINDOW_MS = 5 * 60_000;

/** The feed shows this many rows, then **Show more** adds as many again. */
export const ACTIVITY_PAGE = 20;

/**
 * What an entry is, finer than its stored kind (the stored kinds stay as they are, so
 * older peers keep reading them): it picks the icon and decides what groups together.
 */
export type ActivityVariant =
  | 'charter-proposed'
  | 'charter-asked'
  | 'charter-accepted'
  | 'charter-dismissed'
  | 'settings'
  | 'team-move'
  | 'handoff'
  | 'finished'
  | 'pause'
  | 'resume'
  | 'adopt'
  | 'return'
  | 'move'
  | 'create'
  | 'report'
  | 'approved'
  | 'declined'
  | 'budget'
  | 'team'
  | 'access'
  | 'access-revoked';

/** The variant of an entry, from its kind and (for `update` / `approval` / `access`) its text. */
export function activityVariant(kind: TeamActivityKind, text: string): ActivityVariant {
  const t = text.toLowerCase();
  switch (kind) {
    case 'update':
      if (t.includes('charter')) {
        if (t.includes('accepted')) return 'charter-accepted';
        if (t.includes('proposed')) return 'charter-proposed';
        if (t.includes('dismissed') || t.includes('cancelled')) return 'charter-dismissed';
        if (t.includes('asked')) return 'charter-asked';
      }
      if (t.includes('moved to team') || t.includes('joined from team')) return 'team-move';
      return 'settings';
    case 'handoff':
      return /(^|\s)finished:/.test(t) ? 'finished' : 'handoff';
    case 'approval':
      return t.startsWith('approved') || t.startsWith('request approved') ? 'approved' : 'declined';
    case 'access':
      return t.includes('revoked') ? 'access-revoked' : 'access';
    case 'pause':
    case 'resume':
    case 'adopt':
    case 'return':
    case 'move':
    case 'create':
    case 'report':
    case 'budget':
    case 'team':
      return kind;
  }
}

/** The small icon in front of an entry (monochrome text glyphs, like the cards' status icons). */
export const ACTIVITY_ICON: Readonly<Record<ActivityVariant, string>> = {
  'charter-proposed': '✎',
  'charter-asked': '✎',
  'charter-accepted': '✓',
  'charter-dismissed': '✖',
  settings: '✎',
  'team-move': '⇄',
  handoff: '→',
  finished: '✓',
  pause: '⏸',
  resume: '▶',
  adopt: '⇄',
  return: '⇄',
  move: '⇄',
  create: '＋',
  report: '…',
  approved: '✓',
  declined: '✖',
  budget: '⏸',
  team: '✎',
  access: '⚿',
  'access-revoked': '✖',
};

/** A group's line: "4 new charters accepted". */
export function groupLabel(variant: ActivityVariant, count: number): string {
  const n = String(count);
  switch (variant) {
    case 'charter-proposed':
      return `${n} new charters proposed — waiting in Needs you`;
    case 'charter-asked':
      return `${n} members asked to draft a charter`;
    case 'charter-accepted':
      return `${n} new charters accepted`;
    case 'charter-dismissed':
      return `${n} charter proposals dismissed`;
    case 'settings':
      return `${n} members' settings changed`;
    case 'team-move':
      return `${n} members moved between teams`;
    case 'handoff':
      return `${n} hand-offs`;
    case 'finished':
      return `${n} hand-offs finished`;
    case 'pause':
      return `${n} members paused`;
    case 'resume':
      return `${n} members resumed`;
    case 'adopt':
      return `${n} sessions adopted`;
    case 'return':
      return `${n} members returned to the sessions list`;
    case 'move':
      return `${n} members moved to another machine`;
    case 'create':
      return `${n} new members started`;
    case 'report':
      return `${n} reports`;
    case 'approved':
      return `${n} requests approved`;
    case 'declined':
      return `${n} requests declined or dismissed`;
    case 'budget':
      return `${n} budget changes`;
    case 'team':
      return `${n} team changes`;
    case 'access':
      return `${n} access changes`;
    case 'access-revoked':
      return `${n} accesses revoked`;
  }
}

/**
 * The text without the actor in front: newer entries are stored actor-less already;
 * older ones (and older peers') start with "<actor>'s ", "<actor>: " or "<actor> ",
 * which is dropped here so the row does not say the name twice.
 */
export function stripActor(text: string, actor: string): string {
  if (actor === '') return text;
  for (const prefix of [`${actor}'s `, `${actor}’s `, `${actor}: `, `${actor} `]) {
    if (text.startsWith(prefix)) {
      const rest = text.slice(prefix.length).trim();
      return rest === '' ? text : rest;
    }
  }
  return text;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dayStart(at: Date): number {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
}

/** "09:13" today, "yesterday 18:40", else "13 Oct 18:40"; '' for an unreadable time. */
export function activityClock(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const hm = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const days = Math.round((dayStart(now) - dayStart(at)) / 86_400_000);
  if (days <= 0) return hm;
  if (days === 1) return `yesterday ${hm}`;
  return `${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${hm}`;
}

/** A group's time: "09:12–09:13" (oldest–newest), or one time when both read the same. */
export function clockRange(oldestIso: string, newestIso: string, now: Date): string {
  const from = activityClock(oldestIso, now);
  const to = activityClock(newestIso, now);
  if (from === to) return to;
  // Same day: only the newest carries the day ("yesterday 18:40–18:42").
  const [fromDay, fromTime] = splitDay(from);
  const [toDay, toTime] = splitDay(to);
  return fromDay === toDay ? `${toDay}${fromTime}–${toTime}` : `${from}–${to}`;
}

function splitDay(clock: string): [string, string] {
  const space = clock.lastIndexOf(' ');
  return space < 0 ? ['', clock] : [clock.slice(0, space + 1), clock.slice(space + 1)];
}

/** One row of the feed: an entry, or a run of the same event by different members. */
export type ActivityRow =
  | { readonly type: 'entry'; readonly entry: TeamActivityRecord; readonly variant: ActivityVariant }
  | { readonly type: 'group'; readonly id: string; readonly variant: ActivityVariant; readonly entries: readonly TeamActivityRecord[] };

/**
 * Groups a newest-first feed: consecutive entries of the same variant, each at most
 * {@link GROUP_WINDOW_MS} from the one before, by different members (a member that
 * repeats, or an entry without a member, ends the run). A run of one stays an entry.
 */
export function groupActivity(entries: readonly TeamActivityRecord[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  let run: TeamActivityRecord[] = [];
  let runVariant: ActivityVariant | null = null;
  const flush = (): void => {
    if (run.length === 0 || runVariant === null) return;
    if (run.length === 1) rows.push({ type: 'entry', entry: run[0] as TeamActivityRecord, variant: runVariant });
    else rows.push({ type: 'group', id: `group:${run[0]?.id ?? ''}`, variant: runVariant, entries: run });
    run = [];
    runVariant = null;
  };
  for (const entry of entries) {
    const variant = activityVariant(entry.kind, entry.text);
    const last = run[run.length - 1];
    const joins =
      last !== undefined &&
      variant === runVariant &&
      entry.memberId !== null &&
      last.memberId !== null &&
      !run.some((other) => other.memberId === entry.memberId) &&
      Math.abs(Date.parse(last.at) - Date.parse(entry.at)) <= GROUP_WINDOW_MS;
    if (!joins) flush();
    run.push(entry);
    runVariant = variant;
  }
  flush();
  return rows;
}

/** How many entries are newer than `seenAt` (the newest entry the developer had in view); 0 before any. */
export function newSince(entries: readonly TeamActivityRecord[], seenAt: string | null): number {
  if (!seenAt) return 0;
  return entries.filter((entry) => entry.at > seenAt).length;
}

/** The newest entry's time (`null` for an empty feed). */
export function newestAt(entries: readonly TeamActivityRecord[]): string | null {
  let newest: string | null = null;
  for (const entry of entries) if (newest === null || entry.at > newest) newest = entry.at;
  return newest;
}

/** A group's member chips: the first `shown` names, then "+N". */
export function chipNames(names: readonly string[], shown = 2): { readonly names: readonly string[]; readonly more: number } {
  return { names: names.slice(0, shown), more: Math.max(0, names.length - shown) };
}
