import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStreamLine } from '../../src/core/stream-json.ts';
import { readingFromRateLimit, readingFromGetUsage, type UsageReadingFields } from '../../src/core/usage.ts';
import {
  accountCredits,
  creditsInUse,
  creditsLeftPct,
  creditsMoneyText,
  creditsUsable,
  extraUsageFromGetUsage,
  formatMoney,
  overageFromRateLimit,
  readAccountCredits,
} from '../../src/core/credits.ts';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'credits');
const fixture = async (name: string): Promise<unknown> => JSON.parse(await readFile(path.join(FIXTURES, `${name}.json`), 'utf8')) as unknown;

/** The windows a stored reading of `raw` would have. */
function fieldsOf(raw: unknown, source: 'event' | 'get_usage'): UsageReadingFields {
  if (source === 'event') {
    const parsed = parseStreamLine(JSON.stringify(raw));
    if (parsed.kind !== 'rate-limit') throw new Error('not a rate_limit_event');
    return readingFromRateLimit(parsed);
  }
  return readingFromGetUsage({ kind: 'response', message: { subtype: 'success', response: raw as Record<string, unknown>, error: null, raw: raw as Record<string, unknown> } });
}

// The fixtures' times: weekly resets 2026-10-15 13:00Z, 5-hour 2026-10-13 23:10Z, the credit period 2026-11-01.
const NOW = new Date('2026-10-13T21:20:00Z');

describe('D103 credits: the CLI signals', () => {
  it('reads the overage fields of a rate_limit_event (VERIFIED field names)', async () => {
    const info = overageFromRateLimit(await fixture('rate-limit-overage'));
    expect(info).toEqual({ inUse: true, status: 'allowed', enabled: null, disabledReason: null, resetsAt: '2026-11-01T00:00:00.000Z', windowResetsAt: '2026-10-15T13:00:00.000Z' });
    expect(overageFromRateLimit(await fixture('rate-limit-overage-disabled'))).toMatchObject({ inUse: false, status: 'rejected', disabledReason: 'org_level_disabled' });
    expect(overageFromRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })).toBeNull();
    expect(overageFromRateLimit('nope')).toBeNull();
  });

  it('reads extra_usage of a get_usage answer: minor units with decimal_places, currency code', async () => {
    expect(extraUsageFromGetUsage(await fixture('get-usage-credits'))).toEqual({ enabled: true, currency: 'EUR', limit: 50, used: 37.6, limitReached: false });
    expect(extraUsageFromGetUsage(await fixture('get-usage-credits-off'))).toEqual({ enabled: false, currency: null, limit: null, used: null, limitReached: false });
    // Without decimal_places: the spend money's exponent; without that: 2.
    expect(extraUsageFromGetUsage({ rate_limits: { extra_usage: { is_enabled: true, monthly_limit: 1000, used_credits: 1, currency: 'jpy' }, spend: { limit: { amount_minor: 1000, currency: 'JPY', exponent: 0 } } } })).toMatchObject({ limit: 1000, used: 1, currency: 'JPY' });
    expect(extraUsageFromGetUsage({ rate_limits: { extra_usage: { is_enabled: true, monthly_limit: 2550, used_credits: null } } })).toMatchObject({ limit: 25.5, used: null, currency: null });
    expect(extraUsageFromGetUsage({ rate_limits: { five_hour: null } })).toBeNull();
  });
});

describe('D103 credits: on credits', () => {
  it('a 100 % weekly window while requests still succeed (overage in use) → on credits until the weekly reset', async () => {
    const event = await fixture('rate-limit-overage');
    const getUsage = await fixture('get-usage-credits');
    const credits = accountCredits({ event: { raw: event, at: '2026-10-13T21:19:44Z' }, getUsage: { raw: getUsage, at: '2026-10-13T21:10:00Z' }, latest: fieldsOf(event, 'event') }, NOW);
    expect(credits).toMatchObject({ onCredits: true, until: '2026-10-15T13:00:00.000Z', enabled: true, currency: 'EUR', limit: 50, used: 37.6, left: 12.4, resetsAt: '2026-11-01T00:00:00.000Z', limitReached: false, at: '2026-10-13T21:19:44Z' });
    expect(creditsInUse(credits, NOW.getTime())).toBe(true);
    // The weekly window resets: no longer on credits (the state ends by itself).
    expect(creditsInUse(credits, Date.parse('2026-10-15T13:00:01Z'))).toBe(false);
  });

  it('a get_usage reading at 100 % with credits enabled (no event yet) → on credits', async () => {
    const getUsage = await fixture('get-usage-credits');
    const credits = accountCredits({ event: null, getUsage: { raw: getUsage, at: '2026-10-13T21:10:00Z' }, latest: fieldsOf(getUsage, 'get_usage') }, NOW);
    expect(credits?.onCredits).toBe(true);
    expect(credits?.until).toBe('2026-10-15T13:00:00.116Z');
  });

  it('at 100 % with credits off, or the credit limit reached → not on credits (the account is out)', async () => {
    const event = await fixture('rate-limit-overage-disabled');
    const off = accountCredits({ event: { raw: event, at: '2026-10-13T20:47:00Z' }, getUsage: null, latest: fieldsOf(event, 'event') }, new Date('2026-10-13T20:50:00Z'));
    expect(off).toMatchObject({ onCredits: false, enabled: false, until: null });
    expect(creditsUsable(off, Date.parse('2026-10-13T20:50:00Z'))).toBe(false);
    const reached = { rate_limits: { seven_day: { utilization: 100, resets_at: '2026-10-15T13:00:00Z' }, extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 5000, currency: 'EUR', decimal_places: 2, spend_limit_reached: true } } };
    const latest: UsageReadingFields = { fiveHourPct: 10, fiveHourResetsAt: '2026-10-13T23:00:00Z', sevenDayPct: 100, sevenDayResetsAt: '2026-10-15T13:00:00Z' };
    expect(accountCredits({ event: null, getUsage: { raw: reached, at: '2026-10-13T21:00:00Z' }, latest }, NOW)).toMatchObject({ onCredits: false, limitReached: true, left: 0 });
  });

  it('under the limit with credits enabled: not on credits, but usable; the warning event says enabled', async () => {
    const event = await fixture('rate-limit-warning');
    const credits = accountCredits({ event: { raw: event, at: '2026-10-13T21:13:00Z' }, getUsage: null, latest: fieldsOf(event, 'event') }, NOW);
    expect(credits).toMatchObject({ onCredits: false, enabled: true, limit: null, left: null });
    expect(creditsUsable(credits, NOW.getTime())).toBe(true);
    expect(creditsMoneyText(credits)).toBe('credits enabled · balance unknown');
  });

  it('nothing about credits in either reading → null (unknown, never guessed)', () => {
    const latest: UsageReadingFields = { fiveHourPct: 100, fiveHourResetsAt: '2026-10-13T23:00:00Z', sevenDayPct: 10, sevenDayResetsAt: '2026-10-15T13:00:00Z' };
    expect(accountCredits({ event: { raw: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }, at: '2026-10-13T21:00:00Z' }, getUsage: null, latest }, NOW)).toBeNull();
  });
});

describe('D103 credits: the money text', () => {
  it('"€12.40 left of €50", the low share, the unknowns', async () => {
    const getUsage = await fixture('get-usage-credits');
    const credits = accountCredits({ event: null, getUsage: { raw: getUsage, at: '2026-10-13T21:10:00Z' }, latest: fieldsOf(getUsage, 'get_usage') }, NOW);
    expect(creditsMoneyText(credits)).toBe('€12.40 left of €50');
    expect(creditsLeftPct(credits)).toBeCloseTo(24.8, 5);
    expect(formatMoney(12.4, 'USD')).toBe('US$12.40');
    expect(formatMoney(3, null)).toBe('3');
    expect(creditsMoneyText(null)).toBeNull();
    expect(creditsMoneyText({ onCredits: false, until: null, enabled: false, currency: null, limit: null, used: null, left: null, resetsAt: null, limitReached: false, at: null })).toBe('credits off');
  });

  it('reads a paired machine\'s credit state defensively (D98)', () => {
    expect(readAccountCredits({ onCredits: true, until: '2026-10-15T13:00:00Z', enabled: true, currency: 'EUR', limit: 50, used: 37.6, left: 12.4, resetsAt: 'x', at: null })).toMatchObject({ onCredits: true, currency: 'EUR', left: 12.4, resetsAt: null });
    expect(readAccountCredits({ onCredits: 'yes' })).toBeNull();
    expect(readAccountCredits({ onCredits: false, limit: -5, currency: 'euro' })).toMatchObject({ limit: null, currency: null });
  });
});
