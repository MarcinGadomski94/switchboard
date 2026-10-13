import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addFolder, placeSession } from '../../../src/core/sidebar-layout.ts';
import { TEAM_SETTING } from '../../../src/core/team.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { LoopService } from '../../../src/server/loops/owned.ts';
import { TEAM_DB_FILE } from '../../../src/server/team/db.ts';
import { TeamError, type TeamPeers, TeamService } from '../../../src/server/team/service.ts';
import { TodoService } from '../../../src/server/todos/service.ts';
import { NO_ATTACHMENTS } from '../../../src/server/attachments/service.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, spawnedArgv, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D100 · Team's core against fake-claude (one machine; the paired-machine cases are
 * `peers.test.ts`): off by default with no timer and no `team.db`, the file created
 * only when switched on, adopting (hidden, history kept, the charter given to the
 * agent), returning (the sidebar place back), the switch's safety net, a broken
 * `team.db`, the hooked-session refusal, pause, hand-offs as todos and budgets.
 */

const SELF = { id: 'm-mac-0001', name: 'Mac' };

const peers = {
  self: async () => SELF,
  machines: async () => [],
  remoteSessions: () => [],
  remoteInbox: () => [],
  forward: async () => ({ status: 404, body: { error: 'not-found', message: 'no peers here' } }),
  ask: async () => ({ status: null, reason: 'no peers here' }),
  hasMachine: () => false,
  sidebarChanged: () => undefined,
} as unknown as TeamPeers;

interface Rig {
  readonly world: SupervisorWorld;
  readonly team: TeamService;
  readonly loops: LoopService;
  readonly todos: TodoService;
  readonly bus: HubBus;
  readonly dataDir: string;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.team.close();
  await rig?.loops.close();
  rig?.todos.close();
  await rig?.world.cleanup();
  rig = undefined;
});

async function setup(options: { readonly hooked?: (id: string) => Promise<boolean> } = {}): Promise<Rig> {
  const world = await makeSupervisorWorld();
  const bus = new HubBus();
  const todos = new TodoService({ store: world.store, bus });
  const loops = new LoopService({ store: world.store, deliver: async (session, text, mark) => void (await world.supervisor.sendMessage(session.id, text, 'service', NO_ATTACHMENTS, { loop: mark })) });
  const dataDir = world.root;
  const team = new TeamService({
    dataDir,
    store: world.store,
    bus,
    supervisor: world.supervisor,
    loops,
    todos,
    peers,
    takeover: null,
    isHooked: options.hooked ?? (async () => false),
    // As install.ts wires it (POST /api/sessions' logic), reduced to the supervisor's start in the world's folder.
    startSession: async (body, beforeSpawn) => {
      const input = body as { name: string; task: string };
      const started = await world.supervisor.start(newSession({ name: input.name, task: input.task }), world.place, input.task, { beforeSpawn: (record) => beforeSpawn(record.id) });
      return { ok: true, sessionId: started.id };
    },
    pushDelayMs: 10,
  });
  rig = { world, team, loops, todos, bus, dataDir };
  return rig;
}

async function switchOn(r: Rig, on = true): Promise<void> {
  await r.world.store.settings.set(TEAM_SETTING, on);
  await r.team.switchChanged();
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

/** A started session whose first turn ended (its process idle). */
async function idleSession(r: Rig, name: string) {
  const session = await r.world.supervisor.start(newSession({ name, task: 'first' }), r.world.place);
  await waitForStatus(r.world.store, session.id, ['done', 'idle']);
  await until(async () => (r.world.supervisor.isLive(session.id) && !r.world.supervisor.turnRunning(session.id)) || undefined, `${name} idle`);
  return session;
}

const FLAG = '--append-system-prompt';

/** The `--append-system-prompt` text of the session's process now (it changes pid on a restart). */
async function instructionAfterRestart(r: Rig, sessionId: string, before: number | null): Promise<string | null> {
  const pid = await until(async () => {
    const now = r.world.supervisor.pid(sessionId);
    return now !== null && now !== before ? now : undefined;
  }, 'a restarted process');
  const spawn = await until(async () => (await spawnedArgv(r.world.logFile)).find((line) => line.pid === pid && line.argv?.includes('-p')), `the argv of ${pid}`);
  const at = spawn.argv?.indexOf(FLAG) ?? -1;
  return at >= 0 ? (spawn.argv?.[at + 1] ?? null) : null;
}

describe('D100 · the switch', () => {
  it('is off by default: no team.db, no timer, only the state route answers', async () => {
    const r = await setup();
    await r.team.init();
    expect(r.team.state()).toEqual({ enabled: false, available: false, problem: null, hiddenSessionIds: [], roles: {} });
    expect(r.team.activeTimers()).toBe(0);
    expect(await exists(path.join(r.dataDir, TEAM_DB_FILE))).toBe(false);
    await expect(r.team.view()).rejects.toMatchObject({ status: 404, code: 'team-off' });
  });

  it('creates the separate team.db only when switched on, and stops its timers when off again', async () => {
    const r = await setup();
    await r.team.init();
    expect(await exists(path.join(r.dataDir, TEAM_DB_FILE))).toBe(false);
    await switchOn(r);
    expect(await exists(path.join(r.dataDir, TEAM_DB_FILE))).toBe(true);
    expect(r.team.state().available).toBe(true);
    expect(r.team.activeTimers()).toBeGreaterThan(0);
    expect((await r.team.view()).team.name).toBe('Team');
    // The main database has no Team table (no migration there).
    const tables = r.world.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%team%'").all();
    expect(tables).toEqual([]);
    await switchOn(r, false);
    expect(r.team.activeTimers()).toBe(0);
    expect(r.team.state().enabled).toBe(false);
  });
});

describe('D100 · adopt and return', () => {
  it('adopt hides the session, keeps its history and gives its agent the charter; return restores folder and position', async () => {
    const r = await setup();
    await r.team.init();
    await switchOn(r);
    const other = await idleSession(r, 'other-one');
    const session = await idleSession(r, 'tracker-one');
    // The session sits second in a sidebar folder.
    await r.world.store.sidebar.change((layout) => addFolder(layout, 'f-1', 'Work'));
    await r.world.store.sidebar.change((layout) => placeSession(layout, { sessionId: other.id, place: 'folder', folderId: 'f-1' }));
    await r.world.store.sidebar.change((layout) => placeSession(layout, { sessionId: session.id, place: 'folder', folderId: 'f-1' }));
    const eventsBefore = (await r.world.store.events.list(session.id)).length;
    const firstPid = r.world.supervisor.pid(session.id);

    const member = await r.team.adopt({ sessionId: session.id, name: 'Tracker', charter: { owns: 'the board', produces: 'a daily note', neverDoes: 'merges' } });
    expect(member.name).toBe('Tracker');
    expect(member.originalPlace).toEqual({ place: 'folder', folderId: 'f-1', index: 1 });
    expect(r.team.state().hiddenSessionIds).toEqual([session.id]);
    expect(r.team.state().roles).toEqual({ [session.id]: 'Tracker' });
    // History kept: the session record and its events are untouched (the restart only adds its divider).
    expect((await r.world.store.events.list(session.id)).length).toBeGreaterThanOrEqual(eventsBefore);
    expect((await r.world.store.sessions.get(session.id))?.closedAt).toBeNull();
    // The idle process was restarted with the charter (D64's mechanism, D91's reload).
    const charter = await instructionAfterRestart(r, session.id, firstPid);
    expect(charter).toContain('You are now Tracker in team Team. Charter: owns: the board. Produces: a daily note. Never does: merges.');
    // A second adoption of the same session is refused.
    await expect(r.team.adopt({ sessionId: session.id, name: 'Again' })).rejects.toMatchObject({ status: 409, code: 'already-member' });

    // Its place was lost meanwhile (e.g. dropped elsewhere): return puts it back at its folder position.
    await r.world.store.sidebar.change((layout) => placeSession(layout, { sessionId: session.id, place: 'loose' }));
    await until(async () => !r.world.supervisor.turnRunning(session.id) || undefined, 'idle again');
    const adoptedPid = r.world.supervisor.pid(session.id);
    await r.team.returnMember(member.id);
    expect(r.team.state().hiddenSessionIds).toEqual([]);
    const layout = await r.world.store.sidebar.read();
    expect(layout.folders.find((f) => f.id === 'f-1')?.sessionIds).toEqual([other.id, session.id]);
    expect((await r.team.view()).members).toEqual([]);
    // The charter is withdrawn: the next process runs without it.
    expect(await instructionAfterRestart(r, session.id, adoptedPid)).toBeNull();
    expect((await r.team.view()).activity.map((a) => a.text)).toEqual(expect.arrayContaining(['Adopted tracker-one as Tracker', 'Tracker returned to the sessions list']));
  });

  it('create starts a new session whose very first process already carries the charter', async () => {
    const r = await setup();
    await r.team.init();
    await switchOn(r);
    const member = await r.team.create({ name: 'Release manager', templateId: 'release-manager', session: { task: 'Prepare the checklist.' } });
    expect(member.templateId).toBe('release-manager');
    expect(member.charter.neverDoes).toBe('Tags, publishes or deploys without approval.');
    expect(member.gates).toEqual(['outward-facing', 'merge-default-branch', 'release']);
    expect(r.team.state().hiddenSessionIds).toEqual([member.sessionId]);
    const first = await instructionAfterRestart(r, member.sessionId, null);
    expect(first).toContain('You are now Release manager in team Team.');
    expect(first).toContain('Ask the developer before: anything outward-facing; merging into a protected or default branch; releases and deployments.');
  });

  it('refuses a hooked terminal session (continue it in Switchboard first)', async () => {
    const r = await setup();
    await r.team.init();
    await switchOn(r);
    const session = await r.world.store.sessions.create({ name: 'terminal-one', claudeSessionId: '0b7c3e0a-2222-4333-8444-955566667777', hooked: true, attached: true });
    const refused = await r.team.adopt({ sessionId: session.id, name: 'Tracker' }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TeamError);
    expect(refused).toMatchObject({ status: 409, code: 'hooked' });
    expect((refused as Error).message).toMatch(/Continue it in Switchboard first/);
    expect(r.team.state().hiddenSessionIds).toEqual([]);
  });

  it('switching Team off returns every member to the list; on again re-hides them; a broken team.db hides nothing', async () => {
    const r = await setup();
    await r.team.init();
    await switchOn(r);
    const a = await r.world.store.sessions.create({ name: 'a-one', claudeSessionId: 'aaaaaaaa-2222-4333-8444-955566667777', attached: true });
    const b = await r.world.store.sessions.create({ name: 'b-one', claudeSessionId: 'bbbbbbbb-2222-4333-8444-955566667777', attached: true });
    await r.team.adopt({ sessionId: a.id, name: 'Alpha' });
    await r.team.adopt({ sessionId: b.id, name: 'Beta' });
    expect([...r.team.state().hiddenSessionIds].sort()).toEqual([a.id, b.id].sort());
    await switchOn(r, false);
    expect(r.team.state().hiddenSessionIds).toEqual([]);
    // No session was touched by hiding.
    expect((await r.world.store.sessions.list({ closed: false })).map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    await switchOn(r);
    expect([...r.team.state().hiddenSessionIds].sort()).toEqual([a.id, b.id].sort());

    // A broken file: Team reports it and hides nothing.
    await switchOn(r, false);
    await writeFile(path.join(r.dataDir, TEAM_DB_FILE), 'this is not a database');
    await writeFile(path.join(r.dataDir, `${TEAM_DB_FILE}-wal`), '').catch(() => undefined);
    await switchOn(r);
    const state = r.team.state();
    expect(state.enabled).toBe(true);
    expect(state.available).toBe(false);
    expect(state.problem).toMatch(/team\.db could not be opened/);
    expect(state.hiddenSessionIds).toEqual([]);
    await expect(r.team.view()).rejects.toMatchObject({ status: 503, code: 'team-unavailable' });
  });
});

describe('D100 · pause, hand-offs, budgets', () => {
  it('pause stops its Team loops (and loops added meanwhile); resume starts only those again', async () => {
    const r = await setup();
    await r.team.init();
    await switchOn(r);
    const session = await r.world.store.sessions.create({ name: 'watcher', claudeSessionId: 'cccccccc-2222-4333-8444-955566667777', attached: true });
    const loop = await r.loops.create(session.id, { prompt: 'Check the queue.', everyMinutes: 30 }, 'developer');
    const own = await r.loops.create(session.id, { prompt: 'Paused by the developer.', everyMinutes: 60 }, 'developer');
    await r.loops.pause(session.id, own.id);
    const member = await r.team.adopt({ sessionId: session.id, name: 'Watcher', rhythm: { loopIds: [loop.id], onHandoff: false } });
    expect(member.rhythm.loops.map((l) => l.prompt)).toEqual(['Check the queue.']);
    const paused = await r.team.pause(member.id);
    expect(paused.paused).toBe(true);
    expect(paused.status).toBe('paused');
    expect((await r.loops.get(session.id, loop.id)).state).toBe('paused');
    // A loop added while paused is paused by the next tick ("nothing new starts").
    const later = await r.loops.create(session.id, { prompt: 'Added later.', everyMinutes: 15 }, 'agent');
    await r.team.tick();
    expect((await r.loops.get(session.id, later.id)).state).toBe('paused');
    await r.team.resume(member.id);
    expect((await r.loops.get(session.id, loop.id)).state).toBe('active');
    expect((await r.loops.get(session.id, later.id)).state).toBe('active');
    // The developer's own pause is not undone.
    expect((await r.loops.get(session.id, own.id)).state).toBe('paused');
  });

  it('a hand-off becomes a todo in the receiver and follows it to done', async () => {
    const r = await setup();
    await r.team.init();
    await switchOn(r);
    const s1 = await r.world.store.sessions.create({ name: 'planner', claudeSessionId: 'dddddddd-2222-4333-8444-955566667777', attached: true });
    const s2 = await r.world.store.sessions.create({ name: 'builder', claudeSessionId: 'eeeeeeee-2222-4333-8444-955566667777', attached: true });
    const planner = await r.team.adopt({ sessionId: s1.id, name: 'Planner' });
    // No "on hand-off" rhythm: the todo is made, the agent is not woken.
    await r.team.adopt({ sessionId: s2.id, name: 'Builder', rhythm: { loopIds: [], onHandoff: false } });
    const handoff = await r.team.createHandoff({ from: planner.id, to: 'builder', brief: 'Add the export button for PROJ-123.', expected: 'A merged change with a test.', links: ['PROJ-123'] });
    expect(handoff.state).toBe('open');
    const todos = (await r.todos.list(s2.id)).todos;
    expect(todos).toHaveLength(1);
    expect(todos[0]?.title).toBe('Hand-off from Planner: Add the export button for PROJ-123.');
    expect(todos[0]?.description).toContain('Expected result: A merged change with a test.');
    const stored = (await r.team.view()).handoffs.find((h) => h.id === handoff.id);
    expect(stored?.todoId).toBe(todos[0]?.id);
    // The receiver works it: in progress → accepted, done → done.
    await r.todos.update(s2.id, todos[0]?.id as string, { state: 'in_progress' }, 'agent');
    await until(async () => (await r.team.view()).handoffs.find((h) => h.id === handoff.id)?.state === 'accepted' || undefined, 'accepted');
    await r.todos.update(s2.id, todos[0]?.id as string, { state: 'done' }, 'agent');
    await until(async () => (await r.team.view()).handoffs.find((h) => h.id === handoff.id)?.state === 'done' || undefined, 'done');
    // Unknown receivers are refused with the way to find the names.
    await expect(r.team.createHandoff({ from: null, to: 'Nobody', brief: 'x', expected: '', links: [] })).rejects.toMatchObject({ status: 404 });
  });

  it('over its daily budget: its Team loops pause and a Needs-you item is raised; its turn is not touched', async () => {
    const r = await setup();
    await r.team.init();
    await switchOn(r);
    const session = await r.world.store.sessions.create({ name: 'spender', claudeSessionId: 'ffffffff-2222-4333-8444-955566667777', attached: true });
    const loop = await r.loops.create(session.id, { prompt: 'Spend.', everyMinutes: 30 }, 'developer');
    const member = await r.team.adopt({ sessionId: session.id, name: 'Spender', budget: { dailyPct: 20, profileId: null } });
    const now = Date.now();
    // 10 weekly points today ≈ 70 % of a day's allowance (100 / 7 points): over a 20 % budget.
    await r.world.store.usage.add({ source: 'get_usage', sessionId: session.id, sevenDayPct: 10, receivedAt: new Date(now - 60_000).toISOString(), raw: null, profileId: 'default-claude', fiveHourPct: null, fiveHourResetsAt: null, sevenDayResetsAt: null });
    await r.world.store.usage.add({ source: 'get_usage', sessionId: session.id, sevenDayPct: 20, receivedAt: new Date(now - 1_000).toISOString(), raw: null, profileId: 'default-claude', fiveHourPct: null, fiveHourResetsAt: null, sevenDayResetsAt: null });
    expect((await r.team.member(member.id)).usedTodayPct).toBe(70);
    await r.team.tick();
    const after = await r.team.member(member.id);
    expect(after.paused).toBe(true);
    expect(after.pausedBy).toBe('budget');
    expect((await r.loops.get(session.id, loop.id)).state).toBe('paused');
    const needs = await r.team.needsYou();
    expect(needs.map((item) => [item.source, item.kind, item.label])).toEqual([['team', 'budget', 'Spender · budget']]);
    // Approving resumes it for today.
    await r.team.decide(needs[0]?.id as string, 'approve');
    expect((await r.team.member(member.id)).paused).toBe(false);
    expect((await r.loops.get(session.id, loop.id)).state).toBe('active');
  });
});
