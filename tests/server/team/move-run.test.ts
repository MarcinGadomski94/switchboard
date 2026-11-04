import { afterEach, describe, expect, it } from 'vitest';
import type { Machine } from '../../../src/core/peers.ts';
import type { TakeoverRun, TakeoverStepId } from '../../../src/core/takeover.ts';
import type { TeamMoveRun } from '../../../src/core/team.ts';
import { NO_ATTACHMENTS } from '../../../src/server/attachments/service.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { LoopService } from '../../../src/server/loops/owned.ts';
import type { TakeoverRunner } from '../../../src/server/takeover/runner.ts';
import { TakeoverError } from '../../../src/server/takeover/service.ts';
import { TeamError, type TeamPeers, TeamService } from '../../../src/server/team/service.ts';
import { TodoService } from '../../../src/server/todos/service.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D100 × D65 · a member's move against a stand-in take-over (the real one with two
 * machines is `move.test.ts`): a target on an older Switchboard (the take-over's
 * peer routes missing) is refused with that reason; a run that fails, or whose
 * take-over run is gone, ends `failed` with the step, the reason and where the
 * member still runs, and the member is unchanged; the move uses the folders the
 * check used.
 */

const SELF = { id: 'm-self-0001', name: 'Desk' };
const PC = 'm-pc-0001';

interface Rig {
  readonly world: SupervisorWorld;
  readonly team: TeamService;
  readonly loops: LoopService;
  readonly todos: TodoService;
  readonly takeover: FakeTakeover;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.team.close();
  await rig?.loops.close();
  rig?.todos.close();
  await rig?.world.cleanup();
  rig = undefined;
});

/** The parts of the take-over runner a move uses, scripted. */
interface FakeTakeover {
  preview: (request: Record<string, unknown>) => Promise<unknown>;
  run: TakeoverRun | null;
  readonly started: Array<Record<string, unknown>>;
}

function failedRun(step: TakeoverStepId, message: string, rolledBack: boolean | null, notes: string[] = []): TakeoverRun {
  return { id: 'tk-1', state: 'failed', steps: [], error: { step, message }, rolledBack, rollbackNotes: notes, result: null, leftovers: [], log: [] };
}

async function setup(): Promise<Rig> {
  const world = await makeSupervisorWorld();
  const bus = new HubBus();
  const todos = new TodoService({ store: world.store, bus });
  const loops = new LoopService({ store: world.store, deliver: async (session, text, mark) => void (await world.supervisor.sendMessage(session.id, text, 'service', NO_ATTACHMENTS, { loop: mark })) });
  const machines: Machine[] = [{ id: PC, name: 'Office PC', state: 'online' } as Machine];
  const peers = {
    self: async () => SELF,
    machines: async () => machines,
    remoteSessions: () => [],
    remoteArchived: () => [],
    remoteInbox: () => [],
    forward: async () => ({ status: 404, body: { error: 'not-found', message: 'no route here' } }),
    ask: async () => ({ status: null, reason: 'not here' }),
    hasMachine: (id: string) => id === PC,
    sidebarChanged: () => undefined,
  } as unknown as TeamPeers;
  const fake: FakeTakeover = { preview: async () => ({ ok: true, blockers: [], placement: null, remembered: false }), run: null, started: [] };
  const takeover = {
    preview: (request: Record<string, unknown>) => fake.preview(request),
    start: async (request: Record<string, unknown>) => {
      fake.started.push(request);
      return { id: 'tk-1', state: 'running' };
    },
    get: () => fake.run,
  } as unknown as TakeoverRunner;
  const team = new TeamService({ dataDir: world.root, store: world.store, bus, supervisor: world.supervisor, loops, todos, peers, takeover, isHooked: async () => false, pushDelayMs: 10 });
  rig = { world, team, loops, todos, takeover: fake };
  await team.init();
  return rig;
}

async function member(r: Rig) {
  const session = await r.world.supervisor.start(newSession({ name: 'dev', task: 'first' }), r.world.place);
  await waitForStatus(r.world.store, session.id, ['done', 'idle']);
  await until(async () => (r.world.supervisor.isLive(session.id) && !r.world.supervisor.turnRunning(session.id)) || undefined, 'dev idle');
  return r.team.adopt({ sessionId: session.id, name: 'Developer' });
}

async function ended(r: Rig, id: string): Promise<TeamMoveRun> {
  return until(async () => {
    const run = await r.team.moveRun(id);
    return run.state === 'running' ? undefined : run;
  }, 'the move to end');
}

describe('D100 · a member move that cannot happen or fails', () => {
  it('an older target (no take-over peer route) is refused with that reason; Move is refused too', async () => {
    const r = await setup();
    const dev = await member(r);
    r.takeover.preview = async () => {
      throw new TakeoverError(403, 'peer-forbidden', 'POST /api/takeover/target/plan is not part of the peer API');
    };
    const check = await r.team.moveCheck(dev.id, { targetMachineId: PC });
    expect(check).toMatchObject({ ok: false, blockers: ['Office PC runs an older Switchboard that cannot take Developer: update Switchboard there, then move'] });
    r.takeover.preview = async () => {
      throw new TakeoverError(404, 'Not Found', 'Route POST:/peer/v1/api/takeover/target/plan not found');
    };
    await expect(r.team.move(dev.id, { targetMachineId: PC })).rejects.toMatchObject({ status: 409, message: 'Office PC runs an older Switchboard that cannot take Developer: update Switchboard there, then move' } satisfies Partial<TeamError>);
    expect(r.takeover.started).toEqual([]);
  });

  it('a failed take-over fails the move with the step, the reason and where the member still runs; the member is unchanged', async () => {
    const r = await setup();
    const dev = await member(r);
    const started = await r.team.move(dev.id, { targetMachineId: PC });
    expect(started).toMatchObject({ state: 'running', machineId: SELF.id, targetMachineId: PC });
    r.takeover.run = failedRun('capture', 'the push to origin was refused.', true);
    const run = await ended(r, started.id);
    expect(run).toMatchObject({ state: 'failed', machineId: SELF.id, rolledBack: true, error: 'Pushing the work in progress to a temporary branch failed: the push to origin was refused. Developer still runs on Desk.' });
    const after = (await r.team.view()).members.find((m) => m.id === dev.id);
    expect([after?.machineId, after?.sessionId]).toEqual([SELF.id, dev.sessionId]);
    expect((await r.team.view()).activity.map((a) => a.text)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^moved from/)]));
  });

  it('an undo that left something says so; a take-over run that is gone fails the move instead of leaving it running', async () => {
    const r = await setup();
    const dev = await member(r);
    const first = await r.team.move(dev.id, { targetMachineId: PC });
    r.takeover.run = failedRun('apply', 'a diverged branch', false, ['could not delete the temporary branch sb/tmp']);
    expect((await ended(r, first.id)).error).toBe('Restoring the working tree here failed: a diverged branch. Undoing it left something behind: could not delete the temporary branch sb/tmp. Developer still runs on Desk.');
    r.takeover.run = null;
    const second = await r.team.move(dev.id, { targetMachineId: PC });
    expect(await ended(r, second.id)).toMatchObject({ state: 'failed', rolledBack: null, error: 'the take-over run is gone. Developer still runs on Desk.' });
  });

  it('the move uses the folders the check used (the remembered ones when none were chosen)', async () => {
    const r = await setup();
    const dev = await member(r);
    const remembered = { roots: ['/work/code'] };
    r.takeover.preview = async () => ({ ok: true, blockers: [], placement: remembered, remembered: true });
    await r.team.move(dev.id, { targetMachineId: PC });
    expect(r.takeover.started.at(-1)).toMatchObject({ targetMachine: PC, placement: remembered });
    // `placement: null` (the target's saved folders) stays that.
    r.takeover.run = failedRun('checks', 'stop', null);
    await r.team.move(dev.id, { targetMachineId: PC, placement: null });
    expect(r.takeover.started.at(-1)).toMatchObject({ savedFolders: true });
    expect(r.takeover.started.at(-1)?.['placement']).toBeUndefined();
  });
});
