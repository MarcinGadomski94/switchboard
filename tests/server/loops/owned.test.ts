/**
 * D94 oracle (unit with a fake clock, on the real code path): the LoopService over
 * a real store and the real SessionSupervisor with fake-claude as the CLI. Only
 * time is fake (`FakeClock`): it drives the loops' timer. A firing goes through the
 * supervisor's message path exactly as app.ts wires it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { OwnedLoop } from '../../../src/core/api.ts';
import type { UserPayload } from '../../../src/core/event-payload.ts';
import { NO_ATTACHMENTS } from '../../../src/server/attachments/service.ts';
import { DOWN_SKIP, LoopError, LoopService, PENDING_SKIP } from '../../../src/server/loops/owned.ts';
import { FakeClock } from '../../helpers/clock.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, until, waitForStatus } from '../../helpers/supervisor.ts';

/** 2026-10-09 at `hour:minute` local. */
const at = (hour: number, minute = 0, second = 0): Date => new Date(2026, 9, 9, hour, minute, second, 0);

interface Rig {
  readonly w: SupervisorWorld;
  readonly clock: FakeClock;
  loops: LoopService;
  readonly announced: string[];
  readonly errors: unknown[];
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.loops.close();
  await rig?.w.cleanup();
  rig = undefined;
});

function service(w: SupervisorWorld, clock: FakeClock, announced: string[], errors: unknown[]): LoopService {
  return new LoopService({
    store: w.store,
    clock,
    announce: async (sessionId) => {
      announced.push(sessionId);
    },
    // app.ts's delivery for a supervised session.
    deliver: async (session, text, mark) => {
      await w.supervisor.sendMessage(session.id, text, 'service', NO_ATTACHMENTS, { loop: mark });
    },
    onError: (error) => errors.push(error),
  });
}

async function setup(start: Date): Promise<Rig> {
  const w = await makeSupervisorWorld();
  const clock = new FakeClock(start);
  const announced: string[] = [];
  const errors: unknown[] = [];
  const loops = service(w, clock, announced, errors);
  loops.start();
  await loops.settled();
  rig = { w, clock, loops, announced, errors };
  return rig;
}

/** A started session that finished its first turn (idle, `done`). */
async function idleSession(r: Rig, name: string, task = 'Say OK.'): Promise<string> {
  const session = await r.w.supervisor.start(newSession({ name, task, solutions: ['mobile'], coordination: null }), r.w.place);
  await waitForStatus(r.w.store, session.id, ['done', 'idle']);
  return session.id;
}

/** The session's loop firings (user messages with a loop mark), oldest first. */
async function firings(r: Rig, sessionId: string): Promise<UserPayload[]> {
  const events = await r.w.store.events.list(sessionId);
  return events.map((event) => event.payload as UserPayload).filter((payload) => payload?.type === 'user' && payload.loop !== undefined);
}

async function loopOf(r: Rig, sessionId: string, id: string): Promise<OwnedLoop> {
  return r.loops.get(sessionId, id);
}

async function advance(r: Rig, to: Date): Promise<void> {
  await r.clock.advanceTo(to, () => r.loops.settled());
  await r.loops.settled();
}

describe('LoopService · create and validation (D94)', () => {
  it('creates with exactly one schedule; refuses bad input with field errors; caps the live loops per session', async () => {
    const r = await setup(at(10));
    const id = await idleSession(r, 'create-check');
    const refused: Array<[unknown, string]> = [
      [{ cron: '*/5 * * * *' }, 'prompt'],
      [{ prompt: 'x' }, 'schedule'],
      [{ prompt: 'x', cron: '*/5 * * * *', every_minutes: 5 }, 'schedule'],
      [{ prompt: 'x', cron: '61 * * * *' }, 'cron'],
      [{ prompt: 'x', every_minutes: 0 }, 'every_minutes'],
      [{ prompt: 'x', every_minutes: 1.5 }, 'every_minutes'],
      [{ prompt: 'x', at: '2026-10-09T09:00:00' }, 'at'],
      [{ prompt: 'x', at: 'tomorrow' }, 'at'],
      [{ prompt: 'x', every_minutes: 5, expires_at: '2026-10-09T09:59:00' }, 'expires_at'],
      [{ prompt: 'x', every_minutes: 5, max_runs: -1 }, 'max_runs'],
      [{ prompt: 'x', every_minutes: 5, label: 'two\nlines' }, 'label'],
    ];
    for (const [body, field] of refused) {
      const error = await r.loops.create(id, body, 'agent').catch((caught: unknown) => caught);
      expect(error, JSON.stringify(body)).toBeInstanceOf(LoopError);
      expect((error as LoopError).status).toBe(422);
      expect((error as LoopError).errors.map((e) => e.field), JSON.stringify(body)).toContain(field);
    }
    const created = await r.loops.create(id, { prompt: '  Check CI.\nReport failures.  ', every_minutes: 30 }, 'agent');
    expect(created).toMatchObject({
      sessionId: id,
      label: null,
      title: 'Check CI.',
      prompt: 'Check CI.\nReport failures.',
      schedule: { kind: 'every', minutes: 30 },
      scheduleText: 'every 30 min',
      expiresAt: null,
      maxRuns: null,
      state: 'active',
      runs: 0,
      skipped: 0,
      nextFireAt: at(10, 30).toISOString(),
      createdBy: 'agent',
    });
    expect(created.id).toMatch(/^[a-f0-9]{10}$/);
    const cron = await r.loops.create(id, { prompt: 'Nightly', cron: '0 2 * * *', label: 'Nightly check', max_runs: 3, expires_at: '2026-10-12T00:00:00' }, 'developer');
    expect(cron).toMatchObject({ schedule: { kind: 'cron', cron: '0 2 * * *' }, scheduleText: '02:00 daily', title: 'Nightly check', maxRuns: 3, nextFireAt: new Date(2026, 9, 10, 2, 0).toISOString(), createdBy: 'developer' });
    const once = await r.loops.create(id, { prompt: 'Once', at: new Date(2026, 9, 9, 15, 0).toISOString() }, 'agent');
    expect(once).toMatchObject({ schedule: { kind: 'at' }, nextFireAt: at(15).toISOString() });
    expect(r.announced).toContain(id);
    // A session's live loops are capped.
    for (let i = (await r.loops.list(id)).length; i < 20; i++) await r.loops.create(id, { prompt: `p${i}`, every_minutes: 60 }, 'agent');
    expect(await r.loops.create(id, { prompt: 'one more', every_minutes: 60 }, 'agent').catch((caught: LoopError) => [caught.status, caught.code])).toEqual([409, 'too-many']);
    // Unknown session.
    expect(await r.loops.create('nope', { prompt: 'x', every_minutes: 5 }, 'agent').catch((caught: LoopError) => caught.status)).toBe(404);
  });
});

describe('LoopService · firing (D94)', () => {
  it('idle: sends the prompt as a service message marked with the loop and its run; the schedule keeps its rhythm', async () => {
    const r = await setup(at(10));
    const id = await idleSession(r, 'idle-fire');
    const loop = await r.loops.create(id, { prompt: 'Check the build.', every_minutes: 1, label: 'Build watch' }, 'agent');
    await advance(r, at(10, 1));
    await waitForStatus(r.w.store, id, ['done', 'idle']);
    const sent = await firings(r, id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ text: 'Check the build.', origin: 'service', loop: { id: loop.id, label: 'Build watch', run: 1 } });
    expect(await loopOf(r, id, loop.id)).toMatchObject({ runs: 1, skipped: 0, lastFiredAt: at(10, 1).toISOString(), nextFireAt: at(10, 2).toISOString(), lastError: null });
    await advance(r, at(10, 2));
    await waitForStatus(r.w.store, id, ['done', 'idle']);
    expect((await firings(r, id)).map((p) => p.loop?.run)).toEqual([1, 2]);
  });

  it('busy: the firing is queued behind the turn; while it waits the next due time is skipped (never stacked); after it was taken up the next fires', async () => {
    const r = await setup(at(10));
    const id = await idleSession(r, 'busy-fire');
    const loop = await r.loops.create(id, { prompt: 'Status?', every_minutes: 1 }, 'agent');
    // A long turn runs.
    await r.w.supervisor.sendMessage(id, '[fake:hold 4] Think for a while.');
    await waitForStatus(r.w.store, id, ['run']);
    await advance(r, at(10, 1));
    const first = await firings(r, id);
    expect(first).toHaveLength(1);
    expect(first[0]?.queued).toBe('turn');
    await advance(r, at(10, 2));
    expect(await firings(r, id)).toHaveLength(1);
    expect(await loopOf(r, id, loop.id)).toMatchObject({ runs: 1, skipped: 1, lastError: PENDING_SKIP, nextFireAt: at(10, 3).toISOString() });
    // The held turn ends; the queued firing runs as its own turn and is taken up.
    await until(async () => ((await firings(r, id))[0]?.queued === undefined ? true : undefined), 'the firing to be taken up', 15_000);
    await waitForStatus(r.w.store, id, ['done', 'idle'], 15_000);
    await advance(r, at(10, 3));
    expect((await firings(r, id)).map((p) => p.loop?.run)).toEqual([1, 2]);
    expect(await loopOf(r, id, loop.id)).toMatchObject({ runs: 2, skipped: 1, lastError: null });
  });

  it('paused: the firing resumes the session (as a message to a paused session does)', async () => {
    const r = await setup(at(10));
    const id = await idleSession(r, 'paused-fire');
    await r.w.supervisor.pause(id);
    expect((await r.w.store.sessions.get(id))?.status).toBe('paused');
    expect(r.w.supervisor.isLive(id)).toBe(false);
    const loop = await r.loops.create(id, { prompt: 'Wake up and check.', every_minutes: 5 }, 'developer');
    await advance(r, at(10, 5));
    expect(r.w.supervisor.isLive(id)).toBe(true);
    await waitForStatus(r.w.store, id, ['done', 'idle'], 15_000);
    expect((await firings(r, id))[0]).toMatchObject({ text: 'Wake up and check.', loop: { id: loop.id, run: 1 } });
    expect((await loopOf(r, id, loop.id)).runs).toBe(1);
  });

  it('closed: the loop ends ("session closed") at its next due time; Run now is refused', async () => {
    const r = await setup(at(10));
    const id = await idleSession(r, 'closed-fire');
    const loop = await r.loops.create(id, { prompt: 'Ping', every_minutes: 1 }, 'agent');
    await r.w.supervisor.close(id, { confirm: true });
    expect(await r.loops.runNow(id, loop.id).catch((caught: LoopError) => [caught.status, caught.code])).toEqual([409, 'closed']);
    await advance(r, at(10, 1));
    expect(await loopOf(r, id, loop.id)).toMatchObject({ state: 'ended', endedReason: 'session closed', nextFireAt: null, runs: 0 });
    expect(await firings(r, id)).toEqual([]);
    // An ended loop can be removed, not changed.
    expect(await r.loops.update(id, loop.id, { prompt: 'x' }).catch((caught: LoopError) => caught.code)).toBe('ended');
    await r.loops.cancel(id, loop.id);
    expect(await r.loops.list(id)).toEqual([]);
  });

  it('expires at expires_at (default: none) and ends after max_runs', async () => {
    const r = await setup(at(10));
    const id = await idleSession(r, 'limits');
    const expiring = await r.loops.create(id, { prompt: 'A', every_minutes: 1, expires_at: at(10, 1, 30).toISOString() }, 'agent');
    const limited = await r.loops.create(id, { prompt: 'B', every_minutes: 1, max_runs: 2, label: 'twice' }, 'agent');
    const forever = await r.loops.create(id, { prompt: 'C', every_minutes: 60 }, 'agent');
    expect(forever.expiresAt).toBeNull();
    await advance(r, at(10, 1));
    await waitForStatus(r.w.store, id, ['done', 'idle'], 15_000);
    await advance(r, at(10, 1, 30));
    expect(await loopOf(r, id, expiring.id)).toMatchObject({ state: 'ended', endedReason: 'expired', runs: 1 });
    await waitForStatus(r.w.store, id, ['done', 'idle'], 15_000);
    await advance(r, at(10, 2));
    await waitForStatus(r.w.store, id, ['done', 'idle'], 15_000);
    expect(await loopOf(r, id, limited.id)).toMatchObject({ state: 'ended', endedReason: 'ran 2 times (max_runs)', runs: 2 });
    await advance(r, at(10, 5));
    expect((await firings(r, id)).filter((p) => p.loop?.id === limited.id)).toHaveLength(2);
    expect(await loopOf(r, id, forever.id)).toMatchObject({ state: 'active', runs: 0 });
  });

  it('a one-shot fires once at its time and ends', async () => {
    const r = await setup(at(10));
    const id = await idleSession(r, 'one-shot');
    const loop = await r.loops.create(id, { prompt: 'Once only', at: at(10, 3).toISOString() }, 'agent');
    await advance(r, at(10, 3));
    await waitForStatus(r.w.store, id, ['done', 'idle'], 15_000);
    expect(await loopOf(r, id, loop.id)).toMatchObject({ state: 'ended', endedReason: 'its one-time firing ran', runs: 1 });
    await advance(r, at(11));
    expect(await firings(r, id)).toHaveLength(1);
  });
});

describe('LoopService · downtime, restart and moves (D94)', () => {
  it('Switchboard was down: no catch-up burst; the missed due times are skipped and the next one fires; the loop survives the restart', async () => {
    const r = await setup(at(10));
    const id = await idleSession(r, 'restart');
    const loop = await r.loops.create(id, { prompt: 'Tick', every_minutes: 10 }, 'agent');
    const once = await r.loops.create(id, { prompt: 'Missed one-shot', at: at(10, 30).toISOString() }, 'agent');
    // The process stops; it comes back 65 minutes later.
    await r.loops.close();
    r.clock.jumpTo(at(11, 5));
    r.loops = service(r.w, r.clock, r.announced, r.errors);
    r.loops.start();
    await r.loops.settled();
    expect(await firings(r, id)).toEqual([]);
    expect(await loopOf(r, id, loop.id)).toMatchObject({ state: 'active', runs: 0, skipped: 6, lastError: DOWN_SKIP, nextFireAt: at(11, 10).toISOString() });
    expect(await loopOf(r, id, once.id)).toMatchObject({ state: 'ended', endedReason: `missed: ${DOWN_SKIP}`, skipped: 1 });
    await advance(r, at(11, 10));
    await waitForStatus(r.w.store, id, ['done', 'idle'], 15_000);
    expect((await firings(r, id)).map((p) => p.loop?.run)).toEqual([1]);
    expect(r.errors).toEqual([]);
  });

  it('cancel / pause / resume / update / run now', async () => {
    const r = await setup(at(10));
    const id = await idleSession(r, 'commands');
    const loop = await r.loops.create(id, { prompt: 'Look', every_minutes: 15 }, 'agent');
    const paused = await r.loops.pause(id, loop.id);
    expect(paused).toMatchObject({ state: 'paused', nextFireAt: null });
    await advance(r, at(10, 20));
    expect(await firings(r, id)).toEqual([]);
    expect(await r.loops.resume(id, loop.id)).toMatchObject({ state: 'active', nextFireAt: at(10, 35).toISOString(), skipped: 0 });
    const updated = await r.loops.update(id, loop.id, { cron: '0 * * * *', label: 'Hourly look', expires_at: null, max_runs: 5 });
    expect(updated).toMatchObject({ schedule: { kind: 'cron', cron: '0 * * * *' }, label: 'Hourly look', maxRuns: 5, nextFireAt: at(11).toISOString() });
    expect(await r.loops.update(id, loop.id, {}).catch((caught: LoopError) => caught.status)).toBe(422);
    const ran = await r.loops.runNow(id, loop.id);
    expect(ran).toMatchObject({ runs: 1, nextFireAt: at(11).toISOString() });
    expect((await firings(r, id))[0]).toMatchObject({ text: 'Look', loop: { label: 'Hourly look', run: 1 } });
    await waitForStatus(r.w.store, id, ['done', 'idle'], 15_000);
    await r.loops.cancel(id, loop.id);
    expect(await r.loops.list(id)).toEqual([]);
    expect(await r.loops.cancel(id, loop.id).catch((caught: LoopError) => caught.status)).toBe(404);
    // Another session's loop is not found through this session.
    const other = await idleSession(r, 'other');
    const theirs = await r.loops.create(other, { prompt: 'Theirs', every_minutes: 5 }, 'agent');
    expect(await r.loops.pause(id, theirs.id).catch((caught: LoopError) => caught.status)).toBe(404);
  });

  it('D83: the loops move to the fresh session that continues it (same ids, runs and schedule)', async () => {
    const r = await setup(at(10));
    const from = await idleSession(r, 'old-context');
    const to = await idleSession(r, 'fresh-context');
    const loop = await r.loops.create(from, { prompt: 'Carry on', every_minutes: 5 }, 'agent');
    expect(await r.loops.moveAll(from, to)).toBe(1);
    expect(await r.loops.list(from)).toEqual([]);
    expect((await r.loops.list(to)).map((l) => [l.id, l.prompt])).toEqual([[loop.id, 'Carry on']]);
    await advance(r, at(10, 5));
    await waitForStatus(r.w.store, to, ['done', 'idle'], 15_000);
    expect((await firings(r, to)).map((p) => p.loop?.id)).toEqual([loop.id]);
  });

  it('D65: portable loops are re-created on the target (new ids, next from now) and ended on the source', async () => {
    const r = await setup(at(10));
    const source = await idleSession(r, 'source');
    const target = await idleSession(r, 'target');
    await r.loops.create(source, { prompt: 'Keep going', every_minutes: 5, label: 'mover', max_runs: 9 }, 'agent');
    const paused = await r.loops.create(source, { prompt: 'Paused one', cron: '0 9 * * *' }, 'developer');
    await r.loops.pause(source, paused.id);
    const carried = await r.loops.portable(source);
    expect(carried.map((l) => [l.prompt, l.state, l.createdBy])).toEqual([
      ['Keep going', 'active', 'agent'],
      ['Paused one', 'paused', 'developer'],
    ]);
    expect(await r.loops.importLoops(target, JSON.parse(JSON.stringify(carried)) as unknown[])).toBe(2);
    await r.loops.endAll(source, 'the session moved to mac-studio');
    expect((await r.loops.list(source)).map((l) => [l.state, l.endedReason])).toEqual([
      ['ended', 'the session moved to mac-studio'],
      ['ended', 'the session moved to mac-studio'],
    ]);
    const moved = await r.loops.list(target);
    expect(moved.map((l) => [l.title, l.state, l.maxRuns, l.nextFireAt])).toEqual([
      ['mover', 'active', 9, at(10, 5).toISOString()],
      ['Paused one', 'paused', null, null],
    ]);
  });
});
