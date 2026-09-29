import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UsageWarning } from '../../src/core/api.ts';
import { type ControlResponseMessage, type RateLimitMessage, parseStreamLine } from '../../src/core/stream-json.ts';
import {
  DEFAULT_WARN_AT_PCT,
  type GetUsageOutcome,
  PACE_DAY_MS,
  PACE_MINUTE_MS,
  SESSION_MINUTES,
  type ModelWindowReading,
  type UsageReadingFields,
  activeWarnings,
  dueWarnings,
  getUsageLine,
  modelWindowsFromGetUsage,
  normalizePct,
  readWarnedState,
  readingFromGetUsage,
  readingFromRateLimit,
  sessionPace,
  systemUsageFields,
  usageState,
  usageWindowLabel,
  usageWindows,
  validWindows,
  warnThreshold,
  weeklyPace,
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

describe('D17: usage windows (Session, Week, a model row while in use)', () => {
  const T = PROBE_TIME;
  const FABLE_RESET = '2026-10-01T13:00:00.000Z';
  const SESSION = { key: 'session', label: 'Session', pct: 10, resetsAt: FIVE_RESET } as const;
  const WEEK = { key: 'week', label: 'Week', pct: 18, resetsAt: SEVEN_RESET } as const;

  /** A get_usage answer with the recorded windows and these model-scoped entries / limits. */
  function withModels(modelScoped: unknown, limitList: unknown): Record<string, unknown> {
    const base = limits({ utilization: 10, resets_at: '2026-09-27T23:40:00.290507+00:00' }, { utilization: 18, resets_at: '2026-10-01T13:00:00.290537+00:00' });
    return { ...base, rate_limits: { ...(base['rate_limits'] as Record<string, unknown>), model_scoped: modelScoped, limits: limitList } };
  }

  function fableLimit(percent: number, isActive: boolean): Record<string, unknown> {
    return { kind: 'weekly_scoped', group: 'weekly', percent, resets_at: '2026-10-01T13:00:00+00:00', is_active: isActive, scope: { model: { id: null, display_name: 'Fable' }, surface: null } };
  }

  it('the recorded usage-ctl answer: Session 10 % and Week 18 %; Fable is listed at 0 % and not active, so it has no row', async () => {
    const [response] = await getUsageResponses('usage-ctl');
    const parsed = readingFromGetUsage({ kind: 'response', message: response as ControlResponseMessage });
    const models = modelWindowsFromGetUsage(parsed.raw);
    expect(models).toEqual([{ model: 'Fable', pct: 0, resetsAt: FABLE_RESET, isActive: false }]);
    expect(usageWindows(parsed, models, T)).toEqual([SESSION, WEEK]);
  });

  it('a model window gets a row while it is in use: above 0 %, or active at 0 %', () => {
    const inUse = modelWindowsFromGetUsage(withModels([{ display_name: 'Fable', utilization: 35, resets_at: '2026-10-01T13:00:00+00:00' }], [fableLimit(35, false)]));
    expect(usageWindows(reading(10, FIVE_RESET, 18, SEVEN_RESET), inUse, T)).toEqual([
      SESSION,
      WEEK,
      { key: 'model', label: 'Fable', pct: 35, resetsAt: FABLE_RESET, model: 'Fable' },
    ]);
    const active = modelWindowsFromGetUsage(withModels([{ display_name: 'Fable', utilization: 0, resets_at: '2026-10-01T13:00:00+00:00' }], [fableLimit(0, true)]));
    expect(usageWindows(reading(10, FIVE_RESET, 18, SEVEN_RESET), active, T).map((w) => [w.key, w.label, w.pct])).toEqual([
      ['session', 'Session', 10],
      ['week', 'Week', 18],
      ['model', 'Fable', 0],
    ]);
  });

  it('model_scoped and limits are joined by name; a model only in limits is kept; the CLI order is kept', () => {
    const models = modelWindowsFromGetUsage(
      withModels(
        [
          { display_name: 'Fable', utilization: 12.5, resets_at: '2026-10-01T13:00:00+00:00' },
          { display_name: 'Opus', utilization: null, resets_at: null },
        ],
        [fableLimit(99, true), { ...fableLimit(40, false), scope: { model: { display_name: 'Opus' } } }, { ...fableLimit(7, true), scope: { model: { display_name: 'Haiku' } } }],
      ),
    );
    expect(models).toEqual([
      { model: 'Fable', pct: 12.5, resetsAt: FABLE_RESET, isActive: true },
      { model: 'Opus', pct: 40, resetsAt: FABLE_RESET, isActive: false },
      { model: 'Haiku', pct: 7, resetsAt: FABLE_RESET, isActive: true },
    ]);
  });

  it('unknown stays unknown: a malformed, expired or missing model window has no row, and none is guessed', () => {
    const models: ModelWindowReading[] = [
      { model: 'NoPct', pct: null, resetsAt: FABLE_RESET, isActive: true },
      { model: 'NoReset', pct: 50, resetsAt: null, isActive: true },
      { model: 'Expired', pct: 50, resetsAt: '2026-09-27T00:00:00.000Z', isActive: true },
    ];
    expect(usageWindows(reading(10, FIVE_RESET, 18, SEVEN_RESET), models, T)).toEqual([SESSION, WEEK]);
    for (const raw of [
      null,
      { error: 'no answer' },
      { rate_limits_available: false, rate_limits: { model_scoped: [{ display_name: 'Fable', utilization: 50, resets_at: FABLE_RESET }] } },
      { rate_limits_available: true, rate_limits: null },
      withModels('Fable', { kind: 'weekly_scoped' }),
      withModels([{ display_name: '', utilization: 50 }, { utilization: 50 }, 'Fable'], [{ kind: 'weekly_all', percent: 50 }, { kind: 'weekly_scoped', percent: 50, scope: null }]),
    ]) {
      expect(modelWindowsFromGetUsage(raw)).toEqual([]);
    }
    // A string utilization is not a number: that model is unknown.
    expect(modelWindowsFromGetUsage(withModels([{ display_name: 'Fable', utilization: '35', resets_at: FABLE_RESET }], []))).toEqual([
      { model: 'Fable', pct: null, resetsAt: FABLE_RESET, isActive: false },
    ]);
  });

  it('Session and Week are independent: an expired or missing one is left out, the other stays; nothing at all → no field', () => {
    expect(usageWindows(reading(10, FIVE_RESET, 18, SEVEN_RESET), [], new Date(FIVE_RESET))).toEqual([WEEK]);
    expect(usageWindows(reading(null, null, 18, SEVEN_RESET), [], T)).toEqual([WEEK]);
    expect(usageWindows(reading(10, FIVE_RESET, null, null), [], T)).toEqual([SESSION]);
    expect(usageWindows(null, [], T)).toEqual([]);
    expect(systemUsageFields(usageState(null, T), [], [])).toEqual({});
    expect(systemUsageFields(usageState(reading(10, FIVE_RESET, null, null), T), [], [SESSION])).toEqual({ usageWindows: [SESSION] });
  });

  it('usagePct keeps the max rule next to the windows (compatibility)', () => {
    const latest = reading(62, FIVE_RESET, 18, SEVEN_RESET);
    expect(systemUsageFields(usageState(latest, T), [], usageWindows(latest, [], T))).toEqual({
      usagePct: 62,
      usageResetsAt: FIVE_RESET,
      usageWindows: [{ ...SESSION, pct: 62 }, WEEK],
    });
  });

  it('a model window warns at the threshold once until its reset, next to the other two; the state survives storage', () => {
    const fable: ModelWindowReading = { model: 'Fable', pct: 91, resetsAt: FABLE_RESET, isActive: true };
    const first = dueWarnings(reading(10, FIVE_RESET, 18, SEVEN_RESET), {}, 90, T, [fable]);
    const warning: UsageWarning = { window: 'model', model: 'Fable', pct: 91, threshold: 90, resetsAt: FABLE_RESET, firedAt: T.toISOString() };
    expect(first.fire).toEqual([warning]);
    expect(first.warned).toEqual({ model: { Fable: warning } });
    // Again, higher, other windows too: Fable does not repeat, the 5-hour window warns on its own.
    const again = dueWarnings(reading(95, FIVE_RESET, 18, SEVEN_RESET), first.warned, 90, T, [{ ...fable, pct: 97 }]);
    expect(again.fire.map((w) => [w.window, w.model])).toEqual([['five_hour', undefined]]);
    expect(activeWarnings(again.warned, T).map((w) => w.window)).toEqual(['five_hour', 'model']);
    expect(readWarnedState(JSON.parse(JSON.stringify(again.warned)))).toEqual(again.warned);
    // Below the threshold, or unknown: no model warning. After the reset the warning is dropped.
    expect(dueWarnings(null, {}, 90, T, [{ ...fable, pct: 89 }]).fire).toEqual([]);
    expect(dueWarnings(null, {}, 90, T, [{ ...fable, pct: null }]).fire).toEqual([]);
    expect(dueWarnings(null, first.warned, 90, new Date('2026-10-01T13:00:00.000Z'), [])).toEqual({ fire: [], warned: {} });
    expect(readWarnedState({ model: { Fable: { ...warning, resetsAt: 'never' }, '': warning, Opus: 'x' } })).toEqual({});
  });

  it('warning labels: the two Max windows as before, a model one as “<model> weekly limit”', () => {
    expect(usageWindowLabel({ window: 'five_hour' })).toBe('5-hour window');
    expect(usageWindowLabel({ window: 'seven_day' })).toBe('weekly limit');
    expect(usageWindowLabel({ window: 'model', model: 'Fable' })).toBe('Fable weekly limit');
  });
});

describe('D23: weekly pace (the Week window against its daily allowance)', () => {
  // A Thursday 15:00 reset: days Thu 15:00 → Fri 15:00 … Wed 15:00 → Thu 15:00 (UTC instants; the rule is pure time arithmetic).
  const RESET = '2026-10-01T15:00:00.000Z';
  const START = Date.parse('2026-09-24T15:00:00.000Z');
  const at = (iso: string): Date => new Date(iso);
  const pace = (pct: number, now: Date, resetsAt = RESET) => weeklyPace({ pct, resetsAt }, now);

  it('days start at the reset hour: Mon 14:59 is day 4 (57.14 %), Mon 15:00 is day 5 (71.43 %)', () => {
    expect(pace(33, at('2026-09-28T14:59:00.000Z'))).toEqual({ day: 4, allowancePct: 57.14, nextStepAt: '2026-09-28T15:00:00.000Z', onPace: true });
    expect(pace(33, at('2026-09-28T14:59:59.999Z'))).toMatchObject({ day: 4, allowancePct: 57.14 });
    expect(pace(33, at('2026-09-28T15:00:00.000Z'))).toEqual({ day: 5, allowancePct: 71.43, nextStepAt: '2026-09-29T15:00:00.000Z', onPace: true });
  });

  it('each day n allows n × 100 / 7 %, rounded to 2 decimals like the utilization', () => {
    const allowances = [1, 2, 3, 4, 5, 6, 7].map((day) => pace(0, new Date(START + (day - 1) * PACE_DAY_MS + 60_000)));
    expect(allowances.map((p) => [p?.day, p?.allowancePct])).toEqual([
      [1, 14.29],
      [2, 28.57],
      [3, 42.86],
      [4, 57.14],
      [5, 71.43],
      [6, 85.71],
      [7, 100],
    ]);
  });

  it('day 1 starts right at the previous reset; day 7 lasts until just before the next one, whose reset is its next step', () => {
    expect(pace(0, new Date(START))).toEqual({ day: 1, allowancePct: 14.29, nextStepAt: '2026-09-25T15:00:00.000Z', onPace: true });
    expect(pace(3, at('2026-09-24T15:00:00.001Z'))).toMatchObject({ day: 1, allowancePct: 14.29, onPace: true });
    expect(pace(90, at('2026-10-01T14:59:59.999Z'))).toEqual({ day: 7, allowancePct: 100, nextStepAt: RESET, onPace: true });
  });

  it('on pace while below the allowance; at the allowance or above it is not (yellow)', () => {
    const monday = at('2026-09-28T12:00:00.000Z');
    expect(pace(57.13, monday)?.onPace).toBe(true);
    expect(pace(57.14, monday)?.onPace).toBe(false);
    expect(pace(62, monday)?.onPace).toBe(false);
    const tuesday = at('2026-09-29T12:00:00.000Z');
    expect(pace(71.42, tuesday)?.onPace).toBe(true);
    expect(pace(71.43, tuesday)?.onPace).toBe(false);
    const wednesday = at('2026-10-01T12:00:00.000Z');
    expect(pace(99.99, wednesday)?.onPace).toBe(true);
    expect(pace(100, wednesday)?.onPace).toBe(false);
  });

  it('unknown stays unknown: a reset now or past, an unparseable reset, no usable pct, or a reset more than 7 days ahead → null', () => {
    expect(pace(10, at(RESET))).toBeNull();
    expect(pace(10, at('2026-10-02T09:00:00.000Z'))).toBeNull();
    expect(pace(10, at('2026-09-28T12:00:00.000Z'), 'soon')).toBeNull();
    expect(pace(Number.NaN, at('2026-09-28T12:00:00.000Z'))).toBeNull();
    expect(pace(-1, at('2026-09-28T12:00:00.000Z'))).toBeNull();
    expect(pace(10, new Date(START - 1))).toBeNull();
    expect(pace(10, new Date('invalid'))).toBeNull();
  });

  it('across a daylight-saving change the days stay 24 h long, so in local time they start an hour earlier after it', () => {
    // Europe/Warsaw leaves summer time on Sun 2026-10-25 (03:00 CEST → 02:00 CET). A Thu 15:00 CET reset:
    const reset = '2026-10-29T14:00:00.000Z';
    const warsaw = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const steps: string[] = [];
    let now = new Date('2026-10-22T14:00:00.000Z'); // the window's start: 7 × 24 h before the reset (Thu 16:00 CEST)
    for (let day = 1; day <= 7; day++) {
      const p = weeklyPace({ pct: 10, resetsAt: reset }, now);
      expect(p?.day).toBe(day);
      expect(Date.parse(p?.nextStepAt ?? '') - now.getTime()).toBe(PACE_DAY_MS);
      steps.push(warsaw.format(new Date(p?.nextStepAt ?? '')));
      now = new Date(p?.nextStepAt ?? '');
    }
    expect(steps).toEqual(['Fri 16:00', 'Sat 16:00', 'Sun 15:00', 'Mon 15:00', 'Tue 15:00', 'Wed 15:00', 'Thu 15:00']);
    // The step into day 4 is 24 h after the one into day 3, not at 16:00 local.
    expect(weeklyPace({ pct: 10, resetsAt: reset }, new Date('2026-10-25T13:59:59.999Z'))?.day).toBe(3);
    expect(weeklyPace({ pct: 10, resetsAt: reset }, new Date('2026-10-25T14:00:00.000Z'))?.day).toBe(4);
  });
});

describe('D46: session pace (the 5-hour Session window against its allowance, by the minute)', () => {
  // A 16:00 reset: the window runs 11:00 → 16:00 (UTC instants; the rule is pure time arithmetic).
  const RESET = '2026-09-29T16:00:00.000Z';
  const START = Date.parse('2026-09-29T11:00:00.000Z');
  const at = (iso: string): Date => new Date(iso);
  const minute = (m: number, extraMs = 0): Date => new Date(START + m * PACE_MINUTE_MS + extraMs);
  const pace = (pct: number, now: Date, resetsAt = RESET) => sessionPace({ pct, resetsAt }, now);

  it('the window is the 300 minutes before the reset', () => {
    expect(SESSION_MINUTES).toBe(300);
    expect(PACE_MINUTE_MS).toBe(60_000);
  });

  it('at the window start (the reset minus 5 h) nothing is allowed yet; the first step is a minute later', () => {
    expect(pace(0, new Date(START))).toEqual({ minutes: 0, allowancePct: 0, nextStepAt: '2026-09-29T11:01:00.000Z', onPace: false });
    expect(pace(0, minute(0, 59_999))).toMatchObject({ minutes: 0, allowancePct: 0 });
    expect(pace(0, minute(1))).toEqual({ minutes: 1, allowancePct: 0.33, nextStepAt: '2026-09-29T11:02:00.000Z', onPace: true });
  });

  it('in the middle: 150 minutes in, 50 % is allowed until the next minute', () => {
    expect(pace(38, at('2026-09-29T13:30:00.000Z'))).toEqual({ minutes: 150, allowancePct: 50, nextStepAt: '2026-09-29T13:31:00.000Z', onPace: true });
    expect(pace(62, at('2026-09-29T13:30:30.000Z'))).toEqual({ minutes: 150, allowancePct: 50, nextStepAt: '2026-09-29T13:31:00.000Z', onPace: false });
  });

  it('at the end: the last minute allows 99.67 % and its next step is the reset itself', () => {
    expect(pace(90, minute(299))).toEqual({ minutes: 299, allowancePct: 99.67, nextStepAt: RESET, onPace: true });
    expect(pace(90, at('2026-09-29T15:59:59.999Z'))).toEqual({ minutes: 299, allowancePct: 99.67, nextStepAt: RESET, onPace: true });
    expect(pace(100, at('2026-09-29T15:59:59.999Z'))?.onPace).toBe(false);
  });

  it('minutes elapsed × 100 / 300, rounded to 2 decimals like the utilization (and like D23)', () => {
    expect([1, 2, 3, 100, 150, 200, 298, 299].map((m) => pace(0, minute(m))?.allowancePct)).toEqual([0.33, 0.67, 1, 33.33, 50, 66.67, 99.33, 99.67]);
  });

  it('steps once a minute, counted from the window start, not from the clock: a reset at :20 s steps at :20 s', () => {
    expect(pace(10, at('2026-09-29T13:30:59.999Z'))).toMatchObject({ minutes: 150, allowancePct: 50 });
    expect(pace(10, at('2026-09-29T13:31:00.000Z'))).toMatchObject({ minutes: 151, allowancePct: 50.33, nextStepAt: '2026-09-29T13:32:00.000Z' });
    const reset = '2026-09-29T16:00:20.000Z';
    expect(pace(10, at('2026-09-29T13:31:19.999Z'), reset)).toMatchObject({ minutes: 150, allowancePct: 50, nextStepAt: '2026-09-29T13:31:20.000Z' });
    expect(pace(10, at('2026-09-29T13:31:20.000Z'), reset)).toMatchObject({ minutes: 151, allowancePct: 50.33, nextStepAt: '2026-09-29T13:32:20.000Z' });
    // Every minute of the window steps by one: 300 steps, from 0 to 99.67.
    const steps = new Set(Array.from({ length: SESSION_MINUTES }, (_, m) => pace(0, minute(m, 30_000))?.allowancePct));
    expect(steps.size).toBe(SESSION_MINUTES);
  });

  it('on pace while below the allowance; exactly at the allowance (as shown) or above it is not (yellow)', () => {
    const half = at('2026-09-29T13:30:00.000Z');
    expect(pace(49.99, half)?.onPace).toBe(true);
    expect(pace(50, half)?.onPace).toBe(false);
    expect(pace(50.01, half)?.onPace).toBe(false);
    // The rounded allowance is the one compared: 1 minute in allows 0.33 %, so 0.33 % is at it.
    expect(pace(0.32, minute(1))?.onPace).toBe(true);
    expect(pace(0.33, minute(1))?.onPace).toBe(false);
    // Over 100 % reads as 100 % (normalizePct), never on pace.
    expect(pace(104, minute(299))).toMatchObject({ allowancePct: 99.67, onPace: false });
  });

  it('unknown stays unknown: a reset now or past, more than 5 h ahead, unparseable, or no usable pct → null', () => {
    expect(pace(10, at(RESET))).toBeNull();
    expect(pace(10, at('2026-09-29T16:00:00.001Z'))).toBeNull();
    expect(pace(10, at('2026-09-29T18:00:00.000Z'))).toBeNull();
    expect(pace(10, new Date(START - 1))).toBeNull();
    expect(pace(10, at('2026-09-29T06:00:00.000Z'))).toBeNull();
    expect(pace(10, at('2026-09-29T13:30:00.000Z'), 'soon')).toBeNull();
    expect(pace(Number.NaN, at('2026-09-29T13:30:00.000Z'))).toBeNull();
    expect(pace(-1, at('2026-09-29T13:30:00.000Z'))).toBeNull();
    expect(pace(10, new Date('invalid'))).toBeNull();
    // Exactly 5 h ahead is the window's start, not outside it.
    expect(pace(10, new Date(START))?.minutes).toBe(0);
  });
});
