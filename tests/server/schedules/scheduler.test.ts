/**
 * M7.1 oracle (unit with a fake clock, on the real code path, D13): the Scheduler
 * over a real store, the real SessionSupervisor with fake-claude as the CLI, a real
 * WorktreeManager on temp git repos and the real M3.3 SystemItemService. Only time
 * is fake: `FakeClock` (tests/helpers/clock.ts) drives the cron timer.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NewSession, Schedule } from '../../../src/core/api.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { ScheduleRunRecord } from '../../../src/server/db/repos/schedules.ts';
import { type HubMessage, HubBus } from '../../../src/server/hub/bus.ts';
import { QuestionPipeline } from '../../../src/server/inbox/pipeline.ts';
import { SCHEDULE_RUN_FAILED, SystemItemError, SystemItemService } from '../../../src/server/inbox/system-items.ts';
import { SKIPPED_SUMMARY, Scheduler, SchedulerError, runResultFor, scheduleRunnerFor } from '../../../src/server/schedules/scheduler.ts';
import type { ControlRequestHandler } from '../../../src/server/supervisor/supervisor.ts';
import type { WorktreeManager } from '../../../src/server/worktrees/manager.ts';
import { FakeClock } from '../../helpers/clock.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, spawnedArgv, stdinOf, until } from '../../helpers/supervisor.ts';

/** A local time on 2026-09-28 (a Monday), or another day of that month. */
const at = (hour: number, minute = 0, day = 28): Date => new Date(2026, 8, day, hour, minute, 0, 0);
/** 2026-09-28 at `hour:minute:second` local. */
const atSecond = (hour: number, minute: number, second: number): Date => new Date(2026, 8, 28, hour, minute, second, 0);

interface Rig {
  readonly w: SupervisorWorld;
  readonly g: GitWorld;
  readonly worktrees: WorktreeManager;
  readonly clock: FakeClock;
  readonly bus: HubBus;
  readonly messages: HubMessage[];
  readonly systemItems: SystemItemService;
  readonly scheduler: Scheduler;
  readonly errors: unknown[];
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.scheduler.close();
  await rig?.systemItems.close();
  await rig?.w.cleanup();
  rig = undefined;
});

async function setup(start: Date, options: { readonly scenario?: string } = {}): Promise<Rig> {
  // The question pipeline (M3.1) is the supervisor's control-request handler, joined as createSessionServices does.
  const holder: { pipeline?: QuestionPipeline } = {};
  const forward: ControlRequestHandler = {
    canUseTool: (context) => holder.pipeline?.canUseTool(context),
    cancelled: (sessionId, requestId) => holder.pipeline?.cancelled(sessionId, requestId),
    orphaned: (sessionId, ids) => holder.pipeline?.orphaned(sessionId, ids),
    pendingDelivered: (sessionId, pending) => holder.pipeline?.pendingDelivered(sessionId, pending),
  };
  const w = await makeSupervisorWorld({ ...(options.scenario ? { scenario: options.scenario } : {}), controlHandler: forward });
  const g = await makeGitWorld({ root: w.root, workspace: w.workspace, store: w.store });
  const worktrees = g.manager({ sessions: w.supervisor });
  const bus = new HubBus();
  const messages: HubMessage[] = [];
  bus.subscribe((message) => messages.push(message));
  holder.pipeline = new QuestionPipeline({ store: w.store, bus }).bind(w.supervisor);
  const errors: unknown[] = [];
  const systemItems = new SystemItemService({ store: w.store, bus, worktrees, onError: (error) => errors.push(error) });
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: w.root }, platform: 'linux', home: w.root, cwd: w.root });
  const config = { ...base, workspaceRoot: w.workspace };
  const clock = new FakeClock(start);
  const scheduler = new Scheduler({
    store: w.store,
    sessions: { config, store: w.store, providers: {}, supervisor: w.supervisor, worktrees },
    updates: w.supervisor,
    bus,
    systemItems,
    clock,
    onError: (error) => errors.push(error),
  });
  systemItems.useScheduleRunner(scheduleRunnerFor(scheduler));
  rig = { w, g, worktrees, clock, bus, messages, systemItems, scheduler, errors };
  return rig;
}

/** A template: a valid NewSession on the world's `mobile` repo, no worktrees. */
function template(overrides: Partial<NewSession> = {}): NewSession {
  return newSession({ name: 'nightly-check', task: 'Check the build and report.', solutions: ['mobile'], coordination: null, ...overrides });
}

async function save(r: Rig, body: unknown): Promise<Schedule> {
  return r.scheduler.save(body);
}

async function runs(r: Rig, scheduleId: string): Promise<ScheduleRunRecord[]> {
  return r.w.store.schedules.recentRuns(scheduleId, 50);
}

/** Waits until the schedule's newest run has `result`. */
function waitForRun(r: Rig, scheduleId: string, result: ScheduleRunRecord['result'], timeoutMs = 10_000): Promise<ScheduleRunRecord> {
  return until(async () => {
    const list = await runs(r, scheduleId);
    const last = list[list.length - 1];
    return last && last.result === result ? last : undefined;
  }, `a ${result} run of ${scheduleId}`, timeoutMs);
}

function scheduleRunEvents(r: Rig): Array<{ scheduleId: string; result: string }> {
  return r.messages.filter((m) => m.name === 'scheduleRun').map((m) => m.payload as { scheduleId: string; result: string });
}

describe('Scheduler · Save schedule (D8)', () => {
  it('starts with no schedules (gap #6); validates the input; stores the template; Edit replaces cron and template', async () => {
    const r = await setup(at(1, 59));
    expect(await r.scheduler.list()).toEqual([]);

    const invalid: Array<[unknown, string]> = [
      ['nope', ''],
      [{ cron: '0 2 * *', template: template() }, 'cron'],
      [{ cron: '61 * * * *', template: template() }, 'cron'],
      [{ cron: '0 2 * * *' }, 'template'],
      [{ cron: '0 2 * * *', template: template({ task: '   ' }) }, 'template.task'],
      [{ cron: '0 2 * * *', template: template({ name: 'Nightly Check' }) }, 'template.name'],
      [{ cron: '0 2 * * *', template: template({ solutions: [] }) }, 'template.solutions'],
      [{ cron: '0 2 * * *', template: template({ solutions: ['deprecated/microfrontends/old-front'] }) }, 'template.solutions'],
      [{ cron: '0 2 * * *', template: template({ workType: 'qa', qa: null }) }, 'template.qa'],
    ];
    for (const [body, field] of invalid) {
      const error = await save(r, body).catch((caught: unknown) => caught);
      expect(error, JSON.stringify(body)).toBeInstanceOf(SchedulerError);
      expect((error as SchedulerError).code).toBe('invalid');
      expect((error as SchedulerError).errors.map((e) => e.field), JSON.stringify(body)).toContain(field);
    }

    const created = await save(r, { cron: ' 0  2 * * * ', template: template({ task: 'Check the build and report.\nThen stop.' }) });
    expect(created).toMatchObject({
      name: 'nightly-check',
      description: 'Check the build and report.',
      cron: '0 2 * * *',
      paused: false,
      runs: [],
      running: false,
      nextRunAt: at(2).toISOString(),
    });
    expect(created.template).toEqual({ ...template({ task: 'Check the build and report.\nThen stop.' }) });

    // The name is unique among schedules.
    const duplicate = await save(r, { cron: '0 3 * * *', template: template() }).catch((caught: unknown) => caught);
    expect((duplicate as SchedulerError).errors).toEqual([{ field: 'template.name', message: 'a schedule named "nightly-check" already exists' }]);

    // Edit (id): new cron and template, same id; its own name is not "taken".
    const edited = await save(r, { id: created.id, cron: '30 8 * * 1-5', template: template({ task: 'Morning digest.', phase: 'integration' }) });
    expect(edited).toMatchObject({ id: created.id, name: 'nightly-check', cron: '30 8 * * 1-5', description: 'Morning digest.' });
    expect((edited.template as NewSession).phase).toBe('integration');
    expect(edited.nextRunAt).toBe(at(8, 30).toISOString());
    expect(await r.scheduler.list()).toHaveLength(1);
    const unknown = await save(r, { id: 'nope', cron: '0 2 * * *', template: template({ name: 'other' }) }).catch((caught: unknown) => caught);
    expect((unknown as SchedulerError).code).toBe('not-found');
    expect(r.errors).toEqual([]);
  });
});

describe('Scheduler · cron with a fake clock', () => {
  it('arms one timer, fires at the minute, starts a session <schedule>-<MMDD>-<HHMM> from the template and follows it to ok', async () => {
    const r = await setup(at(1, 58, 28));
    const schedule = await save(r, { cron: '0 2 * * *', template: template() });
    r.scheduler.start();
    await r.scheduler.settled();
    // The next firing is 02:00, two minutes away: the timer never sleeps longer than 60 s.
    expect(r.clock.delays()).toEqual([60_000]);
    await r.clock.advanceTo(atSecond(1, 59, 30), () => r.scheduler.settled());
    expect(await runs(r, schedule.id)).toEqual([]);
    expect(r.clock.delays()).toEqual([30_000]);

    await r.clock.advanceTo(at(2, 0), () => r.scheduler.settled());
    const [run] = await runs(r, schedule.id);
    expect(run).toMatchObject({ ts: at(2, 0).toISOString(), triggeredBy: 'cron' });
    const session = await r.w.store.sessions.get(run!.sessionId!);
    expect(session).toMatchObject({ name: 'nightly-check-0928-0200', scheduleId: schedule.id, solutions: ['mobile'], task: 'Check the build and report.' });
    // The run's session got the task + the confirmed answers (M5.2), like a session from the modal.
    const stdin = await until(async () => {
      const [argv] = await spawnedArgv(r.w.logFile);
      const lines = argv ? await stdinOf(r.w.logFile, argv.pid) : [];
      return lines.length > 0 ? lines : undefined;
    }, 'the first stdin line');
    expect(String((stdin[0] as { message: { content: string } }).message.content)).toMatch(/^Check the build and report\.\n\nSession-start answers/);

    const ok = await waitForRun(r, schedule.id, 'ok');
    expect(ok).toMatchObject({ summary: 'OK', finishedAt: at(2, 0).toISOString() });
    expect(scheduleRunEvents(r)).toEqual([
      { scheduleId: schedule.id, result: 'running' },
      { scheduleId: schedule.id, result: 'ok' },
    ]);
    const listed = (await r.scheduler.list())[0]!;
    expect(listed.runs.map((x) => [x.result, x.sessionId, x.triggeredBy])).toEqual([['ok', session!.id, 'cron']]);
    expect(listed.nextRunAt).toBe(at(2, 0, 29).toISOString());
    expect(listed.running).toBe(false);

    // Once a day: nothing more until tomorrow 02:00.
    await r.clock.advanceTo(at(23, 59), () => r.scheduler.settled());
    expect(await runs(r, schedule.id)).toHaveLength(1);
    await r.clock.advanceTo(at(2, 0, 29), () => r.scheduler.settled());
    expect((await runs(r, schedule.id)).map((x) => x.ts)).toEqual([at(2, 0).toISOString(), at(2, 0, 29).toISOString()]);
    expect(await r.w.store.sessions.getByName('nightly-check-0929-0200')).not.toBeNull();
    await waitForRun(r, schedule.id, 'ok');
    expect(r.errors).toEqual([]);
  });

  it('a clock jump fires once, never a burst; a restart does not catch up; paused schedules do not fire but Run now does; Resume looks from now', async () => {
    const r = await setup(at(1, 0));
    const schedule = await save(r, { cron: '0 * * * *', template: template({ name: 'hourly-check' }) });
    r.scheduler.start();
    await r.scheduler.settled();
    // The machine slept from 01:00 to 03:30: one firing for the whole gap (02:00 and 03:00 were due).
    r.clock.jumpTo(at(3, 30));
    await r.scheduler.tick();
    expect(await runs(r, schedule.id)).toHaveLength(1);
    await waitForRun(r, schedule.id, 'ok');

    // The service was down from 03:30 to 05:30: after the start, 04:00 and 05:00 are not run.
    await r.scheduler.stop();
    r.clock.jumpTo(at(5, 30));
    r.scheduler.start();
    await r.scheduler.settled();
    await r.scheduler.tick();
    expect(await runs(r, schedule.id)).toHaveLength(1);
    expect((await r.scheduler.get(schedule.id)).nextRunAt).toBe(at(6, 0).toISOString());

    const paused = await r.scheduler.pause(schedule.id);
    expect(paused).toMatchObject({ paused: true, nextRunAt: null });
    await r.clock.advanceTo(at(6, 30), () => r.scheduler.settled());
    expect(await runs(r, schedule.id)).toHaveLength(1);

    // Run now works while paused.
    const manual = await r.scheduler.runNow(schedule.id);
    expect(manual).toMatchObject({ triggeredBy: 'manual', ts: at(6, 30).toISOString() });
    expect((await r.w.store.sessions.get(manual.sessionId!))?.name).toBe('hourly-check-0928-0630');
    await waitForRun(r, schedule.id, 'ok');

    const resumed = await r.scheduler.resume(schedule.id);
    expect(resumed).toMatchObject({ paused: false, nextRunAt: at(7, 0).toISOString() });
    await r.clock.advanceTo(at(7, 0), () => r.scheduler.settled());
    expect((await runs(r, schedule.id)).map((x) => x.triggeredBy)).toEqual(['cron', 'manual', 'cron']);
    await waitForRun(r, schedule.id, 'ok');
    expect(r.errors).toEqual([]);
  });
});

describe('Scheduler · runs in progress, questions and failures', () => {
  it('a run still running: the cron firing is skipped and Run now refused; a question makes the run need with the question verbatim', async () => {
    const r = await setup(atSecond(9, 59, 30));
    const schedule = await save(r, { cron: '* * * * *', template: template({ name: 'long-run', task: '[fake:hang] Keep working.' }) });
    const first = await r.scheduler.runNow(schedule.id);
    await until(async () => (await r.w.store.sessions.get(first.sessionId!))?.status === 'run', 'the hang turn');
    expect((await r.scheduler.get(schedule.id)).running).toBe(true);
    const refused = await r.scheduler.runNow(schedule.id).catch((caught: unknown) => caught);
    expect(refused).toBeInstanceOf(SchedulerError);
    expect((refused as SchedulerError).code).toBe('running');
    // Retry run (M3.3) maps it to the item's `busy`.
    const busy = await scheduleRunnerFor(r.scheduler).runNow(schedule.id).catch((caught: unknown) => caught);
    expect(busy).toBeInstanceOf(SystemItemError);
    expect((busy as SystemItemError).code).toBe('busy');

    r.scheduler.start();
    await r.scheduler.settled();
    await r.clock.advanceTo(at(10, 0), () => r.scheduler.settled());
    const list = await runs(r, schedule.id);
    expect(list.map((x) => [x.result, x.triggeredBy, x.summary])).toEqual([
      ['running', 'manual', null],
      ['skipped', 'cron', SKIPPED_SUMMARY],
    ]);
    expect(list[1]?.finishedAt).toBe(at(10, 0).toISOString());
    expect(scheduleRunEvents(r).map((e) => e.result)).toEqual(['running', 'skipped']);
    await r.scheduler.stop();
    await r.w.supervisor.pause(first.sessionId!);

    // A run that asks: `need`, the first question verbatim as its summary; the session keeps it in progress.
    const asking = await save(r, { cron: '0 3 * * *', template: template({ name: 'asking-run', task: '[fake:ask-2q] Pick the colours.' }) });
    await r.scheduler.runNow(asking.id);
    const need = await waitForRun(r, asking.id, 'need');
    expect(need).toMatchObject({ summary: 'Which color should the button be?', finishedAt: null });
    expect((await r.scheduler.get(asking.id)).running).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('a failed run: result fail, the "Scheduled run failed" Inbox item (M3.3), scheduleRun fail; Retry run runs it again', async () => {
    const r = await setup(at(2, 0));
    const schedule = await save(r, { cron: '0 2 * * *', template: template({ name: 'crashing-run', task: '[fake:crash] Build.' }) });
    const run = await r.scheduler.runNow(schedule.id);
    const failed = await waitForRun(r, schedule.id, 'fail');
    expect(failed.id).toBe(run.id);
    expect(failed.summary).toMatch(/claude/);
    const items = await r.w.store.systemItems.list(['open']);
    expect(items.map((i) => [i.kind, i.source, i.scheduleRunId, i.sessionId])).toEqual([[SCHEDULE_RUN_FAILED, 'crashing-run', run.id, run.sessionId]]);
    expect(r.messages.filter((m) => m.name === 'inboxChanged').length).toBeGreaterThan(0);
    expect(scheduleRunEvents(r).map((e) => e.result)).toEqual(['running', 'fail']);
    expect((await r.scheduler.list())[0]?.running).toBe(false);

    // Retry run on the item: a new manual run (which fails again → a second item).
    await r.systemItems.act(items[0]!.id, 'retry-run');
    await until(async () => (await runs(r, schedule.id)).length === 2 && (await runs(r, schedule.id))[1]?.result === 'fail', 'the retried run');
    expect((await runs(r, schedule.id)).map((x) => x.triggeredBy)).toEqual(['manual', 'manual']);
    await until(async () => (await r.w.store.systemItems.list(['open'])).length === 1, 'the second item');
    expect(r.errors).toEqual([]);
  });

  it('a template that cannot start: the run fails at once with "Not started: …" and raises the item', async () => {
    const r = await setup(at(2, 0));
    // Stored directly: a template the API would refuse (no solutions), e.g. from an older build.
    const schedule = await r.w.store.schedules.create({ name: 'broken', cron: '0 2 * * *', template: { task: 'Do it.' } });
    const run = await r.scheduler.runNow(schedule.id);
    expect(run.result).toBe('fail');
    expect(run.sessionId).toBeNull();
    expect(run.summary).toMatch(/^Not started: /);
    expect(run.summary).toContain('choose at least one solution');
    expect((await r.w.store.systemItems.list(['open'])).map((i) => i.title)).toEqual([run.summary]);
    expect(await r.w.store.sessions.list()).toEqual([]);
  });

  it('with worktrees on, every run gets its own worktree named after its session (gap #1)', async () => {
    const r = await setup(at(2, 0));
    const schedule = await save(r, { cron: '0 2 * * *', template: template({ name: 'web-nightly', solutions: ['web-front'], worktrees: true }) });
    const run = await r.scheduler.runNow(schedule.id);
    const worktree = path.join(path.dirname(r.g.web), 'web-front-wt-web-nightly-0928-0200');
    expect((await stat(worktree)).isDirectory()).toBe(true);
    expect((await r.w.store.worktrees.list()).map((wt) => [wt.branch, wt.sessionId])).toEqual([['session/web-nightly-0928-0200', run.sessionId]]);
    await waitForRun(r, schedule.id, 'ok');
    expect(r.errors).toEqual([]);
  });
});

describe('Scheduler · restart', () => {
  it('follows unfinished runs of live sessions again and fails a start that was cut short', async () => {
    const r = await setup(at(2, 0));
    const schedule = await r.w.store.schedules.create({ name: 'restart-check', cron: '0 2 * * *', template: template({ name: 'restart-check' }) });
    const cut = await r.w.store.schedules.addRun({ scheduleId: schedule.id, ts: at(1, 0).toISOString(), result: 'running', triggeredBy: 'cron' });
    const record = await r.w.supervisor.start(newSession({ name: 'restart-check-0928-0200', solutions: ['mobile'] }));
    const live = await r.w.store.schedules.addRun({ scheduleId: schedule.id, ts: at(2, 0).toISOString(), result: 'running', sessionId: record.id, triggeredBy: 'cron' });
    // A second scheduler over the same store = the service after a restart.
    const again = new Scheduler({
      store: r.w.store,
      sessions: { config: { ...loadConfig({ env: {}, platform: 'linux', home: r.w.root, cwd: r.w.root }), workspaceRoot: r.w.workspace }, store: r.w.store, providers: {}, supervisor: r.w.supervisor, worktrees: r.worktrees },
      updates: r.w.supervisor,
      clock: r.clock,
      onError: (error) => r.errors.push(error),
    });
    try {
      // Nothing is touched before the start (a second instance that cannot bind its port never starts).
      await again.settled();
      expect((await r.w.store.schedules.getRun(cut.id))?.result).toBe('running');
      again.start();
      await again.settled();
      expect(await r.w.store.schedules.getRun(cut.id)).toMatchObject({ result: 'fail', summary: 'Not started: Switchboard stopped while the run was starting' });
      await until(async () => (await r.w.store.schedules.getRun(live.id))?.result === 'ok', 'the live run followed to ok');
    } finally {
      await again.close();
    }
    expect(r.errors).toEqual([]);
  });

  it('maps session statuses onto run results', () => {
    expect(runResultFor('run')).toBe('running');
    expect(runResultFor('need')).toBe('need');
    expect(runResultFor('done')).toBe('ok');
    expect(runResultFor('fail')).toBe('fail');
    expect(runResultFor('idle')).toBeNull();
    expect(runResultFor('paused')).toBeNull();
  });
});
