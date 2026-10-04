import { CLI_SHORT_LABELS, type CliProviderId } from '../../core/cli-providers.ts';
import type { AccountUsageWindow, Session, SolutionGroup, SystemInfo, UsageWindow } from '../../core/api.ts';
import type { SessionStatus } from '../../core/model.ts';
import { MOVED_MODE_LINE } from '../../core/history.ts';
import { REMOTE_MODE_LINE } from '../../core/remote-session.ts';
import { sessionPace, weeklyPace } from '../../core/usage.ts';

/** CSS variable of a status dot color (SPEC tokens). */
export function statusColor(status: SessionStatus): string {
  return `var(--status-${status === 'paused' ? 'idle' : status})`;
}

/** Age for the sidebar (`now`, `1m`, `3h`, `2d`) from an ISO time. */
export function formatAge(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return 'now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The sidebar's mode line, as the prototype builds it for a new session:
 * `orch|single · QA|feature · UI-first|integration`. Parts the session does not
 * have are left out. D16: `terminal · moved`; D25: `remote · local copy` for a
 * local copy of a remote session.
 */
export function modeLine(
  session: Pick<Session, 'mode' | 'workType' | 'phase'> & { readonly origin?: Session['origin']; readonly remoteSource?: Session['remoteSource'] },
): string {
  // D25: a local copy of a remote session has no session-start answers either.
  if (session.remoteSource) return REMOTE_MODE_LINE;
  // D16: a session moved in from a terminal has no session-start answers (developer ruling 2026-09-28).
  if (session.origin === 'terminal') return MOVED_MODE_LINE;
  const parts: string[] = [];
  if (session.mode) parts.push(session.mode === 'orchestrator' ? 'orch' : 'single');
  if (session.workType) parts.push(session.workType === 'qa' ? 'QA' : 'feature');
  if (session.phase) parts.push(session.phase === 'ui-first' ? 'UI-first' : 'integration');
  return parts.join(' · ');
}

/** Host of a tool URL without the scheme (`http://localhost:3000` → `localhost:3000`). */
export function urlHost(url: string | null): string {
  return (url ?? '').replace(/^https?:\/\//, '');
}

const GIB = 1024 ** 3;

/** One footer meter: bar width (0–100) and its value text. */
export interface Meter {
  readonly pct: number;
  readonly text: string;
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** Shown when a value is not available (never invented). */
export const UNKNOWN = '—';

/** CPU meter (`12%`). */
export function cpuMeter(system: SystemInfo | null): Meter {
  if (!system) return { pct: 0, text: UNKNOWN };
  return { pct: clampPct(system.cpu), text: `${Math.round(system.cpu)}%` };
}

/** RAM meter (`12.5/64 GB`). */
export function ramMeter(system: SystemInfo | null): Meter {
  if (!system || system.ramTotal <= 0) return { pct: 0, text: UNKNOWN };
  const used = system.ramUsed / GIB;
  const total = system.ramTotal / GIB;
  return { pct: clampPct((system.ramUsed / system.ramTotal) * 100), text: `${used.toFixed(1)}/${Math.round(total)} GB` };
}

/** Time left until `iso` as `2h05` (or `45m`). */
export function formatResetsIn(iso: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h${String(rest).padStart(2, '0')}` : `${rest}m`;
}

/**
 * D23 / D46: a usage row's pace, the Week row's ({@link weeklyPace}) or the
 * Session row's ({@link sessionPace}): the bar's color, the allowance marker and
 * the row's tooltip. Absent while the window or its reset is unknown.
 */
export interface PaceView {
  /** The row's `data-pace`: `on` below the allowance (bar in SPEC status done, green), `ahead` at or above it (status need, yellow). */
  readonly state: 'on' | 'ahead';
  /** Where the marker sits on the bar: the current allowance, 0–100 (`57.14`). */
  readonly markerPct: number;
  /**
   * The row's `title`, naming the next step in local time: Week `On pace: 33% of
   * 57.14% allowed until Mon 15:00` (weekday and time), Session `On pace: 38% of
   * 50% until 14:05` (time).
   */
  readonly title: string;
}

/** A percentage with up to 2 decimals and no trailing zeros: `33%`, `57.14%`, `100%`. */
function pacePct(value: number): string {
  return `${Number(value.toFixed(2))}%`;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** `15:00`: local 24 h time (the schedule table's `clockTime`, not imported: that module imports this one). */
function clockTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * D23 / D46: the Week or the Session row's pace at `now`, `null` while unknown
 * (never guessed). Both step by the minute (the Week since the 2026-09-29
 * ruling), so the tooltip names the time only ("until 14:05").
 */
function paceView(key: 'session' | 'week', window: UsageWindow, now: number): PaceView | null {
  const pace = key === 'week' ? weeklyPace(window, new Date(now)) : sessionPace(window, new Date(now));
  if (!pace) return null;
  const verdict = pace.onPace ? 'On pace' : 'Ahead of pace';
  const next = new Date(pace.nextStepAt);
  const until = `until ${clockTime(next)}`;
  return {
    state: pace.onPace ? 'on' : 'ahead',
    markerPct: pace.allowancePct,
    title: `${verdict}: ${pacePct(window.pct)} of ${pacePct(pace.allowancePct)} ${until}`,
  };
}

/** D66: the footer grid's column headers (the 5-hour window, the weekly one). */
export const USAGE_GRID_COLUMNS = { session: '5h', week: 'Week' } as const;

/** D66: one mini-bar of a footer grid line (the 5-hour or the weekly window): bar width 0–100 and `62%`, or `—` while unknown. */
export interface UsageCell extends Meter {
  /** `false` while the window is unknown (empty bar, `—`). */
  readonly known: boolean;
  /** D23 / D46: a Claude Code account's pace while the window and its reset are known (color, allowance marker). */
  readonly pace?: PaceView;
}

/**
 * D66 (`docs/accounts.md` → *Usage per account*): one line of the footer's usage
 * grid, an account (or a CLI with a single account): its two mini-bars, or "out
 * until 14:05" while it is spent; the tooltip has the resets, the pace and the
 * model limits.
 */
export interface UsageGridLine {
  /** The profile id, or `cli:<id>` for a CLI whose single account is not listed in `accountUsage`. */
  readonly key: string;
  readonly cli: CliProviderId;
  /** A Claude Code account's profile name; another CLI's short label (`Codex`, `Codex Work` while it has more than one account). */
  readonly label: string;
  /** The account new sessions of its CLI start on (marked ●); only while that CLI has more than one. */
  readonly active: boolean;
  readonly spent: boolean;
  /** Set while spent: `out until 14:05`, shown in place of the bars. */
  readonly outUntil: string | null;
  readonly session: UsageCell;
  readonly week: UsageCell;
  /** The line's tooltip: each window's reset, the pace, each model's weekly limit. */
  readonly title: string;
}

/** A window as the grid reads it, from `usageWindows`, `accountUsage[].windows` or `cliUsage`. */
type GridWindow = Pick<AccountUsageWindow, 'key' | 'label' | 'pct' | 'resetsAt' | 'model' | 'asOf'>;

function usageCell(key: 'session' | 'week', window: GridWindow | undefined, withPace: boolean, now: number): UsageCell {
  if (!window) return { known: false, pct: 0, text: UNKNOWN };
  const pace = withPace && window.resetsAt ? paceView(key, { key, label: window.label, pct: window.pct, resetsAt: window.resetsAt }, now) : null;
  return { known: true, pct: clampPct(window.pct), text: `${Math.round(window.pct)}%`, ...(pace ? { pace } : {}) };
}

/** A tooltip line of a known window: `5h: 62% · resets in 1h48`; an old model reading `Fable week: 4% · as of 25m`. */
function windowLine(name: string, window: GridWindow, now: number): string {
  const when = window.asOf ? `as of ${formatAge(window.asOf, now)}` : window.resetsAt ? `resets in ${formatResetsIn(window.resetsAt, now)}` : 'reset unknown';
  return `${name}: ${Math.round(window.pct)}% · ${when}`;
}

function gridLine(
  input: { readonly key: string; readonly cli: CliProviderId; readonly label: string; readonly active: boolean; readonly exhaustedUntil: string | null },
  windows: readonly GridWindow[],
  now: number,
): UsageGridLine {
  const withPace = input.cli === 'claude';
  const spent = input.exhaustedUntil !== null && Date.parse(input.exhaustedUntil) > now;
  const cells = {
    session: usageCell('session', windows.find((w) => w.key === 'session'), withPace, now),
    week: usageCell('week', windows.find((w) => w.key === 'week'), withPace, now),
  };
  const outUntil = spent ? `out until ${clockTime(new Date(input.exhaustedUntil as string))}` : null;
  const title: string[] = [input.active ? `${input.label} · new sessions start here` : input.label];
  if (outUntil) title.push(`Out of usage until ${clockTime(new Date(input.exhaustedUntil as string))}`);
  for (const key of ['session', 'week'] as const) {
    const window = windows.find((w) => w.key === key);
    title.push(window ? windowLine(USAGE_GRID_COLUMNS[key], window, now) : `${USAGE_GRID_COLUMNS[key]}: unknown`);
    const pace = cells[key].pace;
    if (pace) title.push(`  ${pace.title}`);
  }
  for (const window of windows.filter((w) => w.key === 'model')) title.push(windowLine(window.model ? `${window.label} week` : window.label, window, now));
  title.push('Settings → Accounts');
  return { key: input.key, cli: input.cli, label: input.label, active: input.active, spent, outUntil, ...cells, title: title.join('\n') };
}

/**
 * D66 (`docs/accounts.md` → *Usage per account*): the footer's usage grid, one
 * line per account. Claude Code: each enabled account while it has more than one
 * (`accountUsage`; the active one's windows are the meter's `usageWindows`), else
 * one "Claude" line from `usageWindows`; always listed (`—` while unknown or
 * before `/api/system` answers). Codex / OpenCode: each account of a CLI with
 * more than one that has a known window or is spent, else one line from that
 * CLI's `cliUsage` while it has any. Nothing is derived from `pct`: an unknown
 * window stays `—`.
 */
export function usageGridLines(system: SystemInfo | null, now: number = Date.now()): UsageGridLine[] {
  const rows = system?.accountUsage ?? [];
  const lines: UsageGridLine[] = [];
  const claude = rows.filter((row) => row.cli === 'claude');
  if (claude.length === 0) {
    lines.push(gridLine({ key: 'cli:claude', cli: 'claude', label: CLI_SHORT_LABELS.claude, active: false, exhaustedUntil: null }, system?.usageWindows ?? [], now));
  }
  for (const row of claude) {
    const windows = row.active ? (system?.usageWindows ?? row.windows ?? []) : (row.windows ?? []);
    lines.push(gridLine({ key: row.profileId, cli: row.cli, label: row.name, active: row.active, exhaustedUntil: row.exhaustedUntil }, windows, now));
  }
  for (const cli of ['codex', 'opencode'] as const) {
    const own = rows.filter((row) => row.cli === cli);
    for (const row of own) {
      const line = gridLine({ key: row.profileId, cli, label: `${CLI_SHORT_LABELS[cli]} ${row.name}`, active: row.active, exhaustedUntil: row.exhaustedUntil }, row.windows ?? [], now);
      if (line.spent || (row.windows ?? []).length > 0) lines.push(line);
    }
    if (own.length > 0) continue;
    const windows = (system?.cliUsage ?? []).filter((w) => w.provider === cli).map((w): GridWindow => ({ key: w.key ?? 'model', label: w.label, pct: w.pct, resetsAt: w.resetsAt }));
    if (windows.length > 0) lines.push(gridLine({ key: `cli:${cli}`, cli, label: CLI_SHORT_LABELS[cli], active: false, exhaustedUntil: null }, windows, now));
  }
  return lines;
}

/** `3 bg processes` (gap #11: live supervised claude processes). */
export function processCount(system: SystemInfo | null): string {
  return system ? `${system.processes} bg processes` : '';
}

/** Solutions with a conflict (two sessions writing one working tree, M6.3). */
export function conflictCount(groups: readonly SolutionGroup[] | null): number {
  return (groups ?? []).reduce((sum, group) => sum + group.solutions.filter((s) => s.conflict).length, 0);
}
