import { afterEach, describe, expect, it } from 'vitest';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { LoopService } from '../../../src/server/loops/owned.ts';
import { teamMemberOf } from '../../../src/server/team/hooks.ts';
import { type TeamPeers, TeamService } from '../../../src/server/team/service.ts';
import { TodoService } from '../../../src/server/todos/service.ts';
import { NO_ATTACHMENTS } from '../../../src/server/attachments/service.ts';
import { type SupervisorWorld, makeSupervisorWorld } from '../../helpers/supervisor.ts';

/**
 * 2026-10-27 (D137 follow-up, the developer chose B) · an archived member (its session closed)
 * stays in its team, flagged `archived`, never counted and never given new work; Restore
 * (reopen) brings it back with its role. `docs/team.md` → *Archived members*.
 */

const SELF = { id: 'm-mac-0001', name: 'Mac' };
const PC = { id: 'm-pc-0002', name: 'PC' };

/** The paired machine's sessions as Team reads them (open and archived, by `r~` ref). */
const remote = { open: [] as { id: string; status: string; name: string }[], archived: [] as { id: string; closedAt: string; movedTo?: unknown }[] };

const peers = {
  self: async () => SELF,
  machines: async () => [{ id: PC.id, name: PC.name, state: 'online' }],
  remoteSessions: () => remote.open,
  remoteArchived: () => remote.archived,
  remoteInbox: () => [],
  forward: async () => ({ status: 404, body: { error: 'not-found', message: 'no peers here' } }),
  ask: async () => ({ status: null, reason: 'no peers here' }),
  hasMachine: () => true,
  sidebarChanged: () => undefined,
} as unknown as TeamPeers;

interface Rig {
  readonly world: SupervisorWorld;
  readonly team: TeamService;
  readonly loops: LoopService;
  readonly todos: TodoService;
  readonly bus: HubBus;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.team.close();
  await rig?.loops.close();
  rig?.todos.close();
  await rig?.world.cleanup();
  rig = undefined;
  remote.open = [];
  remote.archived = [];
});

async function setup(): Promise<Rig> {
  const world = await makeSupervisorWorld();
  const bus = new HubBus();
  const todos = new TodoService({ store: world.store, bus });
  const loops = new LoopService({ store: world.store, deliver: async (session, text, mark) => void (await world.supervisor.sendMessage(session.id, text, 'service', NO_ATTACHMENTS, { loop: mark })) });
  const team = new TeamService({ dataDir: world.root, store: world.store, bus, supervisor: world.supervisor, loops, todos, peers, takeover: null, isHooked: async () => false, pushDelayMs: 10_000, tickMs: 3_600_000, syncMs: 3_600_000 });
  // As hub/wire.ts wires it: the supervisor's session updates go on the bus.
  world.supervisor.on('sessionUpdated', (session) => bus.publish('sessionUpdated', session));
  rig = { world, team, loops, todos, bus };
  await team.init();
  return rig;
}

/** Two members of the first team: Planner and Builder (no "on hand-off" rhythm, so nothing is woken). */
async function crew(r: Rig) {
  const s1 = await r.world.store.sessions.create({ name: 'planner', claudeSessionId: 'aaaaaaaa-2222-4333-8444-955566667777', attached: true });
  const s2 = await r.world.store.sessions.create({ name: 'builder', claudeSessionId: 'bbbbbbbb-2222-4333-8444-955566667777', attached: true });
  const planner = await r.team.adopt({ sessionId: s1.id, name: 'Planner', rhythm: { loopIds: [], onHandoff: false }, charter: { owns: 'the plan', produces: 'briefs', neverDoes: 'merges' } });
  const builder = await r.team.adopt({ sessionId: s2.id, name: 'Builder', rhythm: { loopIds: [], onHandoff: false }, charter: { owns: 'the code', produces: 'changes', neverDoes: 'releases' } });
  return { planner, builder, s1, s2 };
}

describe('2026-10-27 · archived members are hidden, not removed (D137 follow-up, choice B)', () => {
  it('flags the member, keeps it in its team and its hold, and leaves it out of the counts; Restore brings it back with its role', async () => {
    const r = await setup();
    const { builder, s2 } = await crew(r);
    await r.world.supervisor.close(s2.id);

    const view = await r.team.view();
    expect(view.members.map((m) => [m.name, m.archived])).toEqual([
      ['Planner', false],
      ['Builder', true],
    ]);
    const [summary] = await r.team.teamList();
    expect(summary).toMatchObject({ members: 2, archived: 1, needsYou: 0 });
    expect(summary?.roster?.map((entry) => [entry.name, entry.archived])).toEqual([
      ['Planner', false],
      ['Builder', true],
    ]);
    // Still a member: the role, charter and the archive's "Kept: a Team member" hold stay.
    expect(teamMemberOf(r.world.store, s2.id)).toMatchObject({ id: builder.id, name: 'Builder' });
    expect(r.team.state().hiddenSessionIds).toContain(s2.id);

    await r.world.supervisor.reopen(s2.id);
    const back = await r.team.member(builder.id);
    expect(back).toMatchObject({ name: 'Builder', archived: false, charter: { owns: 'the code', produces: 'changes', neverDoes: 'releases' } });
    expect((await r.team.teamList())[0]).toMatchObject({ members: 2, archived: 0 });
  });

  it('gets no new work: a hand-off by name or id is refused (409 closed), the charter asks skip it; after Restore both work', async () => {
    const r = await setup();
    const { planner, builder, s1, s2 } = await crew(r);
    await r.world.supervisor.close(s2.id);

    for (const to of ['Builder', 'builder', builder.id]) {
      await expect(r.team.createHandoff({ from: planner.id, to, brief: 'Add the export button.', expected: '', links: [] })).rejects.toMatchObject({ status: 409, code: 'closed', message: "Builder's session is archived: restore it first" });
      await expect(r.team.createHandoff({ from: null, to, brief: 'From you.', expected: '', links: [] })).rejects.toMatchObject({ status: 409, code: 'closed' });
    }
    expect((await r.team.view()).handoffs).toEqual([]);
    expect(await r.todos.list(s2.id)).toMatchObject({ todos: [] });

    await expect(r.team.askCharter(builder.id)).rejects.toMatchObject({ status: 409, code: 'closed', message: "Builder's session is archived: restore it first" });
    const asked = await r.team.askCharters({ teamId: 'team' });
    expect(asked.skipped).toContainEqual({ memberId: builder.id, name: 'Builder', reason: 'archived' });
    expect(asked.asked.map((a) => a.name)).not.toContain('Builder');

    // team_members tells the other agents it is archived.
    const text = await r.team.membersText(s1.id);
    expect(text).toContain('- Builder · archived: no hand-offs until the developer restores it');

    await r.world.supervisor.reopen(s2.id);
    const handoff = await r.team.createHandoff({ from: planner.id, to: 'Builder', brief: 'Add the export button.', expected: '', links: [] });
    expect(handoff.state).toBe('open');
    expect((await r.todos.list(s2.id)).todos.map((t) => t.title)).toEqual(['Hand-off from Planner: Add the export button.']);
  });

  it('a hand-off made before the archiving waits: it becomes a todo only after Restore', async () => {
    const r = await setup();
    const { planner, s2 } = await crew(r);
    // Stored while Builder was open, but delivery happens on its machine's tick: archive in between.
    await r.world.supervisor.close(s2.id);
    await r.world.supervisor.reopen(s2.id);
    await r.team.createHandoff({ from: planner.id, to: 'Builder', brief: 'First.', expected: '', links: [] });
    const first = (await r.todos.list(s2.id)).todos.length;
    expect(first).toBe(1);
    await r.world.supervisor.close(s2.id);
    // A hand-off record that came in while archived (e.g. synced from a paired machine) is not delivered.
    const mine = await r.team.message();
    const record = mine.snapshot.handoffs[0];
    expect(record).toBeDefined();
    const later = `${(Date.now() + 60_000).toString(36).padStart(9, '0')}.0000.${PC.id}`;
    await r.team.receive({ v: 1, machine: PC, snapshot: { ...mine.snapshot, handoffs: [{ ...record, id: 'h-late', todoId: null, notifiedAt: null, brief: 'Second.', clock: later }] } });
    await r.team.tick();
    expect((await r.todos.list(s2.id)).todos).toHaveLength(1);
    await r.world.supervisor.reopen(s2.id);
    await r.team.tick();
    expect((await r.todos.list(s2.id)).todos.map((t) => t.title).sort()).toEqual(['Hand-off from Planner: First.', 'Hand-off from Planner: Second.']);
  });

  it("Needs you leaves an archived member's Team items out until it is restored", async () => {
    const r = await setup();
    const { builder, s2 } = await crew(r);
    await r.team.requestGate({ memberId: builder.id, kind: 'gate', gate: 'external-write', title: 'Builder wants to write to Jira', detail: '', action: null });
    expect((await r.team.needsYou()).map((item) => item.memberName)).toEqual(['Builder']);
    expect((await r.team.teamList())[0]?.needsYou).toBe(1);
    await r.world.supervisor.close(s2.id);
    expect(await r.team.needsYou()).toEqual([]);
    expect(await r.team.needsYou('all')).toEqual([]);
    expect((await r.team.teamList())[0]?.needsYou).toBe(0);
    await r.world.supervisor.reopen(s2.id);
    expect((await r.team.needsYou()).map((item) => item.memberName)).toEqual(['Builder']);
  });

  it('an archive or a restore of a member publishes teamChanged (the crew views hide it or bring it back live); other updates do not', async () => {
    const r = await setup();
    const { s2 } = await crew(r);
    const seen: unknown[] = [];
    const off = r.bus.subscribe((message) => {
      if (message.name === 'teamChanged') seen.push(message.payload);
    });
    try {
      await r.world.supervisor.close(s2.id);
      expect(seen).toEqual([{ teamId: 'team', what: ['members'] }]);
      await r.world.store.sessions.update(s2.id, { title: 'renamed' });
      await r.world.supervisor.reopen(s2.id);
      expect(seen).toHaveLength(2);
      // A plain session's archive is not Team's business.
      const plain = await r.world.store.sessions.create({ name: 'plain', claudeSessionId: 'cccccccc-2222-4333-8444-955566667777', attached: true });
      await r.world.supervisor.close(plain.id);
      expect(seen).toHaveLength(2);
    } finally {
      off();
    }
  });

  it('a member that starts or stops waiting for the developer publishes teamChanged, so the crew count does not stay stale (fix after 2.4.8)', async () => {
    const r = await setup();
    const { s2 } = await crew(r);
    const seen: unknown[] = [];
    const off = r.bus.subscribe((message) => {
      if (message.name === 'teamChanged') seen.push(message.payload);
    });
    const update = async (patch: Parameters<typeof r.world.store.sessions.update>[1]) => {
      const record = await r.world.store.sessions.update(s2.id, patch);
      r.bus.publish('sessionUpdated', record as never);
    };
    try {
      // The first update seen since the start: what the crews were read with is not known.
      await update({ status: 'done' });
      expect(seen).toHaveLength(1);
      await update({ title: 'renamed' });
      expect(seen).toHaveLength(1);
      // Its turn ends waiting: counted; answered (a new turn): not counted any more.
      await update({ status: 'need' });
      expect(seen).toHaveLength(2);
      expect((await r.team.teamList())[0]?.needsYou).toBe(1);
      await update({ status: 'run' });
      expect(seen).toHaveLength(3);
      expect(seen[2]).toEqual({ teamId: 'team', what: ['members'] });
      expect((await r.team.teamList())[0]?.needsYou).toBe(0);
      await update({ status: 'done' });
      expect(seen).toHaveLength(3);
      // A delta update without a status changes nothing.
      r.bus.publish('sessionUpdated', { id: s2.id } as never);
      expect(seen).toHaveLength(3);
    } finally {
      off();
    }
  });

  it("a paired machine's member is archived when that machine's archived list has its session (an open one there wins)", async () => {
    const r = await setup();
    const { planner } = await crew(r);
    const mine = await r.team.message();
    const template = mine.snapshot.members.find((m) => m.id === planner.id);
    if (!template) throw new Error('no record');
    const later = `${(Date.now() + 60_000).toString(36).padStart(9, '0')}.0000.${PC.id}`;
    await r.team.receive({ v: 1, machine: PC, snapshot: { ...mine.snapshot, members: [{ ...template, id: 'm-remote', name: 'Reviewer', machineId: PC.id, sessionId: 'rs-1', order: 5, clock: later }] } });
    const ref = `r~${PC.id}~rs-1`;
    remote.archived = [{ id: ref, closedAt: new Date().toISOString(), movedTo: { machineId: SELF.id, machineName: SELF.name, sessionId: 'x' } }];
    // Closed there by a move (D65): not archived.
    expect((await r.team.member('m-remote')).archived).toBe(false);
    remote.archived = [{ id: ref, closedAt: new Date().toISOString() }];
    expect((await r.team.member('m-remote')).archived).toBe(true);
    expect((await r.team.teamList())[0]).toMatchObject({ archived: 1 });
    await expect(r.team.createHandoff({ from: planner.id, to: 'Reviewer', brief: 'Review it.', expected: '', links: [] })).rejects.toMatchObject({ status: 409, code: 'closed', message: "Reviewer's session is archived: restore it first" });
    // Restored there: open again (its archived list may lag; the open list wins).
    remote.open = [{ id: ref, status: 'idle', name: 'rs-1' }];
    expect((await r.team.member('m-remote')).archived).toBe(false);
  });
});
