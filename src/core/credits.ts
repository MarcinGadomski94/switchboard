/**
 * D103 (`docs/usage.md` → *Credits*, `docs/accounts.md` → *Credits*): whether a
 * Claude Code account runs on **credits** (paid extra usage) because a plan
 * window is at its limit, and how much of its credit limit is left. Pure: no
 * I/O, the clock is passed in.
 *
 * Two signals, both VERIFIED (Claude Code 2.1.296's schema, read-only, and the
 * stored readings' JSON shape):
 * - the `rate_limit_event`'s `rate_limit_info`: `isUsingOverage` / `overageInUse`
 *   (`true` while a request past the plan limit is served from credits),
 *   `overageStatus` (`allowed` / `allowed_warning` / `rejected`),
 *   `overageResetsAt` (epoch seconds: the credit period's reset, the 1st of the
 *   month), `overageDisabledReason`, `overageEnabled`, and `resetsAt` (the
 *   limiting plan window's reset);
 * - the `get_usage` answer's `rate_limits.extra_usage`: `is_enabled`,
 *   `monthly_limit` and `used_credits` in **minor units** (cents, `decimal_places`
 *   digits), `utilization` 0–100, `currency` (ISO 4217, `EUR`),
 *   `spend_limit_reached`.
 * A value the CLI did not send stays `null` (unknown), never guessed.
 */
import type { UsageReadingFields } from './usage.ts';

/** One account's credit state, as `ProfileUsage.credits` carries it (also across paired machines, D98). */
export interface AccountCredits {
  /**
   * The account's requests are paid from credits now: the CLI reported overage in
   * use, or a plan window is at 100 % while credits are enabled. Read it with
   * {@link creditsInUse} (it ends at {@link AccountCredits.until}).
   */
  readonly onCredits: boolean;
  /** When "on credits" ends at the latest: the reset of the plan window(s) at the limit (ISO); `null` when not on credits. */
  readonly until: string | null;
  /** Credits (extra usage) are turned on for the account; `null` = unknown. */
  readonly enabled: boolean | null;
  /** ISO 4217 code (`EUR`), `null` = unknown. */
  readonly currency: string | null;
  /** The monthly credit limit in `currency` (major units: `170` = €170.00), `null` = unknown / none. */
  readonly limit: number | null;
  /** Credits used this period, major units. */
  readonly used: number | null;
  /** `limit − used` (never below 0), `null` when either is unknown. */
  readonly left: number | null;
  /** The credit period's reset (ISO), `null` = unknown. */
  readonly resetsAt: string | null;
  /** The monthly credit limit is reached (no request can be paid from credits). */
  readonly limitReached: boolean;
  /** The time of the newest reading it was read from (ISO). */
  readonly at: string | null;
}

/** What {@link accountCredits} reads: the newest `rate_limit_event` and `get_usage` readings of the account. */
export interface CreditReadings {
  /** The newest `rate_limit_event`'s stored line (`{ type, rate_limit_info, … }`) and its time. */
  readonly event: { readonly raw: unknown; readonly at: string } | null;
  /** The newest `get_usage` answer (`response`) and its time. */
  readonly getUsage: { readonly raw: unknown; readonly at: string } | null;
  /** The newest reading's windows (either source). */
  readonly latest: UsageReadingFields | null;
}

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

function epochIso(value: unknown): string | null {
  const s = num(value);
  return s === null ? null : new Date(s * 1000).toISOString();
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** The overage fields of a stored `rate_limit_event` line (`rate_limit_info`), `null` when it carries none. */
export interface OverageInfo {
  /** `isUsingOverage` or `overageInUse` is `true`. */
  readonly inUse: boolean;
  /** `overageStatus`. */
  readonly status: string | null;
  /** `overageEnabled`. */
  readonly enabled: boolean | null;
  readonly disabledReason: string | null;
  /** `overageResetsAt`, ISO. */
  readonly resetsAt: string | null;
  /** `resetsAt`, ISO: the limiting plan window's reset. */
  readonly windowResetsAt: string | null;
}

/** Reads the overage fields of a `rate_limit_event` line (the whole stored line, or its `rate_limit_info`). */
export function overageFromRateLimit(raw: unknown): OverageInfo | null {
  const line = rec(raw);
  const info = rec(line?.['rate_limit_info']) ?? line;
  if (!info) return null;
  const using = bool(info['isUsingOverage']);
  const inUse = bool(info['overageInUse']);
  const status = typeof info['overageStatus'] === 'string' ? info['overageStatus'] : null;
  const enabled = bool(info['overageEnabled']);
  const disabledReason = typeof info['overageDisabledReason'] === 'string' ? info['overageDisabledReason'] : null;
  const resetsAt = epochIso(info['overageResetsAt']);
  if (using === null && inUse === null && status === null && enabled === null && disabledReason === null && resetsAt === null) return null;
  return { inUse: using === true || inUse === true, status, enabled, disabledReason, resetsAt, windowResetsAt: epochIso(info['resetsAt']) };
}

/** The credit block of a `get_usage` answer (`rate_limits.extra_usage`), `null` when it has none. */
export interface ExtraUsageInfo {
  readonly enabled: boolean | null;
  readonly currency: string | null;
  readonly limit: number | null;
  readonly used: number | null;
  readonly limitReached: boolean;
}

/**
 * Reads `rate_limits.extra_usage` of a `get_usage` answer. Amounts are minor units
 * with `decimal_places` digits (VERIFIED: equal to `spend.limit.amount_minor` with
 * its `exponent`); without `decimal_places` the `spend` money's `exponent` is used,
 * else 2 (ASSUMED D103-decimals: the CLI's own `/usage` screen divides by 100).
 */
export function extraUsageFromGetUsage(raw: unknown): ExtraUsageInfo | null {
  const limits = rec(rec(raw)?.['rate_limits']);
  const extra = rec(limits?.['extra_usage']);
  if (!extra) return null;
  const spend = rec(limits?.['spend']);
  const money = rec(spend?.['limit']) ?? rec(spend?.['used']);
  const digits = num(extra['decimal_places']) ?? num(money?.['exponent']) ?? 2;
  const scale = (value: unknown): number | null => {
    const n = num(value);
    return n === null ? null : round(n / 10 ** digits, digits);
  };
  const code = typeof extra['currency'] === 'string' && /^[A-Za-z]{3}$/.test(extra['currency']) ? extra['currency'].toUpperCase() : null;
  return {
    enabled: bool(extra['is_enabled']),
    currency: code,
    limit: scale(extra['monthly_limit']),
    used: scale(extra['used_credits']),
    limitReached: extra['spend_limit_reached'] === true,
  };
}

function later(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * D103: an account's credit state at `now` from its newest readings, `null` when
 * neither reading says anything about credits.
 * - **On credits** when the newest `rate_limit_event` reports overage in use and
 *   the plan window it names has not reset, or when a plan window of the newest
 *   reading is at 100 % while credits are enabled (and their limit is not
 *   reached): requests still succeed, paid from credits. It ends when the full
 *   window(s) reset (`until`).
 * - **Enabled** from the newer of the two readings that says (`extra_usage.is_enabled`;
 *   `overageEnabled`, an `allowed` status, or a disabled reason).
 * - **Amounts** from `get_usage` only (a `rate_limit_event` has none).
 */
export function accountCredits(readings: CreditReadings, now: Date): AccountCredits | null {
  const at = now.getTime();
  const overage = readings.event ? overageFromRateLimit(readings.event.raw) : null;
  const extra = readings.getUsage ? extraUsageFromGetUsage(readings.getUsage.raw) : null;
  if (!overage && !extra) return null;
  const ahead = (iso: string | null): boolean => iso !== null && Date.parse(iso) > at;

  const fromEvent: boolean | null = overage
    ? overage.enabled ?? (overage.disabledReason !== null ? false : overage.status === 'allowed' || overage.status === 'allowed_warning' ? true : overage.status === 'rejected' ? false : null)
    : null;
  const eventNewer = readings.event && (!readings.getUsage || Date.parse(readings.event.at) >= Date.parse(readings.getUsage.at));
  const enabled = eventNewer ? (fromEvent ?? extra?.enabled ?? null) : (extra?.enabled ?? fromEvent);
  const limitReached = extra?.limitReached === true;

  let until: string | null = null;
  if (overage?.inUse && ahead(overage.windowResetsAt)) until = overage.windowResetsAt;
  const latest = readings.latest;
  if (latest && enabled === true && !limitReached) {
    if (latest.fiveHourPct !== null && latest.fiveHourPct >= 100 && ahead(latest.fiveHourResetsAt)) until = later(until, latest.fiveHourResetsAt);
    if (latest.sevenDayPct !== null && latest.sevenDayPct >= 100 && ahead(latest.sevenDayResetsAt)) until = later(until, latest.sevenDayResetsAt);
  }
  const limit = extra?.limit ?? null;
  const used = extra?.used ?? null;
  const times = [readings.event?.at, readings.getUsage?.at].filter((t): t is string => typeof t === 'string');
  return {
    onCredits: until !== null,
    until,
    enabled,
    currency: extra?.currency ?? null,
    limit,
    used,
    left: limit !== null && used !== null ? Math.max(0, round(limit - used, 2)) : null,
    resetsAt: overage?.resetsAt ?? null,
    limitReached,
    at: times.reduce<string | null>((a, b) => later(a, b), null),
  };
}

/** `true` while the account is on credits at `now` (the state is kept, and shared, until its `until`). */
export function creditsInUse(credits: AccountCredits | null | undefined, now: number): boolean {
  return credits?.onCredits === true && credits.until !== null && Date.parse(credits.until) > now;
}

/**
 * `true` when the account could serve requests from credits now: on credits
 * already, or credits enabled with their limit not reached (and money left when
 * that is known).
 */
export function creditsUsable(credits: AccountCredits | null | undefined, now: number): boolean {
  if (creditsInUse(credits, now)) return true;
  if (!credits || credits.enabled !== true || credits.limitReached) return false;
  return credits.left === null || credits.left > 0;
}

/** The share of the credit limit left, 0–100, `null` when unknown (no limit, or amounts unknown). */
export function creditsLeftPct(credits: AccountCredits | null | undefined): number | null {
  if (!credits || credits.left === null || credits.limit === null || credits.limit <= 0) return null;
  return (credits.left / credits.limit) * 100;
}

/** Below this share of the limit left, the "credits running low" notice fires (D103). */
export const LOW_CREDITS_PCT = 20;

/** `€12.40`, `€50` (whole amounts without decimals); an unknown currency code as `12.40 XYZ`. */
export function formatMoney(amount: number, currency: string | null): string {
  const whole = Number.isInteger(amount);
  if (currency) {
    try {
      return new Intl.NumberFormat('en-GB', { style: 'currency', currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(amount);
    } catch {
      return `${amount.toFixed(whole ? 0 : 2)} ${currency}`;
    }
  }
  return amount.toFixed(whole ? 0 : 2);
}

/** D103: the credit period's reset as a day in this machine's zone: `1 Nov`. */
export function creditsResetDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** D103: the symbol of a currency code (`€` for EUR), `¤` when the code is unknown or has none (the "on credits" badge's glyph). */
export function currencyGlyph(currency: string | null): string {
  if (!currency) return '¤';
  try {
    const part = new Intl.NumberFormat('en-GB', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).formatToParts(0).find((p) => p.type === 'currency');
    return part && part.value.length <= 3 ? part.value : '¤';
  } catch {
    return '¤';
  }
}

/**
 * The money line of an account's credits: `€12.40 left of €50`; `€29.36 used`
 * when only that is known; `credits enabled · balance unknown`; `credits off`;
 * `null` when nothing is known.
 */
export function creditsMoneyText(credits: AccountCredits | null | undefined): string | null {
  if (!credits) return null;
  if (credits.left !== null && credits.limit !== null) return `${formatMoney(credits.left, credits.currency)} left of ${formatMoney(credits.limit, credits.currency)}`;
  if (credits.used !== null && credits.enabled !== false) return `${formatMoney(credits.used, credits.currency)} used · limit unknown`;
  if (credits.enabled === true) return 'credits enabled · balance unknown';
  if (credits.enabled === false) return 'credits off';
  return credits.onCredits ? 'balance unknown' : null;
}

/** Reads a credit state defensively (a paired machine's message, D98); `null` when it is not one. */
export function readAccountCredits(value: unknown): AccountCredits | null {
  const o = rec(value);
  if (!o || typeof o['onCredits'] !== 'boolean') return null;
  const iso = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
  const amount = (v: unknown): number | null => {
    const n = num(v);
    return n !== null && n >= 0 ? n : null;
  };
  const code = typeof o['currency'] === 'string' && /^[A-Z]{3}$/.test(o['currency']) ? o['currency'] : null;
  return {
    onCredits: o['onCredits'],
    until: iso(o['until']),
    enabled: bool(o['enabled']),
    currency: code,
    limit: amount(o['limit']),
    used: amount(o['used']),
    left: amount(o['left']),
    resetsAt: iso(o['resetsAt']),
    limitReached: o['limitReached'] === true,
    at: iso(o['at']),
  };
}
