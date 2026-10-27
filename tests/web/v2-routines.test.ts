import { describe, expect, it } from 'vitest';
import type { Loop, OwnedLoop, Schedule, ScheduleRun, SessionListItem, TerminalLoop } from '../../src/core/api.ts';
import {
  cronText,
  durationText,
  everyText,
  lastRunsText,
  loopRoutine,
  routineCountText,
  routineLists,
  scheduleEditBody,
  scheduleRoutine,
  scheduleRunLine,
} from '../../src/web/v2/agents/routines/routines-model.ts';

const NOW = new Date(2026, 9, 25, 13, 30).getTime();
const at = (h: number, m = 0, day = 25): string => new Date(2026, 9, day, h, m).toISOString();

function session(over: Partial<SessionListItem> = {}): SessionListItem {
  return { id: 's1', name: 'nightly', displayTitle: 'Nightly prod check', status: 'idle', createdAt: at(8), loops: [], ownedLoops: [], closedAt: null, ...over } as unknown as SessionListItem;
}

function owned(over: Partial<OwnedLoop> = {}): OwnedLoop {
  return {
    id: 'l1',
    sessionId: 's1',
    label: 'Nightly prod check',
    title: 'Nightly prod check',
    prompt: 'Check the checkout page loads\nand log any errors',
    schedule: { kind: 'every', minutes: 60 },
    scheduleText: 'every 60 min',
    expiresAt: null,
    maxRuns: null,
    state: 'active',
    endedReason: null,
    runs: 5,
    skipped: 1,
    lastFiredAt: at(13),
    lastError: null,
    nextFireAt: at(14),
    createdBy: 'developer',
    createdAt: at(8),
    updatedAt: at(13),
    ...over,
  };
}

function run(result: ScheduleRun['result'], ts: string, over: Partial<ScheduleRun> = {}): ScheduleRun {
  return { ts, result, summary: null, finishedAt: result === 'running' ? null : ts, triggeredBy: 'cron', sessionId: null, ...over };
}

function schedule(over: Partial<Schedule> = {}): Schedule {
  return { id: 'sc1', name: 'Morning dependency check', description: 'Check dependencies', cron: '0 8 * * 1-5', paused: false, template: { name: 'Morning dependency check', task: 'Check dependencies' }, runs: [], nextRunAt: at(8, 0, 26), running: false, ...over };
}

describe('v2 Routines · plain words', () => {
  it('describes intervals', () => {
    expect(everyText(60)).toBe('Every hour');
    expect(everyText(120)).toBe('Every 2 hours');
    expect(everyText(30)).toBe('Every 30 minutes');
    expect(everyText(1440)).toBe('Every day');
    expect(everyText(90)).toBe('Every 90 minutes');
  });

  it('describes cron expressions', () => {
    expect(cronText('0 * * * *')).toBe('Every hour');
    expect(cronText('0 */4 * * *')).toBe('Every 4 hours');
    expect(cronText('*/15 * * * *')).toBe('Every 15 minutes');
    expect(cronText('0 2 * * *')).toBe('Every day at 02:00');
    expect(cronText('0 8 * * 1-5')).toBe('Weekdays at 08:00');
    expect(cronText('0 7 * * 1')).toBe('Mon at 07:00');
    expect(cronText('0 9 1 * *')).toBe('Monthly on the 1st at 09:00');
  });

  it('summarises the last runs', () => {
    expect(lastRunsText([], NOW)).toBe('no runs yet');
    expect(lastRunsText([run('ok', at(10)), run('ok', at(11)), run('skipped', at(12)), run('ok', at(13))], NOW)).toBe('last 3 runs passed');
    expect(lastRunsText([run('fail', at(8))], NOW)).toBe('last run failed at 08:00');
    expect(lastRunsText([run('ok', at(12))], NOW)).toBe('last run passed');
  });

  it('writes history lines like the prototype', () => {
    expect(durationText(41_000)).toBe('41 s');
    expect(scheduleRunLine(run('ok', at(13), { finishedAt: new Date(Date.parse(at(13)) + 41_000).toISOString() }), NOW)).toEqual({ time: '13:00', tone: 'ok', text: 'passed in 41 s' });
    expect(scheduleRunLine(run('skipped', at(12), { summary: 'waiting for you' }), NOW)).toEqual({ time: '12:00', tone: 'skip', text: 'skipped — waiting for you' });
    expect(scheduleRunLine(run('fail', at(8, 0, 23), { summary: '2 high-severity package warnings' }), NOW)).toEqual({ time: 'Fri 08:00', tone: 'fail', text: 'failed — 2 high-severity package warnings' });
    expect(scheduleRunLine(run('ok', at(9), { triggeredBy: 'manual', finishedAt: null }), NOW).text).toBe('passed (run by you)');
  });
});

describe('v2 Routines · Switchboard loops', () => {
  it('reads "Every hour · next run 14:00 · 5 runs so far (1 skipped)" and allows every action', () => {
    const routine = loopRoutine(session(), owned(), NOW);
    expect(routine.summary).toBe('Every hour · next run 14:00 · 5 runs so far (1 skipped)');
    expect(routine.what).toBe('Check the checkout page loads');
    expect(routine.status).toBe('idle');
    expect(routine.statusLabel).toBe('On schedule');
    expect(routine.agent).toMatchObject({ id: 's1', name: 'Nightly prod check' });
    expect(Object.values(routine.actions).every((action) => action.ok)).toBe(true);
    expect(routine.history).toEqual([{ time: '13:00', tone: 'ok', text: 'sent to its agent (run 5)' }]);
  });

  it('shows paused and the last skip', () => {
    const routine = loopRoutine(session(), owned({ state: 'paused', nextFireAt: null, lastError: 'the agent was waiting for you' }), NOW);
    expect(routine.summary).toBe('Every hour · paused · 5 runs so far (1 skipped)');
    expect(routine.status).toBe('paused');
    expect(routine.history[0]).toMatchObject({ tone: 'skip', text: 'skipped — the agent was waiting for you' });
  });

  it('disables actions with the reason: offline computer, closed agent', () => {
    const offline = loopRoutine(session({ machine: { id: 'studio', name: 'Studio-PC', state: 'offline' } }), owned(), NOW);
    expect(offline.actions.run).toEqual({ ok: false, reason: 'Studio-PC is unreachable' });
    const closed = loopRoutine(session({ closedAt: at(9) }), owned(), NOW);
    expect(closed.actions.pause).toEqual({ ok: false, reason: 'Its agent is archived.' });
    expect(closed.actions.cancel.ok).toBe(true);
  });
});

describe('v2 Routines · scheduled runs', () => {
  it('reads its schedule, next run and last runs; links the last run’s agent', () => {
    const routine = scheduleRoutine(schedule({ runs: [run('ok', at(8, 0, 23)), run('fail', at(8), { summary: '2 warnings', sessionId: 's1' })] }), [session()], NOW);
    expect(routine.summary).toBe('Weekdays at 08:00 · next run tomorrow 08:00 · last run failed at 08:00');
    expect(routine.status).toBe('stopped');
    expect(routine.statusLabel).toBe('Last run failed');
    expect(routine.agent).toMatchObject({ id: 's1', name: 'Nightly prod check', label: 'Last run' });
    expect(routine.history.map((line) => line.time)).toEqual(['08:00', 'Fri 08:00']);
  });

  it('refuses Run now and Cancel while a run is in progress', () => {
    const routine = scheduleRoutine(schedule({ running: true, runs: [run('running', at(13))] }), [], NOW);
    expect(routine.status).toBe('working');
    expect(routine.actions.run).toEqual({ ok: false, reason: 'A run is in progress.' });
    expect(routine.actions.cancel.ok).toBe(false);
    expect(routine.actions.pause.ok).toBe(true);
  });

  it('builds the Edit body (prompt replaced, other settings kept) and refuses a bad cron', () => {
    const edit = scheduleEditBody(schedule(), { cron: '0 9 * * 1-5', what: 'Check again' });
    expect(edit).toEqual({ ok: true, body: { id: 'sc1', cron: '0 9 * * 1-5', template: { name: 'Morning dependency check', task: 'Check again' } } });
    expect(scheduleEditBody(schedule(), { cron: '0 9 *', what: 'x' }).ok).toBe(false);
    expect(scheduleEditBody(schedule(), { cron: '0 9 * * *', what: ' ' }).ok).toBe(false);
  });
});

describe('v2 Routines · CLI loops and the list', () => {
  const cliLoop: Loop = { id: 'cl1', sessionId: 's1', kind: '/loop', label: '/loop 1h', iteration: 3, cap: 10, breakerCount: null, breakerState: null, nextFireAt: at(14), expiresAt: null, iterations: [{ result: 'ok', ts: at(12), label: null }], progressPath: null, note: null, createdAt: at(7), updatedAt: at(12) };
  const terminal: TerminalLoop = { loop: { ...cliLoop, id: 'term:x:1' }, terminal: { id: 'x', name: null, cwd: '/w/acme', status: null, pid: 1, startedAt: at(6) } };

  it('lists owned loops, then schedules, then watched CLI loops; ended loops apart', () => {
    const lists = routineLists({ sessions: [session({ loops: [cliLoop], ownedLoops: [owned(), owned({ id: 'l2', state: 'ended', endedReason: 'cancelled' })] })], schedules: [schedule()], terminalLoops: [terminal] }, NOW);
    expect(lists.active.map((routine) => routine.key)).toEqual(['loop:s1:l1', 'schedule:sc1', 'cli:cl1', 'cli:term:x:1']);
    expect(lists.active.map((routine) => routine.source)).toEqual(['loop', 'schedule', 'cli', 'cli']);
    expect(lists.ended.map((routine) => routine.id)).toEqual(['l2']);
    expect(lists.ended[0]?.actions.run.ok).toBe(false);
  });

  it('a CLI loop can only be watched', () => {
    const lists = routineLists({ sessions: [session({ loops: [cliLoop] })], schedules: [], terminalLoops: [terminal] }, NOW);
    const cli = lists.active.find((routine) => routine.id === 'cl1');
    expect(cli?.summary).toBe('/loop 1h · next run 14:00 · run 3 of 10');
    expect(cli?.actions.pause).toEqual({ ok: false, reason: 'Managed by the AI engine: Switchboard can only watch it.' });
    const term = lists.active.find((routine) => routine.id === 'term:x:1');
    expect(term?.agent).toBeNull();
    expect(term?.terminalName).toBe('Terminal · acme');
  });

  it('counts', () => {
    expect(routineCountText(1)).toBe('1 routine');
    expect(routineCountText(3)).toBe('3 routines');
  });
});
