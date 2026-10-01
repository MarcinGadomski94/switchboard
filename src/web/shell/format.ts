import { CLI_SHORT_LABELS } from '../../core/cli-providers.ts';
import type { Session, SolutionGroup, SystemInfo, UsageWindow } from '../../core/api.ts';
import type { SessionStatus } from '../../core/model.ts';
import { MOVED_MODE_LINE } from '../../core/history.ts';
import { REMOTE_MODE_LINE } from '../../core/remote-session.ts';
import { USAGE_ROW_LABELS, sessionPace, weeklyPace } from '../../core/usage.ts';

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

/** One usage row of the footer (D17): Session, Week, or a model's weekly limit. */
export interface UsageRow extends Meter {
  /** `session`, `week` or `model` (the `data-meter` value). */
  readonly key: UsageWindow['key'];
  readonly label: string;
  /** `key: 'model'`: the model's name. */
  readonly model?: string;
  /** D23 (`key: 'week'`) and D46 (`key: 'session'`) only: the pace while the window and its reset are known. */
  readonly pace?: PaceView;
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

/** The value of a known window: `62% · 1h48` (bar = the %); an old model reading reads `4% · as of 25m`. */
function windowMeter(window: UsageWindow, now: number): Meter {
  const when = window.asOf ? `as of ${formatAge(window.asOf, now)}` : formatResetsIn(window.resetsAt, now);
  return { pct: clampPct(window.pct), text: `${Math.round(window.pct)}% · ${when}` };
}

/**
 * The footer's usage rows (D17, `docs/usage.md`): always **Session** and **Week**
 * (`unknown` while `usageWindows` has no such window, `—` before `/api/system`
 * answers), then one row per model window the server lists (it lists them only
 * while in use). Nothing is derived from `usagePct`: unknown stays unknown. D23:
 * a known Week row carries its `pace` (color, allowance marker, tooltip); D46: so
 * does a known Session row.
 */
export function usageRows(system: SystemInfo | null, now: number = Date.now()): UsageRow[] {
  const windows = system?.usageWindows ?? [];
  const fixed = (key: 'session' | 'week'): UsageRow => {
    const label = USAGE_ROW_LABELS[key];
    const window = windows.find((w) => w.key === key);
    if (window) {
      const pace = paceView(key, window, now);
      return { key, label, ...windowMeter(window, now), ...(pace ? { pace } : {}) };
    }
    return { key, label, pct: 0, text: system ? 'unknown' : UNKNOWN };
  };
  return [
    fixed('session'),
    fixed('week'),
    ...windows.filter((w) => w.key === 'model').map((w): UsageRow => ({ key: 'model', label: w.label, model: w.model ?? w.label, ...windowMeter(w, now) })),
    // D62 P7: another CLI's own windows (Codex's rate limits) while they are known.
    ...(system?.cliUsage ?? []).map(
      (w): UsageRow => ({ key: 'model', label: w.label, model: `cli:${w.provider}:${w.label}`, ...windowMeter({ key: 'model', label: w.label, pct: w.pct, resetsAt: w.resetsAt ?? '' }, now) }),
    ),
  ];
}

/** D63: one account in the footer's per-account line ("Default 62%", "Private out until 14:05"). */
export interface AccountUsageItem {
  readonly key: string;
  readonly cli: string;
  readonly text: string;
  readonly active: boolean;
  readonly spent: boolean;
}

/**
 * D63 (`docs/accounts.md` → *Usage per account*): the footer's compact line under the
 * bars (which are the active account's): each account of a CLI with more than one,
 * "Default 62% · Private 10%", the active one marked, a spent one with when it is
 * usable again. Empty while no CLI has more than one enabled account.
 */
export function accountUsageItems(system: SystemInfo | null, now: number = Date.now()): AccountUsageItem[] {
  return (system?.accountUsage ?? []).map((row) => {
    const spent = row.exhaustedUntil !== null && Date.parse(row.exhaustedUntil) > now;
    const label = row.cli === 'claude' ? row.name : `${CLI_SHORT_LABELS[row.cli]} ${row.name}`;
    return {
      key: row.profileId,
      cli: row.cli,
      text: spent ? `${label} out until ${clockTime(new Date(row.exhaustedUntil as string))}` : `${label} ${row.pct === null ? '—' : `${Math.round(row.pct)}%`}`,
      active: row.active,
      spent,
    };
  });
}

/** `3 bg processes` (gap #11: live supervised claude processes). */
export function processCount(system: SystemInfo | null): string {
  return system ? `${system.processes} bg processes` : '';
}

/** Solutions with a conflict (two sessions writing one working tree, M6.3). */
export function conflictCount(groups: readonly SolutionGroup[] | null): number {
  return (groups ?? []).reduce((sum, group) => sum + group.solutions.filter((s) => s.conflict).length, 0);
}
