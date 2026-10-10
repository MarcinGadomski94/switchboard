import { describe, expect, it } from 'vitest';
import {
  CRON_EXPIRY_MS,
  type LoopEventInput,
  PROCESS_CHANGED,
  SESSION_ONLY_NOTE,
  cronDeleteId,
  cronJobId,
  deriveLoops,
  isLoopCommand,
  loopCommandLabel,
  loopNotExpired,
  loopPayloadEssentials,
} from '../../src/core/derive/loops.ts';
import { nextCronMatch } from '../../src/core/derive/cron-next.ts';

const T0 = Date.parse('2026-09-28T10:00:00.000Z');
const MAIN = 'agent-main';

/** A tiny event log builder: every call is one stored event, one second after the previous one. */
function log() {
  const events: LoopEventInput[] = [];
  let t = T0;
  const at = (): string => new Date((t += 1000)).toISOString();
  const add = (payload: unknown, label = '', agentId: string | null = MAIN): LoopEventInput => {
    const event = { ts: at(), agentId, label, payload };
    events.push(event);
    return event;
  };
  return {
    events,
    user: (text: string) => add({ type: 'user', text, origin: 'user', delivered: true }, text, null),
    /** `result: null` = the tool result has not arrived. */
    tool: (name: string, input: Record<string, unknown>, result: string | null = 'ok', isError = false, toolUseId = `tu-${events.length}`) =>
      add({ type: 'tool', name, toolUseId, input, ...(result === null ? {} : { result, isError }) }, name),
    text: (text: string, agentId: string | null = MAIN) => add({ type: 'assistant', text, messageId: null }, text, agentId),
    result: (label = 'Done', isError = false, taskNotification = false) =>
      add({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', isError, text: label, terminalReason: null, errors: [], taskNotification }, label, null),
    lifecycle: (action: string) => add({ type: 'lifecycle', action }, action, null),
    /** Moves the clock: the next event comes `ms` later (plus the usual second). */
    advance: (ms: number) => {
      t += ms;
    },
    /** Moves the clock to just before `iso` (the next event is at `iso`). */
    until: (iso: string) => {
      t = Date.parse(iso) - 1000;
    },
    /** Now = this many ms after the last event. */
    now: (ms = 0) => new Date(t + ms),
  };
}

describe('loops · /loop commands', () => {
  it('recognizes /loop and labels it with its interval', () => {
    expect(isLoopCommand('/loop 1h check prod')).toBe(true);
    expect(isLoopCommand('  /loop')).toBe(true);
    expect(isLoopCommand('/looping')).toBe(false);
    expect(isLoopCommand('please /loop 1h')).toBe(false);
    expect(loopCommandLabel('/loop 1h Monitor production')).toBe('/loop 1h');
    expect(loopCommandLabel('/loop 5m /foo')).toBe('/loop 5m');
    expect(loopCommandLabel('/loop check the build')).toBe('/loop');
  });
});

describe('loops · deriveLoops', () => {
  it('no loop sources → no loops (a rebuild / self-heal is not a loop card)', () => {
    const l = log();
    l.user('Build it');
    l.tool('Bash', { command: 'npm test' }, 'fail', true);
    l.tool('Bash', { command: 'npm test' });
    l.result('OK');
    expect(deriveLoops(l.events, { now: l.now(), status: 'done', mainAgentId: MAIN })).toEqual([]);
  });

  it('/loop + recurring CronCreate: iteration 1 is the /loop turn, each self-started turn one more; next = cron match, expiry = +7 days', () => {
    const l = log();
    l.user('Set up the workspace');
    l.result('Ready.');
    const loopMsg = l.user('/loop 5m check the build');
    const cron = l.tool('CronCreate', { cron: '*/5 * * * *', prompt: 'check the build', recurring: true }, 'Scheduled job ab12');
    l.text('Scheduled.');
    l.result('Build green.');
    // Two firings (no Switchboard message behind them), one of them failing.
    l.text('Checking…');
    l.result('Build green.');
    l.text('Checking…');
    l.result('Build red: 2 tests fail', true);
    const now = l.now(30_000);
    const [loop, ...rest] = deriveLoops(l.events, { now, status: 'done', mainAgentId: MAIN });
    expect(rest).toEqual([]);
    expect(loop).toMatchObject({ key: 'loop', kind: '/loop', label: '/loop 5m', startedAt: loopMsg.ts, iteration: 3 });
    expect(loop?.iterations.map((it) => it.result)).toEqual(['ok', 'ok', 'fail']);
    expect(loop?.iterations[2]).toMatchObject({ label: 'Build red: 2 tests fail' });
    expect(loop?.expiresAt).toBe(new Date(Date.parse(cron.ts) + CRON_EXPIRY_MS).toISOString());
    const next = new Date(loop?.nextFireAt ?? '');
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.getMinutes() % 5).toBe(0);
    expect(next.getTime() - now.getTime()).toBeLessThanOrEqual(5 * 60_000);
    expect(loop?.note).toBe(`${SESSION_ONLY_NOTE} Last iteration: Build red: 2 tests fail.`);
  });

  it('messages the developer sends during a loop are not iterations; task-notification turns are not firings', () => {
    const l = log();
    l.user('/loop 1h sweep');
    l.tool('CronCreate', { cron: '7 * * * *', prompt: 'sweep' });
    l.result('Swept.');
    l.user('How is it going?');
    l.result('Fine.');
    l.text('A background agent finished.');
    l.result('Agent done', false, true);
    l.result('Swept again.');
    const [loop] = deriveLoops(l.events, { now: l.now(), status: 'done', mainAgentId: MAIN });
    expect(loop?.iteration).toBe(2);
    expect(loop?.iterations.map((it) => it.label)).toEqual(['Swept.', 'Swept again.']);
  });

  it('the open iteration takes the session status; a self-started turn in progress shows as the next cell', () => {
    const l = log();
    l.user('/loop 1h sweep');
    let [loop] = deriveLoops(l.events, { now: l.now(), status: 'run', mainAgentId: MAIN });
    expect(loop?.iterations.map((it) => it.result)).toEqual(['run']);
    l.tool('CronCreate', { cron: '7 * * * *', prompt: 'sweep' });
    l.result('Swept.');
    l.text('Sweeping (fired by cron)…');
    [loop] = deriveLoops(l.events, { now: l.now(), status: 'need', mainAgentId: MAIN });
    expect(loop?.iterations.map((it) => it.result)).toEqual(['ok', 'need']);
    expect(loop?.iteration).toBe(1);
    // A subagent's text with nothing pending is not a firing.
    const m = log();
    m.user('/loop 1h sweep');
    m.tool('CronCreate', { cron: '7 * * * *', prompt: 'sweep' });
    m.result('Swept.');
    m.text('subagent output', 'agent-sub');
    [loop] = deriveLoops(m.events, { now: m.now(), status: 'run', mainAgentId: MAIN });
    expect(loop?.iterations.map((it) => it.result)).toEqual(['ok']);
  });

  it('D93: the process ending ends the session-only schedule (its card goes); a later CronCreate revives the /loop', () => {
    const l = log();
    l.user('/loop 1h sweep');
    l.tool('CronCreate', { cron: '7 * * * *', prompt: 'sweep' });
    l.result('Swept.');
    l.lifecycle('paused');
    expect(deriveLoops(l.events, { now: l.now(), status: 'paused', mainAgentId: MAIN })).toEqual([]);
    // A turn after the stop is not a firing of the dead schedule.
    l.lifecycle('resumed');
    l.user('Continue.');
    l.result('Continued.');
    expect(deriveLoops(l.events, { now: l.now(), status: 'done', mainAgentId: MAIN })).toEqual([]);
    // The model schedules again after the resume: the same /loop card lives on.
    l.user('Schedule the sweep again');
    l.tool('CronCreate', { cron: '7 * * * *', prompt: 'sweep' });
    l.result('Rescheduled.');
    l.result('Swept after resume.');
    const loops = deriveLoops(l.events, { now: l.now(), status: 'done', mainAgentId: MAIN });
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ kind: '/loop', iteration: 2 });
    expect(loops[0]?.nextFireAt).not.toBeNull();
    expect(loops[0]?.note).toBe(`${SESSION_ONLY_NOTE} Last iteration: Swept after resume.`);
  });

  it('D93: an interrupted /loop turn that scheduled nothing ends with its process', () => {
    const l = log();
    l.user('/loop 1h sweep');
    l.lifecycle('paused');
    expect(deriveLoops(l.events, { now: l.now(), status: 'paused', mainAgentId: MAIN })).toEqual([]);
  });

  it('D93: a new process starting ends the schedules of the one before, also without a recorded end', () => {
    for (const action of ['continued', 'recovered', 'instruction-updated', 'taken-over', PROCESS_CHANGED]) {
      const l = log();
      l.user('Watch prod');
      l.tool('CronCreate', { cron: '10,40 * * * *', prompt: 'watch' }, 'Scheduled recurring job 1a2b3c4d (Every 30 minutes).');
      l.result('Scheduled.');
      expect(deriveLoops(l.events, { now: l.now(), status: 'idle', mainAgentId: MAIN })).toHaveLength(1);
      l.lifecycle(action);
      expect(deriveLoops(l.events, { now: l.now(), status: 'idle', mainAgentId: MAIN }), action).toEqual([]);
    }
  });

  it('D93: a recurring cron past its 7 days is gone; a one-shot cron fires once, at its time, then is gone', () => {
    const l = log();
    l.user('/loop 1h sweep');
    l.tool('CronCreate', { cron: '7 * * * *', prompt: 'sweep' });
    l.result('Swept.');
    expect(deriveLoops(l.events, { now: l.now(CRON_EXPIRY_MS - 60 * 60_000), status: 'done', mainAgentId: MAIN })).toHaveLength(1);
    expect(deriveLoops(l.events, { now: l.now(CRON_EXPIRY_MS + 60_000), status: 'done', mainAgentId: MAIN })).toEqual([]);

    const o = log();
    o.user('Remind me at 14:30');
    const created = o.tool('CronCreate', { cron: '30 14 28 9 *', prompt: 'check the deploy', recurring: false }, 'Scheduled one-shot job x9');
    o.result('Scheduled.');
    let [oneShot] = deriveLoops(o.events, { now: o.now(), status: 'done', mainAgentId: MAIN });
    expect(oneShot).toMatchObject({ kind: 'CronCreate', label: 'cron 30 14 28 9 *', iteration: 0, expiresAt: null, note: null });
    const expectedNext = new Date(Date.parse(created.ts));
    expect(new Date(oneShot?.nextFireAt ?? '').getTime()).toBeGreaterThan(expectedNext.getTime());
    // A self-started turn before its minute is something else's firing: the one-shot stays.
    o.result('Something else fired.');
    [oneShot] = deriveLoops(o.events, { now: o.now(), status: 'done', mainAgentId: MAIN });
    expect(oneShot).toMatchObject({ iteration: 0, nextFireAt: oneShot?.nextFireAt });
    // Its own firing: then nothing is left to fire and the card goes.
    o.until(oneShot?.nextFireAt ?? '');
    o.result('Deploy checked.');
    expect(deriveLoops(o.events, { now: o.now(), status: 'done', mainAgentId: MAIN })).toEqual([]);
  });

  it('ScheduleWakeup: next firing = call time + delaySeconds until it fires; standalone wake-ups get their own card', () => {
    const l = log();
    l.user('/loop watch the queue');
    const wake = l.tool('ScheduleWakeup', { delaySeconds: 1200, reason: 'next check', prompt: 'watch the queue' });
    l.result('Queue empty.');
    let [loop] = deriveLoops(l.events, { now: l.now(), status: 'done', mainAgentId: MAIN });
    expect(loop).toMatchObject({ kind: '/loop', label: '/loop', iteration: 1, expiresAt: null });
    expect(loop?.nextFireAt).toBe(new Date(Date.parse(wake.ts) + 1_200_000).toISOString());
    expect(loop?.note).toBe('Last iteration: Queue empty.');
    // The wake-up fires: the turn runs on its own and schedules the next one.
    const wake2 = l.tool('ScheduleWakeup', { delaySeconds: 600 });
    l.result('Queue has 2 items.');
    [loop] = deriveLoops(l.events, { now: l.now(), status: 'done', mainAgentId: MAIN });
    // The firing turn scheduled the next wake-up itself: that one is the next firing.
    expect(loop?.iteration).toBe(2);
    expect(loop?.nextFireAt).toBe(new Date(Date.parse(wake2.ts) + 600_000).toISOString());
    // D93: a firing whose turn schedules nothing new ends the loop: nothing is left to fire.
    l.text('Last check.');
    l.result('Queue drained.');
    expect(deriveLoops(l.events, { now: l.now(), status: 'done', mainAgentId: MAIN })).toEqual([]);

    const s = log();
    s.user('Check back in a minute');
    s.tool('ScheduleWakeup', { delaySeconds: 60 });
    s.result('Will check.');
    const [standalone] = deriveLoops(s.events, { now: s.now(), status: 'done', mainAgentId: MAIN });
    expect(standalone).toMatchObject({ key: 'wakeup', kind: 'ScheduleWakeup', label: 'ScheduleWakeup', iteration: 0 });
    // Without a usable delay nothing is scheduled (never invented).
    const n = log();
    n.user('Wake me');
    n.tool('ScheduleWakeup', { delay: '1h' });
    n.result('ok');
    expect(deriveLoops(n.events, { now: n.now(), status: 'done', mainAgentId: MAIN })).toEqual([]);
  });

  it('D93: CronDelete ends the named cron (its card goes); failed CronCreate calls and bad expressions are ignored', () => {
    const l = log();
    l.user('/loop 1h sweep');
    l.tool('CronCreate', { cron: 'every hour', prompt: 'sweep' });
    l.tool('CronCreate', { cron: '7 * * * *', prompt: 'sweep' }, 'boom', true);
    l.tool('CronCreate', { cron: '7 * * * *', prompt: 'sweep' }, 'Scheduled job job-42 (7 * * * *)');
    l.result('Swept.');
    let [loop] = deriveLoops(l.events, { now: l.now(), status: 'done', mainAgentId: MAIN });
    expect(loop?.nextFireAt).not.toBeNull();
    l.user('Stop the sweep');
    l.tool('CronDelete', { id: 'job-42' }, 'Deleted');
    l.result('Stopped.');
    expect(deriveLoops(l.events, { now: l.now(), status: 'done', mainAgentId: MAIN })).toEqual([]);
  });

  it('Workflow: one card per session, every call one run, ok / failed by its tool result, open while it has none', () => {
    const l = log();
    l.user('Run the rollout workflow');
    l.tool('Workflow', { name: 'button rollout', script: '…' }, 'Workflow run wf-1 finished: 12 agents');
    l.tool('Workflow', { description: 'retry blocked items' }, 'Script error', true);
    l.tool('Workflow', { script: '…' }, null);
    const [wf] = deriveLoops(l.events, { now: l.now(), status: 'run', mainAgentId: MAIN });
    expect(wf).toMatchObject({ key: 'workflow', kind: 'Workflow', label: 'Workflow', iteration: 3, nextFireAt: null, expiresAt: null });
    expect(wf?.iterations.map((it) => it.result)).toEqual(['ok', 'fail', 'run']);
    expect(wf?.note).toBe('Last iteration: Script error.');
    const named = log();
    named.tool('Workflow', { name: 'button rollout' }, 'ok');
    expect(deriveLoops(named.events, { now: named.now(), status: 'done' })[0]?.label).toBe('Workflow · button rollout');
  });

  it('keeps at most the newest 100 iterations', () => {
    const l = log();
    l.user('/loop 1m ping');
    l.tool('CronCreate', { cron: '* * * * *', prompt: 'ping' });
    l.result('pong');
    for (let i = 0; i < 120; i++) l.result(`pong ${i}`);
    const [loop] = deriveLoops(l.events, { now: l.now(), status: 'done', mainAgentId: MAIN });
    expect(loop?.iteration).toBe(121);
    expect(loop?.iterations).toHaveLength(100);
    expect(loop?.iterations.at(-1)?.label).toBe('pong 119');
  });
});

/**
 * D93: the bug report of 2026-10-09, replayed with made-up ids. A terminal session
 * (hooked) created recurring crons on 27 Sep, 29 Sep (`7,37`) and 3 Oct (`10,40`),
 * cancelled the 3 Oct one on 5 Oct and created a new `10,40` one a minute later;
 * at 08:44 it continued in Switchboard (a new `sdk-cli` process), where half-hourly
 * prompts kept arriving as self-started turns; on 9 Oct it created a one-shot.
 * Only the one-shot is alive.
 */
describe('loops · D93 bug report replay', () => {
  const MONITOR = 'Production monitoring shift: sweep the logs.';
  const created = (id: string, what = 'Every 30 minutes') =>
    `Scheduled recurring job ${id} (${what}). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner.`;

  function replay(options: { continued: boolean }) {
    const l = log();
    const cron = (id: string, expression: string, at: string) => {
      l.until(at);
      l.user('Set up the monitoring loop');
      l.tool('CronCreate', { cron: expression, prompt: MONITOR, recurring: true }, created(id));
      l.result('Scheduled.');
    };
    cron('e1111111', '7,37 * * * *', '2026-09-27T18:52:41.000Z');
    cron('e2222222', '7,37 * * * *', '2026-09-29T18:24:57.000Z');
    cron('a3333333', '10,40 * * * *', '2026-10-03T19:35:02.000Z');
    l.until('2026-10-05T07:07:25.000Z');
    l.user('Cancel the old monitoring job');
    l.tool('CronDelete', { id: 'a3333333' }, 'Cancelled job a3333333');
    l.tool('CronCreate', { cron: '10,40 * * * *', prompt: MONITOR, recurring: true }, created('b4444444'));
    l.result('Replaced.');
    // Two firings in that process (the CLI's own).
    for (const at of ['2026-10-05T07:14:00.000Z', '2026-10-05T07:17:00.000Z']) {
      l.until(at);
      l.text('Sweeping…');
      l.result('Nothing new.');
    }
    if (options.continued) {
      l.until('2026-10-05T08:44:26.000Z');
      l.lifecycle('continued');
    }
    // Half-hourly self-started turns in the new process (hh:15:07 / hh:45:07).
    for (let at = Date.parse('2026-10-05T09:15:07.000Z'); at <= Date.parse('2026-10-09T19:15:07.000Z'); at += 30 * 60_000) {
      l.until(new Date(at).toISOString());
      l.text('Sweeping…');
      l.result('Nothing new.');
    }
    l.until('2026-10-09T19:20:53.000Z');
    l.user('Remind me on Tuesday');
    const oneShot = l.tool('CronCreate', { cron: '22 18 13 10 *', prompt: 'Check the release.', recurring: false }, 'Scheduled one-shot job c5555555 (Tue 13 Oct 18:22). Session-only.');
    l.result('Scheduled.');
    // The agent tries to cancel the old ones: this process has none of them.
    for (const id of ['e2222222', 'a3333333', 'b4444444']) l.tool('CronDelete', { id }, `No scheduled job with id '${id}'`, true);
    l.result('None of them exist here.');
    // A half-hourly firing after the one-shot was made: not the one-shot's (it fires on 13 Oct).
    l.until('2026-10-09T19:45:07.000Z');
    l.text('Sweeping…');
    l.result('Nothing new.');
    return { l, oneShot };
  }

  it('after the update only the one-shot is listed, with its own firing time; the cancelled, expired and earlier-process jobs are gone', () => {
    const { l, oneShot } = replay({ continued: true });
    const loops = deriveLoops(l.events, { now: new Date('2026-10-09T20:00:00.000Z'), status: 'idle', mainAgentId: MAIN });
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ kind: 'CronCreate', label: 'cron 22 18 13 10 *', iteration: 0, expiresAt: null, startedAt: oneShot.ts });
    expect(loops[0]?.nextFireAt).toBe(nextCronMatch('22 18 13 10 *', new Date(oneShot.ts))?.toISOString());
  });

  it('without a recorded process change the cancelled job is still matched by its id, the 7,37 jobs are past their 7 days, and the missing jobs are ended by "No scheduled job"', () => {
    const { l } = replay({ continued: false });
    const loops = deriveLoops(l.events, { now: new Date('2026-10-09T20:00:00.000Z'), status: 'idle', mainAgentId: MAIN });
    expect(loops.map((loop) => loop.label)).toEqual(['cron 22 18 13 10 *']);
  });

  it('on 7 Oct the 10,40 job of the earlier process is not live: the process change ended it (without one it would be)', () => {
    const at = (continued: boolean) => {
      const { l } = replay({ continued });
      const cut = l.events.findLastIndex((event) => event.ts <= '2026-10-07T12:15:07.000Z');
      return deriveLoops(l.events.slice(0, cut + 1), { now: new Date('2026-10-07T12:20:00.000Z'), status: 'idle', mainAgentId: MAIN });
    };
    expect(at(true)).toEqual([]);
    expect(at(false).map((loop) => [loop.label, loop.expiresAt])).toEqual([['cron 10,40 * * * *', '2026-10-12T07:07:27.000Z']]);
  });

  it('job ids: from CronCreate results and from CronDelete inputs or results', () => {
    expect(cronJobId(created('94ab12cd'))).toBe('94ab12cd');
    expect(cronJobId('Scheduled one-shot job x9')).toBe('x9');
    expect(cronJobId('Scheduled job job-42 (7 * * * *)')).toBe('job-42');
    expect(cronJobId('ok')).toBeNull();
    expect(cronDeleteId({ id: '94ab12cd' }, 'Cancelled job 94ab12cd')).toBe('94ab12cd');
    expect(cronDeleteId({}, 'Cancelled job 94ab12cd')).toBe('94ab12cd');
    expect(cronDeleteId({}, "No scheduled job with id '31aa22bb'")).toBe('31aa22bb');
    expect(cronDeleteId({ job_id: 'z1' }, undefined)).toBe('z1');
    expect(cronDeleteId({}, 'Done')).toBeNull();
  });

  it('a CronDelete naming an unknown id never ends a different (the only) live cron', () => {
    const l = log();
    l.tool('CronCreate', { cron: '22 18 13 10 *', recurring: false }, 'Scheduled one-shot job c5555555.');
    l.tool('CronDelete', { id: 'a3333333' }, "No scheduled job with id 'a3333333'", true);
    l.tool('CronDelete', { id: 'b4444444' }, 'Cancelled job b4444444');
    expect(deriveLoops(l.events, { now: l.now(), status: 'idle', mainAgentId: MAIN })).toHaveLength(1);
    // A CronDelete with no id at all still ends the only live cron.
    l.tool('CronDelete', {}, 'Cancelled.');
    expect(deriveLoops(l.events, { now: l.now(), status: 'idle', mainAgentId: MAIN })).toEqual([]);
  });

  it('a stored loop past its expiry is not shown', () => {
    const now = new Date('2026-10-09T20:00:00.000Z');
    expect(loopNotExpired({ expiresAt: null }, now)).toBe(true);
    expect(loopNotExpired({ expiresAt: '2026-10-12T07:08:22.000Z' }, now)).toBe(true);
    expect(loopNotExpired({ expiresAt: '2026-10-06T18:24:57.000Z' }, now)).toBe(false);
  });
});

describe('D95 · loopPayloadEssentials (the tracker keeps slim events between refreshes)', () => {
  it('deriving from the slim events gives the same loops as from the whole events', () => {
    const l = log();
    l.user('Set up the workspace');
    l.tool('Read', { file_path: '/a.ts' }, 'x'.repeat(4000));
    l.text('Reading.');
    l.result('Ready.');
    l.user('/loop 5m check the build');
    l.tool('CronCreate', { cron: '*/5 * * * *', prompt: 'check the build', recurring: true }, 'Scheduled recurring job ab12cd34');
    l.text('Scheduled.');
    l.result('Loop set.');
    for (let i = 0; i < 3; i += 1) {
      l.advance(5 * 60_000);
      l.text('Checking the build.');
      l.tool('Bash', { command: 'npm test' }, 'ok');
      l.result(`Build ${i} green.`, i === 1);
    }
    l.user('Also run a workflow and wake me up');
    l.tool('Workflow', { name: 'audit', script: 'x' }, 'Workflow launched in background.');
    l.tool('ScheduleWakeup', { delaySeconds: 600, prompt: 'look again' }, 'ok');
    l.tool('CronCreate', { cron: '0 9 * * *', prompt: 'morning check' }, 'Scheduled recurring job ffff0000');
    l.tool('CronDelete', { id: 'ffff0000' }, 'Cancelled job ffff0000');
    l.result('Done.', false, true);
    l.result('Done.');
    l.lifecycle('resumed');
    l.text('Back.');
    l.result('Still here.');
    const options = { now: l.now(60_000), status: 'done' as const, mainAgentId: MAIN };
    const whole = deriveLoops(l.events, options);
    expect(whole.length).toBeGreaterThan(0);
    const slim = l.events.map((event) => ({ ...event, payload: loopPayloadEssentials(event.payload) }));
    expect(deriveLoops(slim, options)).toEqual(whole);
    // Before the lifecycle event too (a process still running).
    const cut = l.events.length - 3;
    expect(deriveLoops(slim.slice(0, cut), options)).toEqual(deriveLoops(l.events.slice(0, cut), options));
    expect(deriveLoops(l.events.slice(0, cut), options).length).toBeGreaterThan(0);
    // Tool outputs and message texts are not kept.
    expect(JSON.stringify(slim).length).toBeLessThan(JSON.stringify(l.events).length / 2);
  });
});
