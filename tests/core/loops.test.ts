import { describe, expect, it } from 'vitest';
import { CRON_EXPIRY_MS, type LoopEventInput, SESSION_ONLY_NOTE, deriveLoops, isLoopCommand, loopCommandLabel } from '../../src/core/derive/loops.ts';

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

  it('the process ending stops the session-only schedule: no next firing, no expiry, a stop note; a later CronCreate revives it', () => {
    const l = log();
    l.user('/loop 1h sweep');
    l.tool('CronCreate', { cron: '7 * * * *', prompt: 'sweep' });
    l.result('Swept.');
    l.lifecycle('paused');
    let [loop] = deriveLoops(l.events, { now: l.now(), status: 'paused', mainAgentId: MAIN });
    expect(loop).toMatchObject({ iteration: 1, nextFireAt: null, expiresAt: null });
    expect(loop?.note).toBe("Stopped: the session's claude process ended. Last iteration: Swept.");
    // A turn after the stop is not a firing of the dead schedule.
    l.lifecycle('resumed');
    l.user('Continue.');
    l.result('Continued.');
    [loop] = deriveLoops(l.events, { now: l.now(), status: 'done', mainAgentId: MAIN });
    expect(loop?.iteration).toBe(1);
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

  it('an interrupted /loop turn is a `none` cell', () => {
    const l = log();
    l.user('/loop 1h sweep');
    l.lifecycle('paused');
    const [loop] = deriveLoops(l.events, { now: l.now(), status: 'paused', mainAgentId: MAIN });
    expect(loop?.iterations.map((it) => it.result)).toEqual(['none']);
    expect(loop?.note).toBe("Stopped: the session's claude process ended.");
  });

  it('a recurring cron past its 7 days is expired; a one-shot cron fires once', () => {
    const l = log();
    l.user('/loop 1h sweep');
    l.tool('CronCreate', { cron: '7 * * * *', prompt: 'sweep' });
    l.result('Swept.');
    const [expired] = deriveLoops(l.events, { now: l.now(CRON_EXPIRY_MS + 60_000), status: 'done', mainAgentId: MAIN });
    expect(expired).toMatchObject({ nextFireAt: null, expiresAt: null });
    expect(expired?.note).toBe('Expired 7 days after the cron job was created. Last iteration: Swept.');

    const o = log();
    o.user('Remind me at 14:30');
    const created = o.tool('CronCreate', { cron: '30 14 28 9 *', prompt: 'check the deploy', recurring: false }, 'Scheduled one-shot job x9');
    o.result('Scheduled.');
    let [oneShot] = deriveLoops(o.events, { now: o.now(), status: 'done', mainAgentId: MAIN });
    expect(oneShot).toMatchObject({ kind: 'CronCreate', label: 'cron 30 14 28 9 *', iteration: 0, expiresAt: null, note: null });
    const expectedNext = new Date(Date.parse(created.ts));
    expect(new Date(oneShot?.nextFireAt ?? '').getTime()).toBeGreaterThan(expectedNext.getTime());
    o.result('Deploy checked.');
    [oneShot] = deriveLoops(o.events, { now: o.now(), status: 'done', mainAgentId: MAIN });
    expect(oneShot).toMatchObject({ iteration: 1, nextFireAt: null });
    expect(oneShot?.iterations.map((it) => it.result)).toEqual(['ok']);
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
    // A firing whose turn schedules nothing new leaves no next firing.
    l.text('Last check.');
    l.result('Queue drained.');
    [loop] = deriveLoops(l.events, { now: l.now(), status: 'done', mainAgentId: MAIN });
    expect(loop?.iteration).toBe(3);
    expect(loop?.nextFireAt).toBeNull();

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

  it('CronDelete stops the named cron; failed CronCreate calls and bad expressions are ignored', () => {
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
    [loop] = deriveLoops(l.events, { now: l.now(), status: 'done', mainAgentId: MAIN });
    expect(loop).toMatchObject({ nextFireAt: null, expiresAt: null, iteration: 1 });
    expect(loop?.note).toBe('Stopped: the cron job was deleted. Last iteration: Swept.');
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
