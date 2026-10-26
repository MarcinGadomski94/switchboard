import type { SystemInfo, UsageWarning, UsageWindowKey } from '../../../core/api.ts';
import { usageWindowLabel } from '../../../core/usage.ts';
import { usageWarningKey } from '../../toast/usage-warning.ts';
import type { UsageAlert } from './needs-you-model.ts';
import { clock } from './time.ts';

/**
 * Fix after 2.0 · the Max usage warnings in v2 (`docs/v2.md` → *Usage warnings*).
 * The server fires a warning once per window when the window's use reaches the
 * developer's threshold (`usage.warnAtPct`) and lists it on `GET /api/system` and
 * the `system` event (`usageWarnings`) until the window resets; classic shows each
 * one as a toast once (`src/web/toast/usage-warning.ts`, whose key and "shown"
 * memory this reuses). v2 shows the same warnings as a toast (once, the same
 * memory as classic) and as a Needs-you alert while in force. Pure; unit-tested.
 */

/** The `usageWindows` key a warning's window is read from. */
const WINDOW_KEY: Readonly<Record<UsageWarning['window'], UsageWindowKey>> = { five_hour: 'session', seven_day: 'week', model: 'model' };

/** `Claude ‘Work’` (the active Claude Code account the meter reads), `Claude` while its name is unknown. */
export function warningAccount(system: SystemInfo | null): string {
  const name = system?.activeAccounts?.find((account) => account.cli === 'claude')?.name;
  return name ? `Claude ‘${name}’` : 'Claude';
}

/**
 * `true` while the warning still applies: its window has not reset at `now` and
 * that window's use, as read now (`usageWindows`), is not below the threshold it
 * reached (an unknown window keeps it).
 */
export function warningInForce(warning: UsageWarning, system: SystemInfo | null, now: number): boolean {
  if (!(Date.parse(warning.resetsAt) > now)) return false;
  const key = WINDOW_KEY[warning.window];
  const window = (system?.usageWindows ?? []).find((w) => w.key === key && (key !== 'model' || w.model === warning.model));
  return !window || window.pct >= warning.threshold;
}

/** The warnings of a `system` payload in force at `now` (see {@link warningInForce}). */
export function warningsInForce(system: SystemInfo | null, now: number): UsageWarning[] {
  return (system?.usageWarnings ?? []).filter((warning) => warningInForce(warning, system, now));
}

/** `Resets 15:40` (today), `Resets Thu 15:40` (another day). */
export function resetsText(iso: string, now: number): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const today = new Date(now).toDateString() === at.toDateString();
  return `Resets ${today ? '' : `${at.toLocaleDateString('en-GB', { weekday: 'short' })} `}${clock(iso)}`;
}

/** `Claude ‘Work’ — 5-hour window at 92%`. */
export function usageWarningHeadline(warning: UsageWarning, system: SystemInfo | null): string {
  return `${warningAccount(system)} — ${usageWindowLabel(warning)} at ${Math.round(warning.pct)}%`;
}

/** The v2 toast's words: the headline and `Resets 15:40`. */
export function usageWarningToastText(warning: UsageWarning, system: SystemInfo | null, now: number): string {
  return `${usageWarningHeadline(warning, system)} · ${resetsText(warning.resetsAt, now)}`;
}

/** The Needs-you alert key of a warning (one per window and reset, the classic toast's key). */
export function usageWarningAlertKey(warning: UsageWarning): string {
  return `warn:${usageWarningKey(warning)}`;
}

/** The Needs-you alerts ("Usage warning") of the warnings in force at `now`. */
export function usageWarningAlerts(system: SystemInfo | null, now: number): UsageAlert[] {
  return warningsInForce(system, now).map((warning) => ({
    key: usageWarningAlertKey(warning),
    title: 'Usage warning',
    text: `${usageWarningHeadline(warning, system)} (warning at ${warning.threshold}%). ${resetsText(warning.resetsAt, now)}. Nothing is paused automatically.`,
    createdAt: warning.firedAt,
  }));
}
