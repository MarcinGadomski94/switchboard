import { afterEach, describe, expect, it } from 'vitest';
import type { UsageWarning } from '../../../src/core/api.ts';
import { type GetUsageOutcome, getUsageLine } from '../../../src/core/usage.ts';
import { UsageMeter } from '../../../src/server/usage/meter.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, stdinOf, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * M9.2 oracle, readings from supervised sessions (D13 real path: the
 * SessionSupervisor with fake-claude as the CLI): `get_usage` over the stdin of a
 * live session between turns, never mid-turn; the `rate_limit_event` of a turn;
 * both drive `usagePct` (fake clock on the probe day, when the recorded resets
 * are still ahead).
 */

const PROBE_TIME = Date.parse('2026-09-27T21:20:00.000Z');

let w: SupervisorWorld | undefined;

afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

const noPoller = {
  async getUsage(): Promise<GetUsageOutcome> {
    throw new Error('the poller must not run while a session is live');
  },
};

function meterFor(world: SupervisorWorld, now: () => number, warnings: UsageWarning[] = []): UsageMeter {
  return new UsageMeter({
    store: world.store,
    sessions: world.supervisor,
    poller: noPoller,
    viewers: () => 1,
    now: () => new Date(now()),
    liveRequestTimeoutMs: 5_000,
    onWarning: (warning) => warnings.push(warning),
    onError: (error) => {
      throw error;
    },
  });
}

describe('UsageMeter + SessionSupervisor (fake-claude)', () => {
  it('asks a live idle session for get_usage over stdin and stores the answer as its reading', async () => {
    w = await makeSupervisorWorld();
    const session = await w.supervisor.start(newSession({ name: 'usage-idle' }), w.place, '');
    expect(w.supervisor.idleLiveSessionIds()).toEqual([session.id]);
    let now = PROBE_TIME;
    const meter = meterFor(w, () => now);

    expect(await meter.tick()).toBe('live');
    const pid = w.supervisor.pid(session.id) as number;
    const logFile = w.logFile;
    // The fake logs stdin asynchronously; wait for the line, then check it is the only one.
    const stdin = await until(async () => {
      const lines = await stdinOf(logFile, pid);
      return lines.length > 0 ? lines : undefined;
    }, 'the get_usage line in the fake log');
    expect(stdin).toHaveLength(1);
    expect(stdin[0]).toMatchObject({ type: 'control_request', request: { subtype: 'get_usage', skip_behaviors: true } });
    expect(await w.store.usage.latest()).toMatchObject({ source: 'get_usage', sessionId: session.id, fiveHourPct: 10, sevenDayPct: 18 });
    expect(await meter.systemFields()).toEqual({ usagePct: 18, usageResetsAt: '2026-10-01T13:00:00.290Z' });

    // The answer is not a chat event, and the session stays idle and live.
    const events = await w.store.events.list(session.id);
    expect(events.map((e) => e.label)).toEqual(['Started']);
    expect(w.supervisor.isLive(session.id)).toBe(true);

    // At most once per 60 s.
    now += 30_000;
    expect(await meter.tick()).toBeNull();
    expect(await stdinOf(logFile, pid)).toHaveLength(1);
    now += 30_000;
    expect(await meter.tick()).toBe('live');
    await until(async () => (await stdinOf(logFile, pid)).length === 2, 'a second get_usage line');
    expect(w.errors).toEqual([]);
  });

  it('never asks mid-turn; the turn’s rate_limit_event is a reading of its own', async () => {
    w = await makeSupervisorWorld({ scenario: 'hang' });
    const session = await w.supervisor.start(newSession({ name: 'usage-busy' }), w.place);
    await waitForStatus(w.store, session.id, ['run']);
    const pid = w.supervisor.pid(session.id) as number;
    const logFile = w.logFile;
    await until(async () => (await stdinOf(logFile, pid)).length === 1, 'the task message in the fake log');
    expect(w.supervisor.idleLiveSessionIds()).toEqual([]);
    const meter = meterFor(w, () => PROBE_TIME);
    expect(await meter.tick()).toBeNull();
    // Give a wrongly written request time to reach the log: still only the task message.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await stdinOf(logFile, pid)).map((line) => line['type'])).toEqual(['user']);
    await w.supervisor.pause(session.id);

    // usage-turn: one API turn with `rate_limit_event` 0.1 / 0.18, recorded by the M2.1 recorder.
    w.env['FAKE_CLAUDE_SCENARIO'] = 'usage-turn';
    const turn = await w.supervisor.start(newSession({ name: 'usage-turn' }), w.place);
    await waitForStatus(w.store, turn.id, ['done']);
    const reading = await until(async () => (await w?.store.usage.list())?.find((r) => r.sessionId === turn.id), 'the rate_limit_event reading');
    expect(reading).toMatchObject({ source: 'rate_limit_event', fiveHourPct: 10, sevenDayPct: 18, fiveHourResetsAt: '2026-09-27T23:40:00.000Z' });
    expect(await meter.systemFields()).toEqual({ usagePct: 18, usageResetsAt: '2026-10-01T13:00:00.000Z' });
  });

  it('a session that ends before answering: no reading is invented (unknown)', async () => {
    w = await makeSupervisorWorld();
    const session = await w.supervisor.start(newSession({ name: 'usage-gone' }), w.place, '');
    // Straight to the supervisor: a stopped session answers nothing.
    await w.supervisor.pause(session.id);
    expect(await w.supervisor.controlRequest(session.id, getUsageLine('sb-usage-gone'), 1_000)).toBeNull();
    expect(w.supervisor.idleLiveSessionIds()).toEqual([]);
  });
});
