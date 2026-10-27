/**
 * D138 · choosing the account (`docs/accounts.md` → *Choosing the account*), on the real path
 * (fake-claude sessions, the supervisor's `switchAccount`, `AccountChoice`): choosing account B
 * overall moves the live sessions now (idle and running: the running turn is interrupted and
 * continued), except pinned sessions and those whose Project has its own account; new sessions
 * start on B; the confirm's counts; a Project's own change moves only its sessions; the
 * precedence a session reports. The routes: `POST /api/accounts/choice/preview`, `PUT /api/accounts/choice`.
 */
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTINUE_AFTER_CHOICE } from '../../../src/core/accounts.ts';
import type { AccountChoicePreview, AccountChoiceResult, Session } from '../../../src/core/api.ts';
import { AutoSwitcher } from '../../../src/server/accounts/auto-switch.ts';
import { AccountChoice, type ProjectAccountsLookup } from '../../../src/server/accounts/choice.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, readFakeLog, stdinOf, until, waitForStatus } from '../../helpers/supervisor.ts';

let world: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  await world?.cleanup();
  app = undefined;
  world = undefined;
});

/** The fake's spawn lines of session `claudeSessionId`'s processes (newest last). */
async function spawnsOf(w: SupervisorWorld, claudeSessionId: string) {
  return (await readFakeLog(w.logFile)).filter((line) => line.kind === 'argv' && Array.isArray(line.argv) && (line.argv as string[]).includes(claudeSessionId));
}

function userTexts(lines: Array<Record<string, unknown>>): string[] {
  return lines.filter((l) => l['type'] === 'user').map((l) => JSON.stringify(l));
}

async function profileOf(w: SupervisorWorld, id: string): Promise<string | null> {
  return (await w.store.sessions.get(id))?.profileId ?? null;
}

describe('D138 · the overall account choice', () => {
  it('choosing B moves idle and running sessions now (pinned ones stay), new sessions start on B, the divider and the continue message', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const bus = new HubBus();
    const published: unknown[] = [];
    bus.subscribe((message) => {
      if (message.name === 'accountChoiceChanged') published.push(message.payload);
    });
    const choice = new AccountChoice({ store: w.store, supervisor: w.supervisor, accounts: w.accounts, dataDir: w.root, bus, onError: (e) => w.errors.push(e), log: () => undefined });
    const b = await w.accounts.create({ cli: 'claude', name: 'Private' });
    const idle = await w.supervisor.start(newSession({ name: 'idle-one', task: 'first task' }), w.place);
    const running = await w.supervisor.start(newSession({ name: 'running-one', task: 'first task' }), w.place);
    const pinned = await w.supervisor.start(newSession({ name: 'pinned-one', task: 'first task' }), w.place);
    for (const s of [idle, running, pinned]) await waitForStatus(w.store, s.id, ['done']);
    await w.supervisor.setProfilePinned(pinned.id, true);
    await w.supervisor.sendMessage(running.id, '[fake:hold 30] think for a long time');
    await waitForStatus(w.store, running.id, ['run']);

    // The confirm's counts first.
    const preview = await choice.preview({ cli: 'claude', profileId: b.id });
    expect(preview).toMatchObject({ profileId: b.id, profileName: 'Private', move: 2, running: 1, skipped: { pinned: 1, project: 0, already: 0 }, confirm: 'Move 2 agents to Private? 1 running turn will be interrupted.' });
    expect([...preview.sessionIds].sort()).toEqual([idle.id, running.id].sort());

    const result = await choice.setOverall('claude', b.id);
    expect(result).toMatchObject({ moving: 2, running: 1 });
    expect(result.settings.choice).toEqual({ claude: b.id });
    expect(result.settings.newSessions).toEqual({ rule: 'fixed', fixed: { claude: b.id } });
    expect(published).toEqual([{ cli: 'claude', profileId: b.id, planId: null, moving: 2 }]);
    await choice.settled();
    expect(await profileOf(w, idle.id)).toBe(b.id);
    expect(await profileOf(w, running.id)).toBe(b.id);
    expect(await profileOf(w, pinned.id)).toBe('default-claude');

    // The divider says why; the interrupted turn is continued with the choice's message.
    const divider = (await w.store.events.list(idle.id)).find((e) => e.label?.startsWith('Switched account'));
    expect(divider?.label).toBe('Switched account: Default → Private (overall choice)');
    const texts = await until(async () => {
      const spawns = await spawnsOf(w, running.claudeSessionId);
      const spawn = spawns.length >= 2 ? spawns.at(-1) : undefined;
      const found = spawn ? userTexts(await stdinOf(w.logFile, Number(spawn.pid))) : [];
      return found.length > 0 ? found : undefined;
    }, 'the continue message');
    expect(texts[0]).toContain(CONTINUE_AFTER_CHOICE);
    // The idle session got no message.
    const idleSpawn = await until(async () => {
      const spawns = await spawnsOf(w, idle.claudeSessionId);
      return spawns.length >= 2 ? spawns.at(-1) : undefined;
    }, 'the idle session resumed');
    expect(userTexts(await stdinOf(w.logFile, Number(idleSpawn?.pid)))).toHaveLength(0);

    // New sessions start on B.
    const fresh = await w.supervisor.start(newSession({ name: 'fresh-one', task: 'first task' }), w.place);
    expect(fresh.profileId).toBe(b.id);
    // The precedence each one reports.
    expect(await choice.preference((await w.store.sessions.get(idle.id))!)).toEqual({ profileId: b.id, source: 'overall' });
    expect(await choice.preference((await w.store.sessions.get(pinned.id))!)).toEqual({ profileId: 'default-claude', source: 'pinned' });

    // Back to Automatic: nothing moves, new sessions take the automatic pick (the first account).
    expect(await choice.setOverall('claude', null)).toMatchObject({ moving: 0 });
    await choice.settled();
    expect(await profileOf(w, idle.id)).toBe(b.id);
    const auto = await w.supervisor.start(newSession({ name: 'auto-one', task: 'first task' }), w.place);
    expect(auto.profileId).toBe('default-claude');
    expect(w.errors).toEqual([]);
  }, 60_000);

  it("a Project's own account: the overall choice skips its sessions; changing the Project's account moves only them", async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const choice = new AccountChoice({ store: w.store, supervisor: w.supervisor, accounts: w.accounts, dataDir: w.root, onError: (e) => w.errors.push(e), log: () => undefined });
    const work = await w.accounts.create({ cli: 'claude', name: 'Work' });
    const priv = await w.accounts.create({ cli: 'claude', name: 'Private' });
    const inProject = await w.supervisor.start(newSession({ name: 'project-step', task: 'first task' }), w.place);
    const outside = await w.supervisor.start(newSession({ name: 'outside', task: 'first task' }), w.place);
    for (const s of [inProject, outside]) await waitForStatus(w.store, s.id, ['done']);
    let accounts: Record<string, string> = { claude: work.id };
    const projects: ProjectAccountsLookup = {
      ofSession: async (id) => (id === inProject.id ? { planId: 'p1', title: 'Acme epic', accounts } : null),
      sessionsOf: async (id) => (id === 'p1' ? { title: 'Acme epic', accounts, sessionIds: [inProject.id] } : null),
    };
    choice.useProjects(projects);

    // The overall choice: the Project's session is left where it is (counted as skipped).
    expect(await choice.preview({ cli: 'claude', profileId: priv.id })).toMatchObject({ move: 1, skipped: { pinned: 0, project: 1, already: 0 } });
    await choice.setOverall('claude', priv.id);
    await choice.settled();
    expect(await profileOf(w, outside.id)).toBe(priv.id);
    expect(await profileOf(w, inProject.id)).toBe('default-claude');
    expect(await choice.preference((await w.store.sessions.get(inProject.id))!)).toEqual({ profileId: work.id, source: 'project', project: { id: 'p1', title: 'Acme epic' } });

    // The Project's account applied (a Start / an edit): only its sessions move.
    expect(await choice.preview({ cli: 'claude', profileId: work.id, planId: 'p1' })).toMatchObject({ move: 1, running: 0, sessionIds: [inProject.id] });
    expect(await choice.applyProject('p1')).toBe(1);
    await choice.settled();
    expect(await profileOf(w, inProject.id)).toBe(work.id);
    expect(await profileOf(w, outside.id)).toBe(priv.id);
    expect((await w.store.events.list(inProject.id)).some((e) => e.label === "Switched account: Default → Work (the project's account)")).toBe(true);

    // The Project back on Automatic: its sessions follow the overall choice.
    accounts = {};
    expect(await choice.preview({ cli: 'claude', profileId: null, planId: 'p1' })).toMatchObject({ profileId: priv.id, move: 1 });
    expect(await choice.applyProject('p1')).toBe(1);
    await choice.settled();
    expect(await profileOf(w, inProject.id)).toBe(priv.id);
    expect(await choice.preference((await w.store.sessions.get(inProject.id))!)).toEqual({ profileId: priv.id, source: 'overall' });
    expect(w.errors).toEqual([]);
  }, 60_000);

  it('the chosen account runs out: the automatic rules take over with a note; it is back: new sessions prefer it, running ones stay', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const choice = new AccountChoice({ store: w.store, supervisor: w.supervisor, accounts: w.accounts, dataDir: w.root, onError: (e) => w.errors.push(e), log: () => undefined });
    const switcher = new AutoSwitcher({ store: w.store, supervisor: w.supervisor, accounts: w.accounts, dataDir: w.root, systemItems: { accountNotice: async () => null }, clis: { refusal: async () => null }, intervalMs: 3_600_000, onError: (e) => w.errors.push(e), log: () => undefined, preference: (session) => choice.preference(session) });
    try {
      const b = await w.accounts.create({ cli: 'claude', name: 'Private' });
      await choice.setOverall('claude', b.id);
      const session = await w.supervisor.start(newSession({ name: 'on-b', task: 'first task' }), w.place);
      expect(session.profileId).toBe(b.id);
      await waitForStatus(w.store, session.id, ['done']);
      await switcher.onFailedTurn(session.id, "You've hit your session limit · resets 11:59pm");
      expect(await profileOf(w, session.id)).toBe('default-claude');
      const note = (await w.store.events.list(session.id)).find((e) => e.label?.includes('is out of usage'));
      expect(note?.label).toMatch(/^Private is out of usage until (\d+ \w+ )?23:59; switched to Default$/);
      // While B is out, a new session starts on the automatic pick.
      expect((await w.supervisor.start(newSession({ name: 'while-out', task: 'first task' }), w.place)).profileId).toBe('default-claude');
      // B is back: new sessions prefer it again; the moved session stays (the "switch back" rule is off).
      await w.store.profiles.update(b.id, { exhaustedUntil: null });
      await switcher.tick();
      expect(await profileOf(w, session.id)).toBe('default-claude');
      expect((await w.supervisor.start(newSession({ name: 'after-reset', task: 'first task' }), w.place)).profileId).toBe(b.id);
      // With "switch back after a reset", an idle session goes back to the chosen account.
      await w.accounts.setSettings({ afterReset: 'back-to-first', cooldownSeconds: 0 });
      // Between turns only (the "continue" turn after the limit switch ends first).
      await until(async () => {
        await switcher.tick();
        return (await profileOf(w, session.id)) === b.id ? true : undefined;
      }, 'back on the chosen account', 20_000);
      expect(w.errors).toEqual([]);
    } finally {
      await switcher.stop();
    }
  }, 60_000);

  it('the routes: preview and choice, validated; sessions carry accountChoice', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const PORT = 4901; // inject() opens no socket; the port feeds the Host check only
    const token = generateToken();
    const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: w.root }, platform: 'linux', home: w.root, cwd: w.root });
    await seedFolder(w.store, w.workspace);
    app = await buildApp({ config: { ...base, port: PORT }, token, store: w.store, webRoot: w.root, supervisor: w.supervisor });
    await app.ready();
    const call = (method: InjectOptions['method'], url: string, payload?: unknown) =>
      (app as FastifyInstance).inject({ method, url, headers: { host: `127.0.0.1:${PORT}`, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
    const b = await w.accounts.create({ cli: 'claude', name: 'Private' });
    const codex = await w.accounts.create({ cli: 'codex', name: 'Other' });
    const session = await w.supervisor.start(newSession({ name: 'routed', task: 'first task' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);

    expect((await call('POST', '/api/accounts/choice/preview', { cli: 'nope', profileId: b.id })).statusCode).toBe(422);
    expect((await call('POST', '/api/accounts/choice/preview', { cli: 'claude', profileId: codex.id })).statusCode).toBe(422);
    const preview = (await call('POST', '/api/accounts/choice/preview', { cli: 'claude', profileId: b.id })).json() as AccountChoicePreview;
    expect(preview).toMatchObject({ move: 1, running: 0, confirm: 'Move 1 agent to Private?' });
    const before = (await call('GET', `/api/sessions/${session.id}`)).json() as { session?: Session } & Session;
    expect((before.session ?? before).accountChoice).toEqual({ source: 'automatic' });

    const put = await call('PUT', '/api/accounts/choice', { cli: 'claude', profileId: b.id });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json() as AccountChoiceResult).toMatchObject({ moving: 1, settings: { choice: { claude: b.id } } });
    await until(async () => ((await profileOf(w, session.id)) === b.id ? true : undefined), 'the move');
    const after = (await call('GET', `/api/sessions/${session.id}`)).json() as { session?: Session } & Session;
    expect((after.session ?? after).accountChoice).toEqual({ source: 'overall', profileId: b.id });
    // Settings → the old rule's shape still reads (an older client), and an old PUT still sets the choice without moving.
    expect(((await call('GET', '/api/accounts')).json() as { settings: { newSessions: unknown } }).settings.newSessions).toEqual({ rule: 'fixed', fixed: { claude: b.id } });
    const old = await call('PUT', '/api/accounts/settings', { newSessions: { rule: 'first-with-allowance' } });
    expect(old.json()).toMatchObject({ choice: {}, newSessions: { rule: 'first-with-allowance', fixed: {} } });
    expect((await call('PUT', '/api/accounts/settings', { choice: { claude: codex.id } })).statusCode).toBe(422);
    expect(await profileOf(w, session.id)).toBe(b.id);
  }, 60_000);
});
