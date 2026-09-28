import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UsageWarning } from '../../src/core/api.ts';
import { type ControlResponseMessage, type RateLimitMessage, parseStreamLine } from '../../src/core/stream-json.ts';
import {
  DEFAULT_WARN_AT_PCT,
  type GetUsageOutcome,
  type UsageReadingFields,
  activeWarnings,
  dueWarnings,
  getUsageLine,
  normalizePct,
  readWarnedState,
  readingFromGetUsage,
  readingFromRateLimit,
  systemUsageFields,
  usageState,
  validWindows,
  warnThreshold,
} from '../../src/core/usage.ts';
import { REPO_ROOT } from '../helpers/net.ts';

/**
 * M9.2 oracle, the rules (src/core/usage.ts, docs/usage.md): the recorded
 * `usage-ctl` / `usage-turn` payloads (M0.3), the max rule, every unknown case and
 * the warning firing once per window until its reset, all on a fake clock.
 */

const FIXTURES = path.join(REPO_ROOT, 'tools', 'fake-claude', 'fixtures');

async function stdoutOf(name: string) {
  const text = await readFile(path.join(FIXTURES, `${name}.ndjson`), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => parseStreamLine(line));
}

async function stdinOf(name: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path.join(FIXTURES, `${name}.stdin.ndjson`), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The recorded `control_response`s answering `get_usage` in a fixture. */
async function getUsageResponses(name: string): Promise<ControlResponseMessage[]> {
  const ids = (await stdinOf(name))
    .filter((line) => (line['request'] as { subtype?: string } | undefined)?.subtype === 'get_usage')
    .map((line) => line['request_id']);
  return (await stdoutOf(name)).filter((m): m is ControlResponseMessage => m.kind === 'control-response' && ids.includes(m.requestId));
}

/** 21:20Z on the probe day: both recorded windows are still ahead. */
const PROBE_TIME = new Date('2026-09-27T21:20:00.000Z');
const FIVE_RESET = '2026-09-27T23:40:00.290Z';
const SEVEN_RESET = '2026-10-01T13:00:00.290Z';

function respond(response: unknown, subtype = 'success', error: string | null = null): GetUsageOutcome {
  return { kind: 'response', message: { subtype, response: response as ControlResponseMessage['response'], error, raw: { type: 'control_response' } } };
}

function limits(fiveHour: unknown, sevenDay: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { subscription_type: 'max', rate_limits_available: true, rate_limits: { five_hour: fiveHour, seven_day: sevenDay }, ...extra };
}

function reading(fiveHourPct: number | null, fiveHourResetsAt: string | null, sevenDayPct: number | null, sevenDayResetsAt: string | null): UsageReadingFields {
  return { fiveHourPct, fiveHourResetsAt, sevenDayPct, sevenDayResetsAt };
}

describe('readings from the recorded payloads (M0.3)', () => {
  it('usage-ctl get_usage: 5-hour 10 % and weekly 18 % (0–100) with their resets as ISO', async () => {
    const [response] = await getUsageResponses('usage-ctl');
    const parsed = readingFromGetUsage({ kind: 'response', message: response as ControlResponseMessage });
    expect(parsed).toMatchObject({
      source: 'get_usage',
      fiveHourPct: 10,
      fiveHourResetsAt: FIVE_RESET,
      sevenDayPct: 18,
      sevenDayResetsAt: SEVEN_RESET,
      unknown: null,
    });
    expect((parsed.raw as { rate_limits_available?: unknown }).rate_limits_available).toBe(true);
  });

  it('usage-turn: both get_usage answers and the turn’s rate_limit_event (fraction × 100) read the same 10 / 18', async () => {
    const responses = await getUsageResponses('usage-turn');
    expect(responses).toHaveLength(2);
    for (const response of responses) {
      expect(readingFromGetUsage({ kind: 'response', message: response })).toMatchObject({ fiveHourPct: 10, sevenDayPct: 18, unknown: null });
    }
    const event = (await stdoutOf('usage-turn')).find((m): m is RateLimitMessage => m.kind === 'rate-limit');
    expect(event).toBeDefined();
    const fromEvent = readingFromRateLimit(event as RateLimitMessage);
    expect(fromEvent).toMatchObject({
      source: 'rate_limit_event',
      fiveHourPct: 10,
      fiveHourResetsAt: '2026-09-27T23:40:00.000Z',
      sevenDayPct: 18,
      sevenDayResetsAt: '2026-10-01T13:00:00.000Z',
      unknown: null,
    });
    expect(usageState(fromEvent, PROBE_TIME)).toMatchObject({ known: true, pct: 18, window: 'seven_day' });
  });

  it('the stdin request is the recorded one: get_usage with skip_behaviors (request id aside)', async () => {
    const [recorded] = (await stdinOf('usage-ctl')).filter((line) => (line['request'] as { subtype?: string }).subtype === 'get_usage');
    expect(getUsageLine('sb-usage-1')).toEqual({ ...recorded, request_id: 'sb-usage-1' });
  });

  it('fractions become clean percentages: float noise rounded, capped at 100, negatives are not a reading', () => {
    expect(normalizePct(0.29 * 100)).toBe(29);
    expect(normalizePct(12.345)).toBe(12.35);
    expect(normalizePct(104)).toBe(100);
    expect(normalizePct(-1)).toBeNull();
    expect(normalizePct(Number.NaN)).toBeNull();
    const event = { raw: {}, fiveHour: { utilization: 0.29, resetsAt: 1790552400 }, sevenDay: { utilization: 0.5, resetsAt: 1790859600 } };
    expect(readingFromRateLimit(event)).toMatchObject({ fiveHourPct: 29, sevenDayPct: 50 });
  });
});

describe('usagePct: the max rule', () => {
  it('is the higher window, with that window’s reset', () => {
    expect(usageState(reading(10, FIVE_RESET, 18, SEVEN_RESET), PROBE_TIME)).toEqual({
      known: true,
      pct: 18,
      window: 'seven_day',
      resetsAt: SEVEN_RESET,
      windows: { five_hour: { pct: 10, resetsAt: FIVE_RESET }, seven_day: { pct: 18, resetsAt: SEVEN_RESET } },
    });
    expect(usageState(reading(62, FIVE_RESET, 18, SEVEN_RESET), PROBE_TIME)).toMatchObject({ known: true, pct: 62, window: 'five_hour', resetsAt: FIVE_RESET });
  });

  it('a tie is the window that resets later (it binds longer)', () => {
    expect(usageState(reading(40, FIVE_RESET, 40, SEVEN_RESET), PROBE_TIME)).toMatchObject({ pct: 40, window: 'seven_day', resetsAt: SEVEN_RESET });
    // Not a real Max shape, but the rule holds either way round.
    expect(usageState(reading(40, SEVEN_RESET, 40, FIVE_RESET), PROBE_TIME)).toMatchObject({ pct: 40, window: 'five_hour', resetsAt: SEVEN_RESET });
  });

  it('GET /api/system fields: usagePct + usageResetsAt when known, nothing when unknown, warnings only when any', () => {
    expect(systemUsageFields(usageState(reading(10, FIVE_RESET, 18, SEVEN_RESET), PROBE_TIME), [])).toEqual({ usagePct: 18, usageResetsAt: SEVEN_RESET });
    const unknown = systemUsageFields(usageState(null, PROBE_TIME), []);
    expect(unknown).toEqual({});
    expect('usagePct' in unknown).toBe(false);
    const warning: UsageWarning = { window: 'five_hour', pct: 91, threshold: 90, resetsAt: FIVE_RESET, firedAt: PROBE_TIME.toISOString() };
    expect(systemUsageFields(usageState(null, PROBE_TIME), [warning])).toEqual({ usageWarnings: [warning] });
  });
});

describe('usagePct: every unknown case (omitted, never invented)', () => {
  const good = { utilization: 10, resets_at: '2026-09-27T23:40:00.290507+00:00' };
  const cases: Array<[string, GetUsageOutcome, string]> = [
    ['get_usage answered with an error', respond(null, 'error', 'Unsupported control request subtype: get_usage'), 'error'],
    ['no answer at all (timeout, exit, missing CLI)', { kind: 'failed', error: 'claude exited (code 1) without answering get_usage' }, 'error'],
    ['rate_limits_available is false', respond(limits(good, good, { rate_limits_available: false })), 'unavailable'],
    ['rate_limits is null', respond({ rate_limits_available: true, rate_limits: null }), 'missing'],
    ['the five-hour window is null', respond(limits(null, good)), 'missing'],
    ['the weekly window is null', respond(limits(good, null)), 'missing'],
    ['a utilization is null', respond(limits({ utilization: null, resets_at: good.resets_at }, good)), 'missing'],
    ['a resets_at is null', respond(limits(good, { utilization: 18, resets_at: null })), 'missing'],
    ['the response is not an object', respond('usage'), 'shape'],
    ['rate_limits_available is missing', respond({ rate_limits: { five_hour: good, seven_day: good } }), 'shape'],
    ['rate_limits is a list', respond({ rate_limits_available: true, rate_limits: [good, good] }), 'shape'],
    ['a window is not an object', respond(limits(10, good)), 'shape'],
    ['a utilization is a string', respond(limits({ utilization: '10', resets_at: good.resets_at }, good)), 'shape'],
    ['a utilization is negative', respond(limits({ utilization: -3, resets_at: good.resets_at }, good)), 'shape'],
    ['a resets_at is not a date', respond(limits(good, { utilization: 18, resets_at: 'soon' })), 'shape'],
    ['a resets_at is a number', respond(limits(good, { utilization: 18, resets_at: 1790859600 })), 'shape'],
  ];
  for (const [what, outcome, reason] of cases) {
    it(`${what} → unknown (${reason})`, () => {
      const parsed = readingFromGetUsage(outcome);
      expect(parsed.unknown).toBe(reason);
      expect(parsed.source).toBe('get_usage');
      const state = usageState(parsed, PROBE_TIME);
      expect(state.known).toBe(false);
      expect(systemUsageFields(state, [])).toEqual({});
    });
  }

  it('one bad window keeps the good one (it can still warn), but usagePct stays unknown', () => {
    const parsed = readingFromGetUsage(respond(limits(good, null)));
    expect(parsed).toMatchObject({ fiveHourPct: 10, sevenDayPct: null });
    expect(validWindows(parsed, PROBE_TIME)).toEqual({ five_hour: { pct: 10, resetsAt: FIVE_RESET } });
    expect(usageState(parsed, PROBE_TIME)).toEqual({ known: false, reason: 'missing' });
  });

  it('a rate_limit_event without a window or utilization → unknown', () => {
    const parsed = readingFromRateLimit({ raw: {}, fiveHour: { utilization: null, resetsAt: 1790552400 }, sevenDay: null });
    expect(parsed).toMatchObject({ fiveHourPct: null, sevenDayPct: null, unknown: 'missing' });
    expect(usageState(parsed, PROBE_TIME)).toEqual({ known: false, reason: 'missing' });
  });

  it('no reading yet → unknown (none)', () => {
    expect(usageState(null, PROBE_TIME)).toEqual({ known: false, reason: 'none' });
  });

  it('a window whose resets_at has passed without a newer reading → unknown (expired), from that instant on', () => {
    const last = reading(10, FIVE_RESET, 18, SEVEN_RESET);
    expect(usageState(last, new Date(Date.parse(FIVE_RESET) - 1)).known).toBe(true);
    expect(usageState(last, new Date(FIVE_RESET))).toEqual({ known: false, reason: 'expired' });
    expect(usageState(last, new Date('2026-09-28T06:00:00.000Z'))).toEqual({ known: false, reason: 'expired' });
    expect(usageState(last, new Date('2026-10-02T00:00:00.000Z'))).toEqual({ known: false, reason: 'expired' });
  });

  it('a stored reading with a bad value (older rows, other writers) is unknown, not trusted', () => {
    expect(usageState(reading(-5, FIVE_RESET, 18, SEVEN_RESET), PROBE_TIME)).toEqual({ known: false, reason: 'shape' });
    expect(usageState(reading(10, 'later', 18, SEVEN_RESET), PROBE_TIME)).toEqual({ known: false, reason: 'shape' });
  });
});

describe('usage warnings: once per window until its resets_at (just warn)', () => {
  const T = PROBE_TIME;
  const at = (iso: string): Date => new Date(iso);

  it('fires when a window reaches the threshold, once; later readings of the same window do not fire again', () => {
    const first = dueWarnings(reading(91, FIVE_RESET, 40, SEVEN_RESET), {}, 90, T);
    expect(first.fire).toEqual([{ window: 'five_hour', pct: 91, threshold: 90, resetsAt: FIVE_RESET, firedAt: T.toISOString() }]);
    expect(first.warned).toEqual({ five_hour: first.fire[0] });

    const again = dueWarnings(reading(91, FIVE_RESET, 40, SEVEN_RESET), first.warned, 90, at('2026-09-27T21:21:00.000Z'));
    expect(again.fire).toEqual([]);
    const higher = dueWarnings(reading(97, FIVE_RESET, 40, SEVEN_RESET), again.warned, 90, at('2026-09-27T22:00:00.000Z'));
    expect(higher.fire).toEqual([]);
    expect(higher.warned).toEqual(first.warned);
  });

  it('fires again only after that window reset, for the new window', () => {
    const { warned } = dueWarnings(reading(91, FIVE_RESET, 40, SEVEN_RESET), {}, 90, T);
    const nextReset = '2026-09-28T04:40:00.000Z';
    // Right after the reset: the old warning is out of force; a new window at 92 % warns again.
    const after = dueWarnings(reading(92, nextReset, 45, SEVEN_RESET), warned, 90, at('2026-09-27T23:45:00.000Z'));
    expect(after.fire).toEqual([{ window: 'five_hour', pct: 92, threshold: 90, resetsAt: nextReset, firedAt: '2026-09-27T23:45:00.000Z' }]);
    // A reset window below the threshold only drops the old warning.
    const calm = dueWarnings(reading(5, nextReset, 45, SEVEN_RESET), warned, 90, at('2026-09-27T23:45:00.000Z'));
    expect(calm).toEqual({ fire: [], warned: {} });
  });

  it('each window warns on its own; exactly the threshold counts as reaching it', () => {
    const both = dueWarnings(reading(95, FIVE_RESET, 90, SEVEN_RESET), {}, 90, T);
    expect(both.fire.map((w) => [w.window, w.pct])).toEqual([
      ['five_hour', 95],
      ['seven_day', 90],
    ]);
    const weeklyLater = dueWarnings(reading(95, FIVE_RESET, 93, SEVEN_RESET), { five_hour: both.fire[0] as UsageWarning }, 90, T);
    expect(weeklyLater.fire.map((w) => w.window)).toEqual(['seven_day']);
  });

  it('no warning below the threshold, for an unknown or expired window, or from nothing', () => {
    expect(dueWarnings(reading(89.99, FIVE_RESET, 40, SEVEN_RESET), {}, 90, T).fire).toEqual([]);
    expect(dueWarnings(reading(null, null, 40, SEVEN_RESET), {}, 90, T).fire).toEqual([]);
    expect(dueWarnings(reading(99, FIVE_RESET, 40, SEVEN_RESET), {}, 90, at('2026-09-28T00:00:00.000Z')).fire).toEqual([]);
    expect(dueWarnings(null, {}, 90, T)).toEqual({ fire: [], warned: {} });
  });

  it('the threshold is Settings usage.warnAtPct (a whole 1–100), default 90', () => {
    expect(DEFAULT_WARN_AT_PCT).toBe(90);
    expect(warnThreshold(80)).toBe(80);
    expect(warnThreshold(100)).toBe(100);
    for (const bad of [undefined, null, 0, 101, 1.5, '85', Number.NaN]) expect(warnThreshold(bad)).toBe(90);
    expect(dueWarnings(reading(85, FIVE_RESET, 40, SEVEN_RESET), {}, warnThreshold(80), T).fire.map((w) => w.threshold)).toEqual([80]);
  });

  it('warnings in force are those whose window has not reset; the stored state is read defensively', () => {
    const five: UsageWarning = { window: 'five_hour', pct: 91, threshold: 90, resetsAt: FIVE_RESET, firedAt: T.toISOString() };
    const seven: UsageWarning = { window: 'seven_day', pct: 90, threshold: 90, resetsAt: SEVEN_RESET, firedAt: T.toISOString() };
    expect(activeWarnings({ five_hour: five, seven_day: seven }, T)).toEqual([five, seven]);
    expect(activeWarnings({ five_hour: five, seven_day: seven }, at('2026-09-28T00:00:00.000Z'))).toEqual([seven]);
    expect(readWarnedState(JSON.parse(JSON.stringify({ five_hour: five, seven_day: seven })))).toEqual({ five_hour: five, seven_day: seven });
    expect(readWarnedState(null)).toEqual({});
    expect(readWarnedState([five])).toEqual({});
    expect(readWarnedState({ five_hour: { ...five, resetsAt: 'never' }, seven_day: { pct: '90' }, other: five })).toEqual({});
  });
});
