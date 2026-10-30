import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackgroundTask, Session, SessionActivity } from '../../../src/core/api.ts';
import type { SessionStatus } from '../../../src/core/model.ts';
import { liveWorkingMs, todoActualsLabel } from '../../../src/core/todo-actuals.ts';
import { openDatabase } from '../../../src/server/db/database.ts';
import { loadMigrations, migrate } from '../../../src/server/db/migrate.ts';
import { TodoRepository } from '../../../src/server/db/repos/todos.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { TodoService } from '../../../src/server/todos/service.ts';
import { isWorking, TodoWorkClock } from '../../../src/server/todos/work-clock.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D147 oracle (`docs/todos.md` → *Actual vs. estimate*): an item's actual time is its agent's
 * working time. The clock runs while the session working on it reads `run` and pauses on
 * needs-you, idle and the rest; one session's time is split equally among its items in
 * progress; a run item counts its run session; a restart closes a span at the session's last
 * event; migration 0052 marks the earlier rows open time only and calibration leaves them out.
 */

let tmp: string;
let store: Store;
let clock: number;
let bus: HubBus;
let workClock: TodoWorkClock;

const MIN = 60_000;

beforeEach(async () => {
  tmp = await makeTempDir('todos-working');
  clock = Date.parse('2026-10-30T10:00:00.000Z');
  store = await openTempStore(tmp, { now: () => new Date(clock) });
  bus = new HubBus();
  workClock = new TodoWorkClock({ store, bus, onError: (error) => { throw error; } });
  await workClock.start();
});

afterEach(async () => {
  await workClock.stop();
  await store.close();
  await removeTempDir(tmp);
});

async function session(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await store.sessions.create({ name, claudeSessionId: randomUUID(), ...extra })).id;
}

function service(): TodoService {
  return new TodoService({ store, bus, now: () => clock });
}

/** The session's status as the hub publishes it (only what the clock reads). */
async function status(id: string, value: SessionStatus, activity: SessionActivity | null = null): Promise<void> {
  bus.publish('sessionUpdated', { id, status: value, closedAt: null, activity } as unknown as Session);
  // The clock's write runs at once; let its promise settle.
  await Promise.resolve();
}

async function startItem(todos: TodoService, sessionId: string, title: string, estimate = 30): Promise<string> {
  const { todo } = await todos.add(sessionId, { title, estimateMinutes: estimate }, 'agent');
  await todos.update(sessionId, todo.id, { state: 'in_progress' }, 'agent');
  return todo.id;
}

describe('the working clock (D147)', () => {
  it('counts while the session works; pauses on needs-you and idle; resumes on run', async () => {
    const todos = service();
    const id = await session('a');
    const item = await startItem(todos, id, 'Clocked');
    clock += 5 * MIN; // in progress, not working yet
    await status(id, 'run');
    clock += 10 * MIN;
    await status(id, 'need'); // a question / a turn that ended waiting for the developer
    clock += 8 * 60 * MIN; // the night
    await status(id, 'run');
    clock += 4 * MIN;
    await status(id, 'idle');
    clock += 30 * MIN;
    await status(id, 'run');
    clock += MIN;
    const done = (await todos.update(id, item, { state: 'done' }, 'agent')).todo;
    expect(done.workingMs).toBe(15 * MIN);
    expect(done.actualMs).toBe((5 + 10 + 480 + 4 + 30 + 1) * MIN);
    expect(todoActualsLabel(done)).toBe('took 15m (open 8h 50m)');
    expect((await store.todos.actualsFor([id])).get(id)).toEqual([{ estimateMinutes: 30, actualMs: 530 * MIN, actualTokens: null, workingMs: 15 * MIN }]);
    // Done: the session working on goes on, the item's time does not.
    clock += 60 * MIN;
    expect((await todos.get(id, item)).workingMs).toBe(15 * MIN);
  });

  it('done, fail and paused stop it too; open time back in open counts neither', async () => {
    const todos = service();
    const id = await session('a');
    const item = await startItem(todos, id, 'Stops');
    for (const stop of ['done', 'fail', 'paused'] as const) {
      await status(id, 'run');
      clock += 2 * MIN;
      await status(id, stop);
      clock += 60 * MIN;
    }
    await status(id, 'run');
    await todos.update(id, item, { state: 'open' });
    clock += 30 * MIN;
    await todos.update(id, item, { state: 'in_progress' }, 'agent');
    clock += 3 * MIN;
    expect((await todos.update(id, item, { state: 'done' }, 'agent')).todo.workingMs).toBe(9 * MIN);
  });

  it('splits one session’s working time equally among its items in progress', async () => {
    const todos = service();
    const id = await session('a');
    const first = await startItem(todos, id, 'First');
    await status(id, 'run');
    clock += 10 * MIN; // first alone: 10
    const second = await startItem(todos, id, 'Second');
    clock += 20 * MIN; // both: 10 each
    const one = (await todos.update(id, first, { state: 'done' }, 'agent')).todo;
    clock += 6 * MIN; // second alone: 6
    const two = (await todos.update(id, second, { state: 'done' }, 'agent')).todo;
    expect(one.workingMs).toBe(20 * MIN);
    expect(two.workingMs).toBe(16 * MIN);
    // Removing an item in progress gives its share back.
    const third = await startItem(todos, id, 'Third');
    const fourth = await startItem(todos, id, 'Fourth');
    clock += 10 * MIN;
    await todos.remove(id, fourth);
    clock += 10 * MIN;
    expect((await todos.update(id, third, { state: 'done' }, 'agent')).todo.workingMs).toBe(15 * MIN);
  });

  it('a run item counts its run session’s working time, not its source’s', async () => {
    const todos = service();
    const source = await session('source');
    const run = await session('run');
    const { todo } = await todos.add(source, { title: 'Runs', estimateMinutes: 20 }, 'developer');
    await status(source, 'run');
    await todos.beginRun(source, todo.id, run);
    clock += 30 * MIN; // the source works, the run does not yet
    await status(run, 'run');
    clock += 12 * MIN;
    await status(run, 'need');
    clock += 60 * MIN;
    const done = (await todos.update(source, todo.id, { state: 'done' }, 'agent')).todo;
    expect(done.workingMs).toBe(12 * MIN);
    // The source's own item in progress is not split with the run item.
    const own = await startItem(todos, source, 'Own');
    clock += 5 * MIN;
    expect((await todos.update(source, own, { state: 'done' }, 'agent')).todo.workingMs).toBe(5 * MIN);
  });

  it('a restart mid-span closes it at the session’s last event, not at the restart', async () => {
    const todos = service();
    const id = await session('a');
    const item = await startItem(todos, id, 'Crash');
    await status(id, 'run');
    clock += 7 * MIN;
    await store.events.append({ sessionId: id, kind: 'text', ts: new Date(clock).toISOString(), payload: { type: 'assistant', text: 'working' } });
    clock += 3 * 60 * MIN; // the crash: nothing closed the span
    // A new start: a fresh clock (the repository forgets which sessions worked).
    const restarted = new TodoWorkClock({ store, bus: new HubBus() });
    await restarted.start();
    expect(store.todos.isWorking(id)).toBe(false);
    const record = await store.todos.get(item);
    expect(record).toMatchObject({ workingMs: 7 * MIN, workingSpanStartedAt: null });
    // Resumed and working again: the clock goes on from there.
    await restarted.stop();
  });

  it('a stop closes the open spans now', async () => {
    const todos = service();
    const id = await session('a');
    const item = await startItem(todos, id, 'Stop');
    await status(id, 'run');
    clock += 4 * MIN;
    await workClock.stop();
    expect(await store.todos.get(item)).toMatchObject({ workingMs: 4 * MIN, workingSpanStartedAt: null });
    clock += 60 * MIN;
    await workClock.start();
    expect((await store.todos.get(item))?.workingMs).toBe(4 * MIN);
  });

  it('a closed session does not work', async () => {
    const todos = service();
    const id = await session('a');
    const item = await startItem(todos, id, 'Closed');
    bus.publish('sessionUpdated', { id, status: 'run', closedAt: '2026-10-30T09:00:00.000Z' } as unknown as Session);
    await Promise.resolve();
    clock += 5 * MIN;
    expect((await todos.update(id, item, { state: 'done' }, 'agent')).todo.workingMs).toBe(0);
  });
});

function task(kind: BackgroundTask['kind'], waiting = true): BackgroundTask {
  return { id: `t-${kind}`, toolUseId: `u-${kind}`, kind, summary: kind, startedAt: new Date(clock).toISOString(), github: false, waiting, ...(kind === 'wakeup' ? { wakeAt: new Date(clock + 60 * MIN).toISOString() } : {}) } as BackgroundTask;
}

/** The main turn is over; these background tasks are pending (D30's `background` activity). */
function background(...tasks: BackgroundTask[]): SessionActivity {
  const at = new Date(clock).toISOString();
  return { turnStartedAt: at, state: 'background', since: at, tool: null, summary: null, thinkingTokens: null, agents: {}, background: tasks } as unknown as SessionActivity;
}

/** A turn running a tool. */
function turnRunning(): SessionActivity {
  const at = new Date(clock).toISOString();
  return { turnStartedAt: at, state: 'tool', since: at, tool: 'Bash', summary: 'npm test', thinkingTokens: null, agents: {}, background: [] } as unknown as SessionActivity;
}

describe('wake-ups pause the clock (D147, ruling 2026-10-30)', () => {
  it('isWorking: run, unless it only waits for its wake-up; subagents next to a wake-up still work', () => {
    expect(isWorking('run', null)).toBe(true);
    expect(isWorking('run', turnRunning())).toBe(true);
    expect(isWorking('run', background(task('wakeup')))).toBe(false);
    expect(isWorking('run', background(task('wakeup'), task('agent')))).toBe(true);
    expect(isWorking('run', background(task('wakeup'), task('task')))).toBe(true);
    expect(isWorking('need', null)).toBe(false);
    expect(isWorking('run', null, true)).toBe(false);
  });

  it('a session waiting for its wake-up adds no working time; the turn the wake-up starts does', async () => {
    const todos = service();
    const id = await session('a');
    const item = await startItem(todos, id, 'Wakes up');
    await status(id, 'run', turnRunning());
    clock += 5 * MIN;
    // The turn ended with a ScheduleWakeup: still `run` (D143), but waiting on a timer.
    bus.publish('activity', { sessionId: id, activity: background(task('wakeup')) });
    await Promise.resolve();
    clock += 60 * MIN;
    // It fired: a new turn.
    bus.publish('activity', { sessionId: id, activity: turnRunning() });
    await Promise.resolve();
    clock += 3 * MIN;
    // A status update carrying the wake-up wait pauses it too.
    await status(id, 'run', background(task('wakeup')));
    clock += 30 * MIN;
    expect((await todos.update(id, item, { state: 'done' }, 'agent')).todo.workingMs).toBe(8 * MIN);
  });
});

describe('live working time (D147, ruling 2026-10-30)', () => {
  it('an item in progress carries its running span and its share; the UI adds the time since', async () => {
    const changed: string[] = [];
    await workClock.stop();
    workClock = new TodoWorkClock({ store, bus, changed: (sessionId) => changed.push(sessionId) });
    await workClock.start();
    const todos = service();
    const id = await session('a');
    const first = await startItem(todos, id, 'Live one');
    clock += 2 * MIN;
    await status(id, 'run');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The clock started: the list is published so the cards pick up the running span.
    expect(changed).toContain(id);
    const started = new Date(clock).toISOString();
    expect(await todos.get(id, first)).toMatchObject({ workingMs: 0, workingSince: started, workingShare: 1 });
    clock += 4 * MIN;
    const second = await startItem(todos, id, 'Live two');
    const one = await todos.get(id, first);
    expect(one).toMatchObject({ workingMs: 4 * MIN, workingSince: new Date(clock).toISOString(), workingShare: 2 });
    clock += 6 * MIN;
    // Live: 4 closed + 6 shared by two.
    expect(liveWorkingMs(one, clock)).toBe(7 * MIN);
    expect(liveWorkingMs(await todos.get(id, second), clock)).toBe(3 * MIN);
    await status(id, 'need');
    expect(await todos.get(id, first)).toMatchObject({ workingMs: 7 * MIN, workingSince: null, workingShare: null });
    clock += 60 * MIN;
    expect(liveWorkingMs(await todos.get(id, first), clock)).toBe(7 * MIN);
  });
});

describe('calibration from working time (D147)', () => {
  it('per band, this session’s when it has enough, else its folder’s', async () => {
    const todos = service();
    const a = await session('a', { root: '/repo/one', rootKind: 'repo' });
    const b = await session('b', { root: '/repo/one', rootKind: 'repo' });
    await status(a, 'run');
    const finish = async (estimate: number, minutes: number): Promise<void> => {
      const item = await startItem(todos, a, `t${clock}`, estimate);
      clock += minutes * MIN;
      await todos.update(a, item, { state: 'done' }, 'agent');
    };
    expect(await todos.calibration(a)).toBeNull();
    for (let i = 0; i < 3; i++) await finish(30, 15);
    for (let i = 0; i < 3; i++) await finish(120, 240);
    expect(await todos.calibration(a)).toBe('Calibration (last 6 finished, this session): ≤1 h estimates took 0.5× · 1–4 h took 2.0× · >4 h: not enough data');
    expect(await todos.calibration(b)).toBe('Calibration (last 6 finished, this folder): ≤1 h estimates took 0.5× · 1–4 h took 2.0× · >4 h: not enough data');
  });
});

describe('migration 0052 (D147)', () => {
  it('marks the earlier rows open time only (left out of calibration); items not done start their clock at the upgrade', async () => {
    const shipped = await loadMigrations();
    const db = await openDatabase(':memory:');
    migrate(db, shipped.filter((m) => m.version <= 51));
    const ts = '2026-10-20T09:00:00.000Z';
    db.prepare('INSERT INTO sessions (id, name, claude_session_id, cwd, root, root_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('s', 'old', 'c', '/tmp/x', '/tmp/x', 'repo', ts, ts);
    const actual = db.prepare('INSERT INTO todo_actuals (todo_id, session_id, folder, title, estimate_minutes, actual_ms, actual_tokens, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 5; i++) actual.run(`old${i}`, 's', '/tmp/x', `Old ${i}`, 30, 100 * 60 * MIN, null, ts);
    const item = db.prepare(
      'INSERT INTO session_todos (id, session_id, title, plan, priority, estimate_minutes, state, added_by, position, created_at, updated_at, done_at, started_at, started_by, started_first_at, span_started_at, actual_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    item.run('p', 's', 'In progress', 'No plan', 'medium', 30, 'in_progress', 'agent', 0, ts, ts, null, ts, 'agent', ts, ts, 60 * MIN);
    item.run('d', 's', 'Done', 'No plan', 'medium', 30, 'done', 'agent', 1, ts, ts, ts, ts, 'agent', ts, null, 90 * MIN);
    item.run('o', 's', 'Never', 'No plan', 'medium', 30, 'open', 'agent', 2, ts, ts, null, null, null, null, null, null);
    item.run('r', 's', 'Back in open', 'No plan', 'medium', 30, 'open', 'agent', 3, ts, ts, null, null, null, ts, null, 20 * MIN);
    expect(migrate(db, shipped.filter((m) => m.version <= 52)).applied).toEqual([52]);
    expect(db.prepare('SELECT DISTINCT measure, working_ms FROM todo_actuals').all().map((row) => ({ ...row }))).toEqual([{ measure: 'open', working_ms: null }]);
    expect(db.prepare('SELECT id, working_ms, working_span_started_at, actual_ms FROM session_todos ORDER BY position').all().map((row) => ({ ...row }))).toEqual([
      { id: 'p', working_ms: 0, working_span_started_at: null, actual_ms: 60 * MIN },
      { id: 'd', working_ms: null, working_span_started_at: null, actual_ms: 90 * MIN },
      { id: 'o', working_ms: null, working_span_started_at: null, actual_ms: null },
      { id: 'r', working_ms: 0, working_span_started_at: null, actual_ms: 20 * MIN },
    ]);
    expect(() => db.prepare(`UPDATE todo_actuals SET measure = 'other'`).run()).toThrow(/CHECK/);
    // Calibration leaves the open-time rows out; the totals keep them as open time.
    const repo = new TodoRepository({ db, now: () => '2026-10-30T10:00:00.000Z' });
    expect(await repo.recentEstimated({ sessionId: 's' }, 30)).toEqual([]);
    expect((await repo.actualsFor(['s'])).get('s')?.every((row) => row.workingMs === null)).toBe(true);
    // The item in progress at the upgrade: working time from now on, its open time kept.
    await repo.setWorking('s', true, '2026-10-30T10:00:00.000Z');
    await repo.setWorking('s', false, '2026-10-30T10:06:00.000Z');
    expect(await repo.get('p')).toMatchObject({ workingMs: 6 * MIN, actualMs: 60 * MIN });
    expect(await repo.get('r')).toMatchObject({ workingMs: 0 });
    // A done item from before the upgrade (open time only), reopened: its clock starts at the reopen.
    await repo.setWorking('s', true, '2026-10-30T10:06:00.000Z');
    expect(await repo.setState('d', 'in_progress', 'agent')).toMatchObject({ workingMs: 0 });
    await repo.setWorking('s', false, '2026-10-30T10:16:00.000Z');
    const finished = await repo.setState('d', 'done', 'agent');
    // The repository's clock reads 10:00, so the shared span runs 10:00 → 10:16: 16 working minutes, two items: 8 each.
    expect(finished?.workingMs).toBe(8 * MIN);
    const row = db.prepare("SELECT measure, working_ms, actual_ms FROM todo_actuals WHERE todo_id = 'd'").get();
    // Only the new working time; the old open time stays in the open time (90 min + the new span).
    expect({ ...row }).toMatchObject({ measure: 'working', working_ms: finished?.workingMs });
    expect(Number(row?.['actual_ms'])).toBe(90 * MIN);
    db.close();
  });
});
