/**
 * The Max usage meter's rules (M9.2; `docs/usage.md`, ARCHITECTURE → *Usage meter*,
 * `docs/spike-m0.md` → *Usage %*). Pure functions: no I/O, the clock is passed in.
 *
 * - A **reading** is the 5-hour and weekly utilization (0–100) with their reset
 *   times, from the stdin control request `get_usage` (`rate_limits.five_hour` /
 *   `seven_day`) or from a `rate_limit_event` (`unifiedWindows.*`, 0–1 × 100).
 * - `usagePct` is the higher of the two windows. It is **unknown** (omitted, never
 *   guessed) when `get_usage` errors, `rate_limits_available` is false, a window or
 *   its `utilization` is null, the shape differs, or a window's `resets_at` has
 *   passed without a newer reading.
 * - A **warning** fires when a window reaches the threshold, once per window until
 *   that window's `resets_at` ("just warn": nothing is paused).
 */
import type { SystemInfo, UsageWarning, UsageWindowName } from './api.ts';
import type { UsageSource } from './model.ts';
import type { ControlRequestLine } from './stdin.ts';
import type { ControlResponseMessage, RateLimitMessage } from './stream-json.ts';

export type { UsageWarning, UsageWindowName } from './api.ts';

/** The two Max windows, in the order the meter checks them. */
export const USAGE_WINDOWS: readonly UsageWindowName[] = ['five_hour', 'seven_day'];

/** The Settings default and bounds of the warning threshold (M8.2's `usage.warnAtPct`). */
export const DEFAULT_WARN_AT_PCT = 90;
export const WARN_AT_PCT_SETTING = 'usage.warnAtPct';

/** The meter's cadence (BACKLOG M9.2): the CLI caches `get_usage` for about a minute (M0.3). */
export const LIVE_USAGE_INTERVAL_MS = 60_000;
/** The short-lived poller runs at most this often (only with a `/hub` viewer and no live session). */
export const POLLER_USAGE_INTERVAL_MS = 5 * 60_000;

/** One window of a reading. `null` = unknown (missing or malformed), never a guess. */
export interface UsageWindowReading {
  /** Utilization 0–100. */
  readonly pct: number | null;
  /** When the window resets, ISO 8601 UTC. */
  readonly resetsAt: string | null;
}

/** The stored fields of a reading (the `usage_readings` columns). */
export interface UsageReadingFields {
  readonly fiveHourPct: number | null;
  readonly fiveHourResetsAt: string | null;
  readonly sevenDayPct: number | null;
  readonly sevenDayResetsAt: string | null;
}

/** Why a reading (or the current state) gives no percentage. */
export type UsageUnknownReason =
  /** No reading yet. */
  | 'none'
  /** `get_usage` answered with an error, or no answer came (timeout, exit, spawn failure). */
  | 'error'
  /** `rate_limits_available` is false. */
  | 'unavailable'
  /** `rate_limits`, a window or its `utilization` / `resets_at` is null. */
  | 'missing'
  /** A field has another type than recorded in M0.3. */
  | 'shape'
  /** A window's `resets_at` has passed without a newer reading. */
  | 'expired';

/** A parsed reading, ready for `usage_readings`. */
export interface ParsedUsage extends UsageReadingFields {
  readonly source: UsageSource;
  /** `null` when both windows are known; otherwise the first reason found. */
  readonly unknown: UsageUnknownReason | null;
  /** What the CLI sent, verbatim (or `{ error }` when nothing usable came). */
  readonly raw: unknown;
}

/** The outcome of one `get_usage` call: the CLI's `control_response`, or why none came. */
export type GetUsageOutcome =
  | { readonly kind: 'response'; readonly message: Pick<ControlResponseMessage, 'subtype' | 'response' | 'error' | 'raw'> }
  | { readonly kind: 'failed'; readonly error: string };

/** The meter's view of the newest reading at a moment. */
export type UsageState =
  | {
      readonly known: true;
      /** The higher of the two windows (0–100): the binding limit. */
      readonly pct: number;
      /** The window behind `pct` (on a tie, the one that resets later). */
      readonly window: UsageWindowName;
      /** When that window resets. */
      readonly resetsAt: string;
      readonly windows: Readonly<Record<UsageWindowName, { readonly pct: number; readonly resetsAt: string }>>;
    }
  | { readonly known: false; readonly reason: UsageUnknownReason };

/** The warnings already fired: per window, the warning (kept until its `resetsAt`). */
export type WarnedState = Readonly<Partial<Record<UsageWindowName, UsageWarning>>>;

/** Readable names of the windows (Settings copy: "5-hour window and weekly limit"). */
export const USAGE_WINDOW_LABELS: Readonly<Record<UsageWindowName, string>> = {
  five_hour: '5-hour window',
  seven_day: 'weekly limit',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A utilization as a percentage 0–100: rounded to 2 decimals (removes float noise
 * like `0.29 × 100 = 28.999…`), capped at 100 (the contract's range; a reading past
 * the limit means the limit is reached). Negative or non-finite → `null`.
 */
export function normalizePct(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(100, Math.round(value * 100) / 100);
}

/** An ISO 8601 UTC time from a date string, or `null` when it does not parse. */
function isoTime(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

type WindowParse = { readonly ok: true; readonly pct: number; readonly resetsAt: string } | { readonly ok: false; readonly reason: UsageUnknownReason };

/** One `rate_limits.<window>` object of a `get_usage` response (`{ utilization 0–100, resets_at }`). */
function parseUsageWindow(value: unknown): WindowParse {
  if (value === null || value === undefined) return { ok: false, reason: 'missing' };
  if (!isRecord(value)) return { ok: false, reason: 'shape' };
  const utilization = value['utilization'];
  const resetsAt = value['resets_at'];
  if (utilization === null || utilization === undefined || resetsAt === null || resetsAt === undefined) return { ok: false, reason: 'missing' };
  if (typeof utilization !== 'number' || typeof resetsAt !== 'string') return { ok: false, reason: 'shape' };
  const pct = normalizePct(utilization);
  const iso = isoTime(resetsAt);
  if (pct === null || iso === null) return { ok: false, reason: 'shape' };
  return { ok: true, pct, resetsAt: iso };
}

const EMPTY: UsageReadingFields = { fiveHourPct: null, fiveHourResetsAt: null, sevenDayPct: null, sevenDayResetsAt: null };

function unknownReading(reason: UsageUnknownReason, raw: unknown): ParsedUsage {
  return { source: 'get_usage', ...EMPTY, unknown: reason, raw };
}

/**
 * The reading of one `get_usage` call (M0.3 shape: `response.rate_limits_available`,
 * `response.rate_limits.five_hour|seven_day = { utilization 0–100, resets_at }`).
 * An error reply, no reply, `rate_limits_available !== true`, a null / malformed
 * `rate_limits` or window: that window (or both) is `null` and `unknown` says why.
 * One good window is kept even when the other is unknown (it can still warn).
 */
export function readingFromGetUsage(outcome: GetUsageOutcome): ParsedUsage {
  if (outcome.kind === 'failed') return unknownReading('error', { error: outcome.error });
  const { message } = outcome;
  if (message.subtype !== 'success') return unknownReading('error', message.raw ?? { error: message.error });
  const response = message.response;
  if (!isRecord(response)) return unknownReading('shape', message.raw);
  const available = response['rate_limits_available'];
  if (available === false) return unknownReading('unavailable', response);
  if (available !== true) return unknownReading('shape', response);
  const limits = response['rate_limits'];
  if (limits === null || limits === undefined) return unknownReading('missing', response);
  if (!isRecord(limits)) return unknownReading('shape', response);
  const five = parseUsageWindow(limits['five_hour']);
  const seven = parseUsageWindow(limits['seven_day']);
  return {
    source: 'get_usage',
    fiveHourPct: five.ok ? five.pct : null,
    fiveHourResetsAt: five.ok ? five.resetsAt : null,
    sevenDayPct: seven.ok ? seven.pct : null,
    sevenDayResetsAt: seven.ok ? seven.resetsAt : null,
    unknown: !five.ok ? five.reason : !seven.ok ? seven.reason : null,
    raw: response,
  };
}

/**
 * The reading of a `rate_limit_event` (`rate_limit_info.unifiedWindows.<window>` =
 * `{ utilization 0–1, resetsAt epoch seconds }`): utilization × 100, reset → ISO.
 */
export function readingFromRateLimit(message: Pick<RateLimitMessage, 'fiveHour' | 'sevenDay' | 'raw'>): ParsedUsage {
  const window = (value: RateLimitMessage['fiveHour']): WindowParse => {
    if (!value || value.utilization === null || value.resetsAt === null) return { ok: false, reason: 'missing' };
    const pct = normalizePct(value.utilization * 100);
    const ms = value.resetsAt * 1000;
    if (pct === null || !Number.isFinite(ms)) return { ok: false, reason: 'shape' };
    return { ok: true, pct, resetsAt: new Date(ms).toISOString() };
  };
  const five = window(message.fiveHour);
  const seven = window(message.sevenDay);
  return {
    source: 'rate_limit_event',
    fiveHourPct: five.ok ? five.pct : null,
    fiveHourResetsAt: five.ok ? five.resetsAt : null,
    sevenDayPct: seven.ok ? seven.pct : null,
    sevenDayResetsAt: seven.ok ? seven.resetsAt : null,
    unknown: !five.ok ? five.reason : !seven.ok ? seven.reason : null,
    raw: message.raw,
  };
}

/** One window of a stored reading, valid at `now` (a number 0–100 and a reset still ahead), else why not. */
function windowAt(pct: number | null, resetsAt: string | null, now: number): WindowParse {
  if (pct === null || resetsAt === null) return { ok: false, reason: 'missing' };
  const value = normalizePct(pct);
  const reset = Date.parse(resetsAt);
  if (value === null || !Number.isFinite(reset)) return { ok: false, reason: 'shape' };
  if (reset <= now) return { ok: false, reason: 'expired' };
  return { ok: true, pct: value, resetsAt: new Date(reset).toISOString() };
}

/** The windows of the newest reading that are valid at `now`. */
export function validWindows(latest: UsageReadingFields | null, now: Date): Partial<Record<UsageWindowName, { readonly pct: number; readonly resetsAt: string }>> {
  if (!latest) return {};
  const at = now.getTime();
  const out: Partial<Record<UsageWindowName, { pct: number; resetsAt: string }>> = {};
  const five = windowAt(latest.fiveHourPct, latest.fiveHourResetsAt, at);
  const seven = windowAt(latest.sevenDayPct, latest.sevenDayResetsAt, at);
  if (five.ok) out.five_hour = { pct: five.pct, resetsAt: five.resetsAt };
  if (seven.ok) out.seven_day = { pct: seven.pct, resetsAt: seven.resetsAt };
  return out;
}

/**
 * The meter at `now` from the newest reading: known only when both windows are
 * known and neither has reset since; then `pct` = the higher one (the binding
 * limit), `resetsAt` = that window's reset (on a tie the later one, which binds
 * longer).
 */
export function usageState(latest: UsageReadingFields | null, now: Date): UsageState {
  if (!latest) return { known: false, reason: 'none' };
  const at = now.getTime();
  const five = windowAt(latest.fiveHourPct, latest.fiveHourResetsAt, at);
  const seven = windowAt(latest.sevenDayPct, latest.sevenDayResetsAt, at);
  if (!five.ok) return { known: false, reason: five.reason };
  if (!seven.ok) return { known: false, reason: seven.reason };
  const sevenBinds = seven.pct > five.pct || (seven.pct === five.pct && Date.parse(seven.resetsAt) >= Date.parse(five.resetsAt));
  const window: UsageWindowName = sevenBinds ? 'seven_day' : 'five_hour';
  const binding = sevenBinds ? seven : five;
  return {
    known: true,
    pct: binding.pct,
    window,
    resetsAt: binding.resetsAt,
    windows: { five_hour: { pct: five.pct, resetsAt: five.resetsAt }, seven_day: { pct: seven.pct, resetsAt: seven.resetsAt } },
  };
}

/** The Settings threshold (`usage.warnAtPct`): a whole number 1–100, else the default 90. */
export function warnThreshold(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100 ? value : DEFAULT_WARN_AT_PCT;
}

/** The fired warnings still in force at `now` (their window has not reset yet), five-hour first. */
export function activeWarnings(warned: WarnedState, now: Date): UsageWarning[] {
  return USAGE_WINDOWS.flatMap((name) => {
    const warning = warned[name];
    return warning && Date.parse(warning.resetsAt) > now.getTime() ? [warning] : [];
  });
}

/**
 * The warnings to fire now: every window of the newest reading that is valid at
 * `now` and at or above `threshold`, unless a warning for that window is still in
 * force (fired before and its `resetsAt` has not passed). Returns them with the
 * new warned state (warnings whose window has reset are dropped).
 */
export function dueWarnings(
  latest: UsageReadingFields | null,
  warned: WarnedState,
  threshold: number,
  now: Date,
): { readonly fire: UsageWarning[]; readonly warned: WarnedState } {
  const windows = validWindows(latest, now);
  const next: Partial<Record<UsageWindowName, UsageWarning>> = {};
  for (const warning of activeWarnings(warned, now)) next[warning.window] = warning;
  const fire: UsageWarning[] = [];
  for (const name of USAGE_WINDOWS) {
    const window = windows[name];
    if (!window || window.pct < threshold || next[name]) continue;
    const warning: UsageWarning = { window: name, pct: window.pct, threshold, resetsAt: window.resetsAt, firedAt: now.toISOString() };
    next[name] = warning;
    fire.push(warning);
  }
  return { fire, warned: next };
}

/** A stored warned state (settings `usage.warned`), keeping only well-formed entries. */
export function readWarnedState(value: unknown): WarnedState {
  if (!isRecord(value)) return {};
  const out: Partial<Record<UsageWindowName, UsageWarning>> = {};
  for (const name of USAGE_WINDOWS) {
    const entry = value[name];
    if (!isRecord(entry)) continue;
    const { pct, threshold, resetsAt, firedAt } = entry;
    if (typeof pct !== 'number' || typeof threshold !== 'number' || typeof resetsAt !== 'string' || typeof firedAt !== 'string') continue;
    if (!Number.isFinite(Date.parse(resetsAt))) continue;
    out[name] = { window: name, pct, threshold, resetsAt, firedAt };
  }
  return out;
}

/**
 * The usage fields of `GET /api/system` and the `system` hub event: `usagePct` +
 * `usageResetsAt` only when known (omitted otherwise, never invented), and the
 * warnings in force (additive `usageWarnings`, omitted when there are none).
 */
export function systemUsageFields(state: UsageState, warnings: readonly UsageWarning[]): Pick<SystemInfo, 'usagePct' | 'usageResetsAt' | 'usageWarnings'> {
  return {
    ...(state.known ? { usagePct: state.pct, usageResetsAt: state.resetsAt } : {}),
    ...(warnings.length > 0 ? { usageWarnings: [...warnings] } : {}),
  };
}

/** The stdin `get_usage` control request (`skip_behaviors: true` skips the local 7-day transcript scan, M0.3). */
export function getUsageLine(requestId: string): ControlRequestLine {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'get_usage', skip_behaviors: true } };
}
