/**
 * D137 · the archive (`docs/cleanup.md` → *The archive (D137)*): closing a
 * session archives it, and an archived session is deleted by itself once it has
 * been archived for {@link ARCHIVE_DAYS_SETTING} days (default 14; 0 = Never,
 * the forever behavior before D137). The rules and the words shared by the
 * server (the sweep, `src/server/sessions/archive.ts`) and both UIs. Pure.
 *
 * The user-facing words are **Archive** / **Archived** / **Restore**; the API
 * and the database keep D33's names (`close`, `reopen`, `closedAt`).
 */

const DAY_MS = 86_400_000;

/** The settings key of the period, in days (whole, 0–3650; 0 = Never). */
export const ARCHIVE_DAYS_SETTING = 'sessions.archiveDays';

/** The default period (the developer's choice, D137). */
export const ARCHIVE_DAYS_DEFAULT = 14;

/** `0` = Never: archived sessions are kept until deleted by hand (Clean-up). */
export const ARCHIVE_NEVER = 0;
export const ARCHIVE_DAYS_MIN = 0;
export const ARCHIVE_DAYS_MAX = 3650;

/** The choices Settings offers (any whole number in range is accepted by the API). */
export const ARCHIVE_DAYS_CHOICES: readonly number[] = [1, 7, 14, 30, 60, 90, ARCHIVE_NEVER];

/**
 * The raw settings key of the upgrade grace (ISO), written once, the first time
 * a version with D137 runs: a session archived before it counts its period from
 * that moment, so nothing disappears on the upgrade day. Not a `GET /api/settings` key.
 */
export const ARCHIVE_SINCE_SETTING = 'sessions.archiveSince';

/** The raw settings key of the sweep's record ({@link ArchiveSweepRecord}); read through `sessions.archiveSweep`. */
export const ARCHIVE_SWEEP_SETTING = 'sessions.archiveSweep';

/** How often the server sweeps (and once at start). */
export const ARCHIVE_SWEEP_INTERVAL_MS = 60 * 60_000;

/** Why an archived session is kept past its period (re-evaluated at every sweep). */
export type ArchiveKeptReason = 'crew' | 'plan' | 'plan-step' | 'routine' | 'cli-schedule' | 'running' | 'pinned';

/** Every kept reason, in the order they are checked (the first that holds is shown). */
export const ARCHIVE_KEPT_REASONS: readonly ArchiveKeptReason[] = ['running', 'crew', 'plan', 'plan-step', 'routine', 'cli-schedule', 'pinned'];

/** Classic's words for each kept reason ("Kept: …"); v2's are in `src/web/v2/glossary.ts`. */
export const ARCHIVE_KEPT_LABELS: Readonly<Record<ArchiveKeptReason, string>> = {
  running: 'still running',
  crew: 'a Team member',
  plan: 'its plan is not finished',
  'plan-step': 'a step of a running plan',
  routine: 'it has an active loop',
  'cli-schedule': 'it has a scheduled job',
  pinned: 'pinned',
};

/** What an archived session shows (`Session.deletesAt` / `keptReason`, `HistoryItem` too). */
export interface ArchiveInfo {
  /** When the sweep deletes it (ISO); `null` when kept, open, or the period is Never. */
  readonly deletesAt: string | null;
  /** Why it is kept past its period; `null` when not kept. */
  readonly keptReason: ArchiveKeptReason | null;
}

/** A worktree the sweep kept (and why) when it deleted its session. */
export interface ArchiveKeptWorktree {
  readonly path: string;
  readonly reason: string;
}

/** The sweep's record (`GET /api/settings` → `sessions.archiveSweep`). */
export interface ArchiveSweepRecord {
  /** The last sweep (ISO); `null` before the first. */
  readonly lastRunAt: string | null;
  /** The last sweep that deleted something; `null` when none has. */
  readonly lastDeleted: {
    readonly at: string;
    readonly sessions: number;
    readonly worktrees: number;
    readonly keptWorktrees: readonly ArchiveKeptWorktree[];
  } | null;
}

/** No sweep yet. */
export const EMPTY_ARCHIVE_SWEEP: ArchiveSweepRecord = { lastRunAt: null, lastDeleted: null };

/** A period from a `PUT /api/settings` body: a whole number 0–3650, else `null`. */
export function parseArchiveDays(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= ARCHIVE_DAYS_MIN && value <= ARCHIVE_DAYS_MAX ? value : null;
}

/** The stored period, else the default. */
export function archiveDaysOf(stored: unknown): number {
  return parseArchiveDays(stored) ?? ARCHIVE_DAYS_DEFAULT;
}

/** A stored sweep record (anything unreadable reads as none). */
export function readArchiveSweep(value: unknown): ArchiveSweepRecord {
  if (typeof value !== 'object' || value === null) return EMPTY_ARCHIVE_SWEEP;
  const record = value as Record<string, unknown>;
  const lastRunAt = typeof record['lastRunAt'] === 'string' ? record['lastRunAt'] : null;
  const raw = record['lastDeleted'];
  let lastDeleted: ArchiveSweepRecord['lastDeleted'] = null;
  if (typeof raw === 'object' && raw !== null) {
    const entry = raw as Record<string, unknown>;
    const kept = Array.isArray(entry['keptWorktrees']) ? entry['keptWorktrees'] : [];
    if (typeof entry['at'] === 'string') {
      lastDeleted = {
        at: entry['at'],
        sessions: typeof entry['sessions'] === 'number' ? entry['sessions'] : 0,
        worktrees: typeof entry['worktrees'] === 'number' ? entry['worktrees'] : 0,
        keptWorktrees: kept.flatMap((item: unknown) => {
          const k = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {};
          return typeof k['path'] === 'string' && typeof k['reason'] === 'string' ? [{ path: k['path'], reason: k['reason'] }] : [];
        }),
      };
    }
  }
  return { lastRunAt, lastDeleted };
}

/**
 * When an archived session is due: its period counts from when it was archived
 * (`closedAt`), or from the upgrade grace (`since`) when that is later. `null`
 * when the period is Never. Reopening clears `closedAt`, so archiving again
 * starts a new period.
 */
export function archiveDeadline(closedAt: string, since: string | null, days: number): string | null {
  if (days === ARCHIVE_NEVER) return null;
  const closed = Date.parse(closedAt);
  const grace = since === null ? Number.NaN : Date.parse(since);
  const start = Number.isFinite(grace) && grace > closed ? grace : closed;
  if (!Number.isFinite(start)) return null;
  return new Date(start + days * DAY_MS).toISOString();
}

/** What an archived session shows, from its deadline and the first kept reason that holds. */
export function archiveInfo(input: { readonly closedAt: string | null; readonly since: string | null; readonly days: number; readonly kept: ArchiveKeptReason | null }): ArchiveInfo {
  if (input.closedAt === null) return { deletesAt: null, keptReason: null };
  if (input.kept !== null) return { deletesAt: null, keptReason: input.kept };
  return { deletesAt: archiveDeadline(input.closedAt, input.since, input.days), keptReason: null };
}

/** `true` when a deadline has passed. */
export function archiveDue(deletesAt: string | null, now: number): boolean {
  return deletesAt !== null && Date.parse(deletesAt) <= now;
}

/** Whole days left until `deletesAt`, counted in calendar days of the local time (0 = today; past due = 0). */
export function archiveDaysLeft(deletesAt: string, now: Date = new Date()): number {
  const end = new Date(deletesAt);
  const startOfDay = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.max(0, Math.round((startOfDay(end) - startOfDay(now)) / DAY_MS));
}

/** "Deletes today", "Deletes tomorrow", "Deletes in 12 days" (same words in both themes). */
export function archiveCountdownText(deletesAt: string, now: Date = new Date()): string {
  const days = archiveDaysLeft(deletesAt, now);
  if (days === 0) return 'Deletes today';
  if (days === 1) return 'Deletes tomorrow';
  return `Deletes in ${days} days`;
}

/** The line a row shows: the countdown, `Kept: <reason>`, or `null` (open, or Never). */
export function archiveRowText(info: Partial<ArchiveInfo>, labels: Readonly<Record<ArchiveKeptReason, string>> = ARCHIVE_KEPT_LABELS, now: Date = new Date()): string | null {
  if (info.keptReason) return `Kept: ${labels[info.keptReason]}`;
  if (info.deletesAt) return archiveCountdownText(info.deletesAt, now);
  return null;
}

/** A period as Settings shows it: "14 days", "1 day", "Never". */
export function archiveDaysLabel(days: number): string {
  if (days === ARCHIVE_NEVER) return 'Never';
  return days === 1 ? '1 day' : `${days} days`;
}

/** The line at the top of the archived list: "Archived agents are deleted after 14 days." (`noun` = agents / sessions). */
export function archivePolicyText(days: number, noun: string): string {
  if (days === ARCHIVE_NEVER) return `Archived ${noun} are kept until you delete them.`;
  return `Archived ${noun} are deleted after ${archiveDaysLabel(days)}.`;
}

/** "today 14:02", "yesterday 09:10", "12 Oct 14:02" (the sweep record's time). */
export function sweepTimeText(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diff = Math.round((day(now) - day(at)) / DAY_MS);
  if (diff === 0) return `today ${time}`;
  if (diff === 1) return `yesterday ${time}`;
  return `${at.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

/** "Last: deleted 3 archived agents, 2 worktrees, today 14:02" (`noun` = agent / session); `null` before anything was deleted. */
export function archiveSweepText(record: ArchiveSweepRecord, noun: string, now: Date = new Date()): string | null {
  const last = record.lastDeleted;
  if (!last) return record.lastRunAt ? `Last check ${sweepTimeText(record.lastRunAt, now)}: nothing was due.` : null;
  const parts = [`deleted ${last.sessions} archived ${noun}${last.sessions === 1 ? '' : 's'}`];
  if (last.worktrees > 0) parts.push(`${last.worktrees} worktree${last.worktrees === 1 ? '' : 's'}`);
  const kept = last.keptWorktrees.length > 0 ? ` (${last.keptWorktrees.length} worktree${last.keptWorktrees.length === 1 ? '' : 's'} kept, see Clean-up)` : '';
  return `Last: ${parts.join(', ')}, ${sweepTimeText(last.at, now)}${kept}`;
}
