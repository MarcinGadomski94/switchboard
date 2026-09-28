import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UsageWarning, UsageWindow } from '../../../src/core/api.ts';
import type { ControlRequestLine } from '../../../src/core/stdin.ts';
import type { ControlResponseMessage } from '../../../src/core/stream-json.ts';
import type { GetUsageOutcome } from '../../../src/core/usage.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { READING_RETENTION_MS, UsageMeter, type UsageMeterOptions, type UsageSessions, WARNED_SETTING } from '../../../src/server/usage/meter.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * M9.2 oracle, the meter's limits on a fake clock (src/server/usage/meter.ts):
 * live `get_usage` at most once per 60 s and only between turns, the poller only
 * with a viewer and no live session, at most once per 5 min and not while a
 * reading of that age exists, and the warning firing once (also across a
 * restart). Sessions and the poller are doubles here; the real ones run in
 * live.test.ts and poller.test.ts.
 */

const START = Date.parse('2026-09-27T21:20:00.000Z');
const FIVE_RESET = '2026-09-27T23:40:00.290Z';
const SEVEN_RESET = '2026-10-01T13:00:00.290Z';
const SEC = 1_000;
const MIN = 60 * SEC;

/** D17: the Session and Week windows of a reading with the two recorded resets. */
function windows(five: number, seven: number): UsageWindow[] {
  return [
    { key: 'session', label: 'Session', pct: five, resetsAt: FIVE_RESET },
    { key: 'week', label: 'Week', pct: seven, resetsAt: SEVEN_RESET },
  ];
}

function usageResponse(fiveHour: number, sevenDay: number, fiveReset = '2026-09-27T23:40:00.290507+00:00'): Record<string, unknown> {
  return {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: fiveHour, resets_at: fiveReset },
      seven_day: { utilization: sevenDay, resets_at: '2026-10-01T13:00:00.290537+00:00' },
    },
  };
}

function controlResponse(requestId: string, response: Record<string, unknown>): ControlResponseMessage {
  return { kind: 'control-response', requestId, subtype: 'success', response, error: null, raw: {}, uuid: null, sessionId: null };
}

/** A supervisor double: `live` sessions, `idle` of them between turns, `answer` = what get_usage returns. */
class FakeSessions implements UsageSessions {
  live: string[] = [];
  idle: string[] = [];
  answer: Record<string, unknown> | null = usageResponse(10, 18);
  readonly requests: Array<{ sessionId: string; line: ControlRequestLine; timeoutMs: number }> = [];
  get liveCount(): number {
    return this.live.length;
  }
  idleLiveSessionIds(): string[] {
    return [...this.idle];
  }
  async controlRequest(sessionId: string, line: ControlRequestLine, timeoutMs: number): Promise<ControlResponseMessage | null> {
    this.requests.push({ sessionId, line, timeoutMs });
    return this.answer ? controlResponse(line.request_id, this.answer) : null;
  }
}

class FakePoller {
  calls = 0;
  outcome: GetUsageOutcome = { kind: 'response', message: controlResponse('p', usageResponse(10, 18)) };
  async getUsage(): Promise<GetUsageOutcome> {
    this.calls += 1;
    return this.outcome;
  }
}

let dir: string;
let store: Store;
let now: number;
let sessions: FakeSessions;
let poller: FakePoller;
let viewers: number;
let warnings: UsageWarning[];
let sessionId: string;

const clock = (): Date => new Date(now);

function meter(options: Partial<UsageMeterOptions> = {}): UsageMeter {
  return new UsageMeter({
    store,
    sessions,
    poller,
    viewers: () => viewers,
    now: clock,
    onWarning: (warning) => warnings.push(warning),
    onError: (error) => {
      throw error;
    },
    ...options,
  });
}

beforeEach(async () => {
  dir = await makeTempDir('usage-meter');
  now = START;
  store = await openTempStore(dir, { now: clock });
  sessionId = (await store.sessions.create({ name: 'usage-session', claudeSessionId: 'c-usage' })).id;
  sessions = new FakeSessions();
  poller = new FakePoller();
  viewers = 1;
  warnings = [];
});

afterEach(async () => {
  await store.close();
  await removeTempDir(dir);
});

describe('UsageMeter · poll limits', () => {
  it('reads nothing while no /hub client is connected (nobody sees the meter)', async () => {
    viewers = 0;
    sessions.live = [sessionId];
    sessions.idle = [sessionId];
    const m = meter();
    expect(await m.tick()).toBeNull();
    sessions.live = [];
    expect(await m.tick()).toBeNull();
    expect(sessions.requests).toEqual([]);
    expect(poller.calls).toBe(0);
    expect(await store.usage.latest()).toBeNull();
  });

  it('live session between turns: get_usage over its stdin, at most once per 60 s', async () => {
    sessions.live = [sessionId];
    sessions.idle = [sessionId];
    const m = meter();
    expect(await m.tick()).toBe('live');
    expect(sessions.requests).toHaveLength(1);
    const [first] = sessions.requests;
    expect(first?.sessionId).toBe(sessionId);
    expect(first?.line.request).toEqual({ subtype: 'get_usage', skip_behaviors: true });
    expect(first?.line.request_id).toMatch(/^sb-usage-/);
    expect(await store.usage.latest()).toMatchObject({
      source: 'get_usage',
      sessionId,
      receivedAt: new Date(START).toISOString(),
      fiveHourPct: 10,
      fiveHourResetsAt: FIVE_RESET,
      sevenDayPct: 18,
      sevenDayResetsAt: SEVEN_RESET,
    });

    now = START + 59 * SEC;
    expect(await m.tick()).toBeNull();
    now = START + 60 * SEC;
    expect(await m.tick()).toBe('live');
    expect(sessions.requests).toHaveLength(2);
    expect(poller.calls).toBe(0);
  });

  it('every live session mid-turn: no request (their turns bring rate_limit_events) and no poller', async () => {
    sessions.live = [sessionId];
    sessions.idle = [];
    const m = meter();
    expect(await m.tick()).toBeNull();
    now += 10 * MIN;
    expect(await m.tick()).toBeNull();
    expect(sessions.requests).toEqual([]);
    expect(poller.calls).toBe(0);
  });

  it('no live session: the poller, at most once per 5 min', async () => {
    const m = meter();
    expect(await m.tick()).toBe('poller');
    expect(await store.usage.latest()).toMatchObject({ source: 'get_usage', sessionId: null, fiveHourPct: 10, sevenDayPct: 18 });
    now = START + 4 * MIN + 59 * SEC;
    expect(await m.tick()).toBeNull();
    now = START + 5 * MIN;
    expect(await m.tick()).toBe('poller');
    expect(poller.calls).toBe(2);
    expect(sessions.requests).toEqual([]);
  });

  it('no poller while a reading younger than 5 min exists (a live session or a turn just read it)', async () => {
    await store.usage.add({ source: 'rate_limit_event', sessionId, receivedAt: new Date(START - 2 * MIN).toISOString(), fiveHourPct: 10, fiveHourResetsAt: FIVE_RESET, sevenDayPct: 18, sevenDayResetsAt: SEVEN_RESET });
    const m = meter();
    expect(await m.tick()).toBeNull();
    now = START + 3 * MIN;
    expect(await m.tick()).toBe('poller');
    expect(poller.calls).toBe(1);
  });

  it('overlapping ticks share one run (one request, not two)', async () => {
    const m = meter();
    const [a, b] = await Promise.all([m.tick(), m.tick()]);
    expect([a, b]).toEqual(['poller', 'poller']);
    expect(poller.calls).toBe(1);
  });

  it('a failed read is stored as unknown: usagePct is omitted until a good reading', async () => {
    sessions.live = [sessionId];
    sessions.idle = [sessionId];
    const m = meter();
    await m.tick();
    expect((await m.systemFields()).usagePct).toBe(18);

    sessions.answer = null;
    now = START + MIN;
    expect(await m.tick()).toBe('live');
    expect(await store.usage.latest()).toMatchObject({ fiveHourPct: null, sevenDayPct: null, raw: { error: 'no get_usage answer from the live session' } });
    expect(await m.systemFields()).toEqual({});

    sessions.live = [];
    poller.outcome = { kind: 'failed', error: 'could not start claude: spawn claude ENOENT' };
    now = START + 10 * MIN;
    expect(await m.tick()).toBe('poller');
    expect(await store.usage.latest()).toMatchObject({ sessionId: null, fiveHourPct: null, raw: { error: 'could not start claude: spawn claude ENOENT' } });
    expect(await m.state()).toEqual({ known: false, reason: 'missing' });
  });

  it('start() ticks at once and then on its interval; stop() waits for the running tick', async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: FakePoller = Object.assign(new FakePoller(), {
      async getUsage(): Promise<GetUsageOutcome> {
        calls += 1;
        await gate;
        return { kind: 'response', message: controlResponse('p', usageResponse(10, 18)) } as const;
      },
    });
    const m = meter({ poller: slow, tickMs: 20 });
    m.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toBe(1);
    const stopped = m.stop();
    release();
    await stopped;
    expect(await store.usage.latest()).toMatchObject({ fiveHourPct: 10 });
    const before = calls;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toBe(before);
  });

  it('prunes readings older than a day (only the newest one drives the meter)', async () => {
    await store.usage.add({ source: 'rate_limit_event', receivedAt: new Date(START - READING_RETENTION_MS - MIN).toISOString(), fiveHourPct: 1 });
    await store.usage.add({ source: 'rate_limit_event', receivedAt: new Date(START - MIN).toISOString(), fiveHourPct: 2 });
    viewers = 0;
    await meter().tick();
    expect((await store.usage.list()).map((r) => r.fiveHourPct)).toEqual([2]);
  });
});

describe('UsageMeter · usagePct on /api/system', () => {
  it('the max of the two windows with its reset; unknown once a window reset passed', async () => {
    const m = meter();
    expect(await m.systemFields()).toEqual({});
    await m.tick();
    expect(await m.systemFields()).toEqual({ usagePct: 18, usageResetsAt: SEVEN_RESET, usageWindows: windows(10, 18) });
    now = Date.parse(FIVE_RESET);
    viewers = 0;
    // usagePct needs both windows; D17: the Week window alone is still known (Session is left out).
    expect(await m.systemFields()).toEqual({ usageWindows: [{ key: 'week', label: 'Week', pct: 18, resetsAt: SEVEN_RESET }] });
    expect(await m.state()).toEqual({ known: false, reason: 'expired' });
  });

  it('a rate_limit_event the recorder stored counts like any reading', async () => {
    await store.usage.add({ source: 'rate_limit_event', sessionId, fiveHourPct: 62, fiveHourResetsAt: FIVE_RESET, sevenDayPct: 18, sevenDayResetsAt: SEVEN_RESET });
    expect(await meter().systemFields()).toEqual({ usagePct: 62, usageResetsAt: FIVE_RESET, usageWindows: windows(62, 18) });
  });
});

describe('UsageMeter · the warning fires once', () => {
  it('once per window until its reset, across ticks, /api/system calls and a restart; listed while in force', async () => {
    poller.outcome = { kind: 'response', message: controlResponse('p', usageResponse(91, 40)) };
    const m = meter();
    await m.tick();
    expect(warnings).toEqual([{ window: 'five_hour', pct: 91, threshold: 90, resetsAt: FIVE_RESET, firedAt: new Date(START).toISOString() }]);
    const fields = await m.systemFields();
    expect(fields).toEqual({ usagePct: 91, usageResetsAt: FIVE_RESET, usageWarnings: warnings, usageWindows: windows(91, 40) });

    // Higher readings of the same window, more ticks, more system calls: still one warning.
    poller.outcome = { kind: 'response', message: controlResponse('p', usageResponse(96, 40)) };
    for (let i = 1; i <= 3; i += 1) {
      now = START + i * 5 * MIN;
      await m.tick();
      await m.systemFields();
    }
    expect(await store.usage.latest()).toMatchObject({ fiveHourPct: 96 });
    expect(warnings).toHaveLength(1);

    // A restarted service (new meter, same database) does not warn again.
    const restarted = meter();
    await restarted.systemFields();
    expect(warnings).toHaveLength(1);
    expect(await store.settings.get(WARNED_SETTING)).toEqual({ five_hour: warnings[0] });

    // The window resets: the warning leaves /api/system; the next window at ≥ 90 % warns again.
    now = Date.parse(FIVE_RESET) + MIN;
    expect((await restarted.systemFields()).usageWarnings).toBeUndefined();
    const nextReset = '2026-09-28T04:40:00.000+00:00';
    poller.outcome = { kind: 'response', message: controlResponse('p', usageResponse(93, 40, nextReset)) };
    await restarted.tick();
    expect(warnings.map((w) => [w.window, w.pct, w.resetsAt])).toEqual([
      ['five_hour', 91, FIVE_RESET],
      ['five_hour', 93, '2026-09-28T04:40:00.000Z'],
    ]);
  });

  it('warns from a rate_limit_event too, and uses the Settings threshold (usage.warnAtPct)', async () => {
    await store.settings.set('usage.warnAtPct', 80);
    await store.usage.add({ source: 'rate_limit_event', sessionId, fiveHourPct: 50, fiveHourResetsAt: FIVE_RESET, sevenDayPct: 85, sevenDayResetsAt: SEVEN_RESET });
    viewers = 0;
    await meter().tick();
    expect(warnings).toEqual([{ window: 'seven_day', pct: 85, threshold: 80, resetsAt: SEVEN_RESET, firedAt: new Date(START).toISOString() }]);
  });

  it('just warns: nothing below the threshold, and nothing is asked of the sessions', async () => {
    sessions.live = [sessionId];
    sessions.idle = [sessionId];
    sessions.answer = usageResponse(89, 70);
    await meter().tick();
    expect(warnings).toEqual([]);
    sessions.answer = usageResponse(90, 70);
    now += MIN;
    const m = meter();
    await m.tick();
    expect(warnings.map((w) => w.window)).toEqual(['five_hour']);
    // The only thing written to a session is get_usage.
    expect(sessions.requests.map((r) => r.line.request.subtype)).toEqual(['get_usage', 'get_usage']);
  });
});

describe('UsageMeter · D17 model-scoped windows', () => {
  const FABLE_RESET = '2026-10-01T13:00:00.000Z';
  const FABLE_ROW: UsageWindow = { key: 'model', label: 'Fable', pct: 35, resetsAt: FABLE_RESET, model: 'Fable' };

  /** A get_usage answer with a Fable weekly limit (as recorded in usage-ctl, with this utilization). */
  function withFable(fable: number, fiveHour = 10, sevenDay = 18): Record<string, unknown> {
    const base = usageResponse(fiveHour, sevenDay);
    return {
      ...base,
      rate_limits: {
        ...(base['rate_limits'] as Record<string, unknown>),
        limits: [{ kind: 'weekly_scoped', percent: fable, resets_at: '2026-10-01T13:00:00+00:00', is_active: false, scope: { model: { id: null, display_name: 'Fable' } } }],
        model_scoped: [{ display_name: 'Fable', utilization: fable, resets_at: '2026-10-01T13:00:00+00:00' }],
      },
    };
  }

  it('a Fable limit in use gets a window; a newer rate_limit_event keeps it; it is unknown once the get_usage reading is over 10 min old', async () => {
    poller.outcome = { kind: 'response', message: controlResponse('p', withFable(35)) };
    const m = meter();
    await m.tick();
    expect((await m.systemFields()).usageWindows).toEqual([...windows(10, 18), FABLE_ROW]);

    // A turn's rate_limit_event (no model data) is the newest reading: Session / Week follow it, Fable stays.
    now += 2 * MIN;
    await store.usage.add({ source: 'rate_limit_event', sessionId, fiveHourPct: 12, fiveHourResetsAt: FIVE_RESET, sevenDayPct: 19, sevenDayResetsAt: SEVEN_RESET });
    expect((await m.systemFields()).usageWindows).toEqual([...windows(12, 19), FABLE_ROW]);

    // More than 10 min after the get_usage reading: unknown, left out (never an old number shown as current).
    now = START + 10 * MIN + 1;
    expect((await m.systemFields()).usageWindows).toEqual(windows(12, 19));
  });

  it('0 % and not active: no model window; a failed get_usage after a good one makes it unknown', async () => {
    poller.outcome = { kind: 'response', message: controlResponse('p', withFable(0)) };
    const m = meter();
    await m.tick();
    expect((await m.systemFields()).usageWindows).toEqual(windows(10, 18));
    poller.outcome = { kind: 'response', message: controlResponse('p', withFable(35)) };
    now += 6 * MIN;
    await m.tick();
    expect((await m.systemFields()).usageWindows).toContainEqual(FABLE_ROW);
    poller.outcome = { kind: 'failed', error: 'no answer' };
    now += 6 * MIN;
    await m.tick();
    expect(await m.systemFields()).toEqual({});
  });

  it('a model window at the threshold warns once until its reset, across ticks and a restart; listed while in force', async () => {
    poller.outcome = { kind: 'response', message: controlResponse('p', withFable(92)) };
    const m = meter();
    await m.tick();
    const fable: UsageWarning = { window: 'model', model: 'Fable', pct: 92, threshold: 90, resetsAt: FABLE_RESET, firedAt: new Date(START).toISOString() };
    expect(warnings).toEqual([fable]);
    expect(await store.settings.get(WARNED_SETTING)).toEqual({ model: { Fable: fable } });
    expect((await m.systemFields()).usageWarnings).toEqual([fable]);

    poller.outcome = { kind: 'response', message: controlResponse('p', withFable(97)) };
    now += 6 * MIN;
    await m.tick();
    const restarted = meter();
    await restarted.systemFields();
    expect(warnings).toEqual([fable]);
    // Still in force after the model window is no longer read (the reading aged out); gone after its reset.
    now = START + 30 * MIN;
    expect((await restarted.systemFields()).usageWarnings).toEqual([fable]);
    now = Date.parse(FABLE_RESET);
    expect((await restarted.systemFields()).usageWarnings).toBeUndefined();
  });
});
