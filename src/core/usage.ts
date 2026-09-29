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
 * - D17: `usageWindows` lists each window known now for the footer's rows:
 *   Session (5-hour) and Week (all models) from the newest reading, and each
 *   model-scoped weekly limit (`rate_limits.model_scoped[]` / `limits[]` of a
 *   `get_usage` answer) while it is in use (above 0 % or active). A model window at
 *   the threshold warns like the other two.
 * - D23: `weeklyPace` places the Week window against its daily allowance
 *   (7 days of 24 h back from its reset, `day × 100 / 7` % during day *n*).
 * - D46: `sessionPace` places the 5-hour Session window against its allowance by
 *   the minute (300 minutes back from its reset; during minute *n*, 1–300, `n × 100 / 300` %).
 */
import type { SystemInfo, UsageWarning, UsageWindow, UsageWindowName } from './api.ts';
import type { UsageSource } from './model.ts';
import type { ControlRequestLine } from './stdin.ts';
import type { ControlResponseMessage, RateLimitMessage } from './stream-json.ts';

export type { UsageWarning, UsageWarningWindow, UsageWindow, UsageWindowName } from './api.ts';

/** The two Max windows, in the order the meter checks them. */
export const USAGE_WINDOWS: readonly UsageWindowName[] = ['five_hour', 'seven_day'];

/** The Settings default and bounds of the warning threshold (M8.2's `usage.warnAtPct`). */
export const DEFAULT_WARN_AT_PCT = 90;
export const WARN_AT_PCT_SETTING = 'usage.warnAtPct';

/** The meter's cadence (BACKLOG M9.2): the CLI caches `get_usage` for about a minute (M0.3). */
export const LIVE_USAGE_INTERVAL_MS = 60_000;
/** The short-lived poller runs at most this often (only with a `/hub` viewer and no live session). */
export const POLLER_USAGE_INTERVAL_MS = 5 * 60_000;

/**
 * D17: model-scoped windows come only from `get_usage` (a `rate_limit_event` has
 * none), so they are read from the newest `get_usage` reading while it is at most
 * this old (twice the poller's interval); older, they are unknown.
 */
export const MODEL_WINDOW_MAX_AGE_MS = 2 * POLLER_USAGE_INTERVAL_MS;

/** D17: the footer rows' labels of the two Max windows. */
export const USAGE_ROW_LABELS = { session: 'Session', week: 'Week' } as const;

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

/** D17: one model-scoped weekly limit of a `get_usage` answer. `null` = unknown (missing or malformed), never a guess. */
export interface ModelWindowReading {
  /** The model's display name (`Fable`). */
  readonly model: string;
  /** Utilization 0–100. */
  readonly pct: number | null;
  /** When the window resets, ISO 8601 UTC. */
  readonly resetsAt: string | null;
  /** `limits[].is_active` of its `weekly_scoped` entry (`false` when absent). */
  readonly isActive: boolean;
  /** When the reading is older than {@link MODEL_WINDOW_MAX_AGE_MS}: its time, shown as "as of" (else absent). */
  readonly asOf?: string;
}

/** The warnings already fired: per window, the warning (kept until its `resetsAt`); D17: per model under `model`. */
export interface WarnedState {
  readonly five_hour?: UsageWarning;
  readonly seven_day?: UsageWarning;
  /** D17: model-scoped weekly limits, by display name. */
  readonly model?: Readonly<Record<string, UsageWarning>>;
}

/** Readable names of the windows (Settings copy: "5-hour window and weekly limit"). */
export const USAGE_WINDOW_LABELS: Readonly<Record<UsageWindowName, string>> = {
  five_hour: '5-hour window',
  seven_day: 'weekly limit',
};

/** The readable name of a warning's window: {@link USAGE_WINDOW_LABELS}, or `Fable weekly limit` for a model-scoped one (D17). */
export function usageWindowLabel(warning: Pick<UsageWarning, 'window' | 'model'>): string {
  if (warning.window === 'model') return `${warning.model ?? 'model'} ${USAGE_WINDOW_LABELS.seven_day}`;
  return USAGE_WINDOW_LABELS[warning.window];
}

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

/** A utilization or percent 0–100 from a CLI field, `null` when it is not one. */
function pctOf(value: unknown): number | null {
  return typeof value === 'number' ? normalizePct(value) : null;
}

/** A reset time from a CLI field, `null` when it is not a parseable date string. */
function resetOf(value: unknown): string | null {
  return typeof value === 'string' ? isoTime(value) : null;
}

/**
 * D17: the model-scoped weekly limits of a stored `get_usage` answer (its `raw`,
 * the `response` object): `rate_limits.model_scoped[] = { display_name,
 * utilization 0–100, resets_at }`, joined by display name with
 * `rate_limits.limits[]` entries of `kind: "weekly_scoped"` (`scope.model.display_name`,
 * `percent`, `resets_at`, `is_active`). `model_scoped` wins where both carry a value;
 * a model only in `limits` is kept. Order: as the CLI lists them. Empty when the
 * answer is an error, has no rate limits, or lists no model.
 */
export function modelWindowsFromGetUsage(raw: unknown): ModelWindowReading[] {
  if (!isRecord(raw) || raw['rate_limits_available'] !== true) return [];
  const limits = raw['rate_limits'];
  if (!isRecord(limits)) return [];
  const byModel = new Map<string, { pct: number | null; resetsAt: string | null; isActive: boolean }>();
  const entry = (model: string) => {
    let found = byModel.get(model);
    if (!found) {
      found = { pct: null, resetsAt: null, isActive: false };
      byModel.set(model, found);
    }
    return found;
  };
  const scoped = limits['model_scoped'];
  for (const item of Array.isArray(scoped) ? scoped : []) {
    if (!isRecord(item) || typeof item['display_name'] !== 'string' || item['display_name'] === '') continue;
    const found = entry(item['display_name']);
    found.pct = pctOf(item['utilization']);
    found.resetsAt = resetOf(item['resets_at']);
  }
  const list = limits['limits'];
  for (const item of Array.isArray(list) ? list : []) {
    if (!isRecord(item) || item['kind'] !== 'weekly_scoped') continue;
    const scope = item['scope'];
    const model = isRecord(scope) && isRecord(scope['model']) ? scope['model']['display_name'] : undefined;
    if (typeof model !== 'string' || model === '') continue;
    const found = entry(model);
    found.pct ??= pctOf(item['percent']);
    found.resetsAt ??= resetOf(item['resets_at']);
    found.isActive = item['is_active'] === true;
  }
  return [...byModel].map(([model, value]) => ({ model, ...value }));
}

/** D17: the model windows valid at `now` (a number and a reset still ahead). */
function validModelWindows(models: readonly ModelWindowReading[], now: Date): Array<ModelWindowReading & { readonly pct: number; readonly resetsAt: string }> {
  return models.flatMap((m) => {
    const window = windowAt(m.pct, m.resetsAt, now.getTime());
    return window.ok ? [{ ...m, pct: window.pct, resetsAt: window.resetsAt }] : [];
  });
}

/**
 * D17: the usage windows known at `now`, for `SystemInfo.usageWindows`: `session`
 * (the newest reading's 5-hour window) and `week` (its weekly window) when valid,
 * then a `model` window per model-scoped limit that is valid and **in use** (above
 * 0 % or active). Unknown windows are left out, never guessed.
 */
export function usageWindows(latest: UsageReadingFields | null, models: readonly ModelWindowReading[], now: Date): UsageWindow[] {
  const windows = validWindows(latest, now);
  const out: UsageWindow[] = [];
  if (windows.five_hour) out.push({ key: 'session', label: USAGE_ROW_LABELS.session, ...windows.five_hour });
  if (windows.seven_day) out.push({ key: 'week', label: USAGE_ROW_LABELS.week, ...windows.seven_day });
  for (const m of validModelWindows(models, now)) {
    if (m.pct > 0 || m.isActive) out.push({ key: 'model', label: m.model, pct: m.pct, resetsAt: m.resetsAt, model: m.model, ...(m.asOf ? { asOf: m.asOf } : {}) });
  }
  return out;
}

/** D23: the weekly window is this many pace days long. */
export const WEEK_DAYS = 7;

/**
 * D23: one pace day, **24 hours** counted back from the weekly reset (not a
 * calendar day): across a daylight-saving change the days stay 24 h long, so their
 * start moves by the hour in local time (`docs/usage.md` → *Weekly pace*).
 */
export const PACE_DAY_MS = 24 * 60 * 60_000;

/** D46: the 5-hour Session window is this many pace minutes long. */
export const SESSION_MINUTES = 300;

/** D46: one pace minute, counted from the Session window's start (its reset minus 5 h), not from the clock's minutes. */
export const PACE_MINUTE_MS = 60_000;

/**
 * D23 / D46: where a usage window stands against its allowance at a moment, as
 * {@link weeklyPace} and {@link sessionPace} give it.
 */
export interface UsagePace {
  /** The allowance now, 0–100, rounded to 2 decimals like the utilization (Week: `57.14`; Session: `50`, `0.33`). */
  readonly allowancePct: number;
  /** When the allowance steps up next, ISO 8601 UTC (on the window's last step, the reset itself). */
  readonly nextStepAt: string;
  /** `pct < allowancePct`: on pace (green); at or above the allowance it is not (yellow). */
  readonly onPace: boolean;
}

/**
 * D23: where the weekly usage stands against its daily allowance at a moment
 * ({@link weeklyPace}): `allowancePct` is `day × 100 / 7` (14.29, …, 57.14, 71.43,
 * 85.71, 100) and `nextStepAt` the end of this day.
 */
export interface WeeklyPace extends UsagePace {
  /** The window's current day, 1–7: day 1 starts 7 × 24 h before the reset, each day at the reset's time. */
  readonly day: number;
}

/**
 * D46: where the 5-hour Session usage stands against its allowance at a moment
 * ({@link sessionPace}): `allowancePct` is `(minutes + 1) × 100 / 300` (0.33 in the
 * window's first minute, 50 in its 150th, 100 in its last) and `nextStepAt` the end of this minute.
 */
export interface SessionPace extends UsagePace {
  /** Whole minutes elapsed since the window's start (its reset minus 5 h), 0–299. */
  readonly minutes: number;
}

/**
 * D23 / D46: the step a pace window is in at `now`. The window is `steps` ×
 * `stepMs` long and ends at the reset; `step` counts the whole steps elapsed since
 * its start (0 in the first). `null` (unknown, never guessed) when `pct` or
 * `resetsAt` is not usable, when the reset is not ahead of `now`, or when `now` is
 * before the window's start (the reset is further ahead than the window is long).
 */
function paceStep(window: Pick<UsageWindow, 'pct' | 'resetsAt'>, now: Date, steps: number, stepMs: number): { readonly pct: number; readonly start: number; readonly step: number } | null {
  const pct = normalizePct(window.pct);
  const reset = Date.parse(window.resetsAt);
  const at = now.getTime();
  if (pct === null || !Number.isFinite(reset) || !Number.isFinite(at) || reset <= at) return null;
  const start = reset - steps * stepMs;
  if (at < start) return null;
  return { pct, start, step: Math.floor((at - start) / stepMs) };
}

/**
 * D23 / D46: the verdict against an allowance: the allowance rounded to 2 decimals
 * like the utilization, and on pace only **below** that rounded value (a usage at
 * exactly the allowance the tooltip shows is not on pace).
 */
function paceAgainst(pct: number, allowance: number, nextStepAt: number): UsagePace {
  const allowancePct = Math.round(allowance * 100) / 100;
  return { allowancePct, nextStepAt: new Date(nextStepAt).toISOString(), onPace: pct < allowancePct };
}

/**
 * D23, made continuous (developer ruling 2026-09-29): the weekly window's pace at
 * `now`. The window started 7 × 24 h before `resetsAt` and its allowance grows
 * evenly by the minute like the Session bar's (D46): during minute *n* (1–10 080)
 * it is *n* × 100 / 10 080 %. (Before, each whole day's 14.29 % was allowed from
 * that day's start, which left the last day almost nothing.) `day` is still the
 * window's day, 1–7. Returns `null` (unknown, never guessed) when `pct` or
 * `resetsAt` is not usable, when the reset is not ahead of `now`, or when it is
 * more than 7 days ahead (then `now` is outside the window it closes).
 */
export function weeklyPace(week: Pick<UsageWindow, 'pct' | 'resetsAt'>, now: Date): WeeklyPace | null {
  const at = paceStep(week, now, WEEK_MINUTES, PACE_MINUTE_MS);
  if (!at) return null;
  const day = Math.floor((at.step * PACE_MINUTE_MS) / PACE_DAY_MS) + 1;
  return { day, ...paceAgainst(at.pct, ((at.step + 1) * 100) / WEEK_MINUTES, at.start + (at.step + 1) * PACE_MINUTE_MS) };
}

/** The weekly window in pace minutes (7 × 24 × 60). */
export const WEEK_MINUTES = WEEK_DAYS * 24 * 60;

/**
 * D46: the 5-hour Session window's pace at `now`. The window started 5 h before
 * `resetsAt` and its allowance grows evenly by the minute: each minute's share is
 * available from the start of that minute (like D23's days, developer ruling
 * 2026-09-29), so during minute *n* (1–300) it is *n* × 100 / 300 % (rounded like
 * {@link weeklyPace}'s), stepping up at the end of each minute counted from the
 * window's start. Returns `null` (unknown,
 * never guessed) when `pct` or `resetsAt` is not usable, when the reset is not
 * ahead of `now`, or when it is more than 5 h ahead.
 */
export function sessionPace(session: Pick<UsageWindow, 'pct' | 'resetsAt'>, now: Date): SessionPace | null {
  const at = paceStep(session, now, SESSION_MINUTES, PACE_MINUTE_MS);
  if (!at) return null;
  // Developer ruling 2026-09-29: a minute counts as soon as it starts (like D23's days), so minute 1 already allows 1/300.
  return { minutes: at.step, ...paceAgainst(at.pct, ((at.step + 1) * 100) / SESSION_MINUTES, at.start + (at.step + 1) * PACE_MINUTE_MS) };
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

/** The fired warnings still in force at `now` (their window has not reset yet): five-hour, weekly, then the model ones (D17). */
export function activeWarnings(warned: WarnedState, now: Date): UsageWarning[] {
  const inForce = (warning: UsageWarning | undefined): warning is UsageWarning => !!warning && Date.parse(warning.resetsAt) > now.getTime();
  return [...USAGE_WINDOWS.map((name) => warned[name]), ...Object.values(warned.model ?? {})].filter(inForce);
}

/**
 * The warnings to fire now: every window of the newest reading that is valid at
 * `now` and at or above `threshold`, and (D17) every model window of `models` that
 * is, unless a warning for that window (that model) is still in force (fired
 * before and its `resetsAt` has not passed). Returns them with the new warned
 * state (warnings whose window has reset are dropped).
 */
export function dueWarnings(
  latest: UsageReadingFields | null,
  warned: WarnedState,
  threshold: number,
  now: Date,
  models: readonly ModelWindowReading[] = [],
): { readonly fire: UsageWarning[]; readonly warned: WarnedState } {
  const windows = validWindows(latest, now);
  const next: Partial<Record<UsageWindowName, UsageWarning>> = {};
  const nextModels: Record<string, UsageWarning> = {};
  for (const warning of activeWarnings(warned, now)) {
    if (warning.window === 'model') nextModels[warning.model ?? ''] = warning;
    else next[warning.window] = warning;
  }
  const fire: UsageWarning[] = [];
  const firedAt = now.toISOString();
  for (const name of USAGE_WINDOWS) {
    const window = windows[name];
    if (!window || window.pct < threshold || next[name]) continue;
    const warning: UsageWarning = { window: name, pct: window.pct, threshold, resetsAt: window.resetsAt, firedAt };
    next[name] = warning;
    fire.push(warning);
  }
  for (const m of validModelWindows(models, now)) {
    if (m.pct < threshold || nextModels[m.model]) continue;
    const warning: UsageWarning = { window: 'model', model: m.model, pct: m.pct, threshold, resetsAt: m.resetsAt, firedAt };
    nextModels[m.model] = warning;
    fire.push(warning);
  }
  return { fire, warned: Object.keys(nextModels).length > 0 ? { ...next, model: nextModels } : next };
}

/** The common fields of a stored warning, `null` when one is missing or malformed. */
function storedWarning(entry: unknown): Pick<UsageWarning, 'pct' | 'threshold' | 'resetsAt' | 'firedAt'> | null {
  if (!isRecord(entry)) return null;
  const { pct, threshold, resetsAt, firedAt } = entry;
  if (typeof pct !== 'number' || typeof threshold !== 'number' || typeof resetsAt !== 'string' || typeof firedAt !== 'string') return null;
  if (!Number.isFinite(Date.parse(resetsAt))) return null;
  return { pct, threshold, resetsAt, firedAt };
}

/** A stored warned state (settings `usage.warned`), keeping only well-formed entries (D17: model ones under `model`). */
export function readWarnedState(value: unknown): WarnedState {
  if (!isRecord(value)) return {};
  const out: Partial<Record<UsageWindowName, UsageWarning>> = {};
  for (const name of USAGE_WINDOWS) {
    const fields = storedWarning(value[name]);
    if (fields) out[name] = { window: name, ...fields };
  }
  const models: Record<string, UsageWarning> = {};
  const stored = value['model'];
  for (const [model, entry] of Object.entries(isRecord(stored) ? stored : {})) {
    const fields = storedWarning(entry);
    if (fields && model !== '') models[model] = { window: 'model', model, ...fields };
  }
  return Object.keys(models).length > 0 ? { ...out, model: models } : out;
}

/** The usage fields of `GET /api/system` and the `system` hub event. */
export type SystemUsageFields = Pick<SystemInfo, 'usagePct' | 'usageResetsAt' | 'usageWarnings' | 'usageWindows'>;

/**
 * The usage fields of `GET /api/system` and the `system` hub event: `usagePct` +
 * `usageResetsAt` only when known (omitted otherwise, never invented), the
 * warnings in force (additive `usageWarnings`, omitted when there are none) and
 * (D17) the windows known now (additive `usageWindows`, omitted when none).
 */
export function systemUsageFields(state: UsageState, warnings: readonly UsageWarning[], windows: readonly UsageWindow[] = []): SystemUsageFields {
  return {
    ...(state.known ? { usagePct: state.pct, usageResetsAt: state.resetsAt } : {}),
    ...(warnings.length > 0 ? { usageWarnings: [...warnings] } : {}),
    ...(windows.length > 0 ? { usageWindows: [...windows] } : {}),
  };
}

/** The stdin `get_usage` control request (`skip_behaviors: true` skips the local 7-day transcript scan, M0.3). */
export function getUsageLine(requestId: string): ControlRequestLine {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'get_usage', skip_behaviors: true } };
}
