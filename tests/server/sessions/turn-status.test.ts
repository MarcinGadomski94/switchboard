import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { InboxItem, Session } from '../../../src/core/api.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { PushNotifier, inboxNotice } from '../../../src/server/devices/push/notifier.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { peerAnswerKind } from '../../../src/core/peer-wire.ts';
import { DEVICE_ALLOWED } from '../../../src/server/devices/local-only.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { TurnStatusService } from '../../../src/server/sessions/turn-status.ts';
import { agentTokenFor } from '../../../src/server/todos/agent-token.ts';
import { type AgentApi, turnStatus } from '../../../src/hook/sb-mcp.ts';
import { TodoReminder } from '../../../src/server/todos/reminder.ts';
import { TodoService } from '../../../src/server/todos/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D124 oracle (`docs/derivations.md` → *Session status* → *Waiting for you at a turn's end*):
 * a supervised fake-claude session whose turn ends with a question reads `need` with the ask
 * (detected), raises one "Waiting for you" Inbox item, and a reply clears both; the agent's
 * `turn_status` route stores a declaration (validated) that a new turn, Not waiting and a
 * Dismiss of its Inbox item clear; the declaration beats the text check both ways; the push and
 * the D75 reminder follow.
 */

const PORT = 4875;
const HOST = `127.0.0.1:${PORT}`;

let world: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';

afterEach(async () => {
  await app?.close();
  await world?.cleanup();
  app = undefined;
  world = undefined;
});

async function setup(): Promise<SupervisorWorld> {
  world = await makeSupervisorWorld();
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: world.root }, platform: 'linux', home: world.root, cwd: world.root });
  await seedFolder(world.store, world.workspace);
  app = await buildApp({ config: { ...base, port: PORT }, token, store: world.store, webRoot: world.root, supervisor: world.supervisor });
  await app.ready();
  return world;
}

function call(method: InjectOptions['method'], url: string, payload?: unknown) {
  if (!app) throw new Error('no app');
  return app.inject({ method, url, headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
}

function agent(sessionId: string, payload: unknown) {
  if (!app) throw new Error('no app');
  return app.inject({
    method: 'POST',
    url: '/agent/v1/turn-status',
    headers: { host: HOST, 'x-switchboard-session': sessionId, authorization: `Bearer ${agentTokenFor(token, sessionId)}`, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

async function session(id: string): Promise<Session> {
  return (await call('GET', `/api/sessions/${id}`)).json() as Session;
}

async function inbox(): Promise<InboxItem[]> {
  return (await call('GET', '/api/inbox')).json() as InboxItem[];
}

const waitingItems = async (sessionId: string): Promise<InboxItem[]> => (await inbox()).filter((item) => item.systemKind === 'turn-waiting' && item.sessionId === sessionId);

async function closedOutcomes(store: Store, sessionId: string): Promise<Array<string | null>> {
  return (await store.systemItems.list(['closed'])).filter((item) => item.kind === 'turn-waiting' && item.sessionId === sessionId).map((item) => item.closedAction);
}

describe('D124 · waiting for you at a turn\'s end (supervised session)', () => {
  it('a turn ending with a question reads need (detected) with its ask and raises one Inbox item; a reply clears both', async () => {
    const w = await setup();
    const started = await w.supervisor.start(newSession({ task: 'Ship it. [fake:say "I pushed the branch and opened the PR.\\n\\nShould I merge it once the checks are green?"]' }), w.place);
    await waitForStatus(w.store, started.id, ['done']);
    const items = await until(async () => {
      const found = await waitingItems(started.id);
      return found.length > 0 ? found : undefined;
    }, 'the Waiting for you item');
    const shown = await session(started.id);
    expect(shown.status).toBe('need');
    expect(shown.turnWait).toMatchObject({ status: 'waiting_for_you', ask: 'Should I merge it once the checks are green?', source: 'detected' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'system', status: 'need', label: 'Waiting for you · detected', detail: 'Should I merge it once the checks are green?', actions: [{ id: 'open-session', label: 'Open session' }, { id: 'dismiss', label: 'Dismiss' }] });
    expect(items[0]?.title).toMatch(/^Waiting for you: /);
    // The stored status stays the process's; only the read status is `need`.
    expect((await w.store.sessions.get(started.id))?.status).toBe('done');

    // The developer replies: the new turn clears the wait and closes the item; its plain answer ends done.
    expect((await call('POST', `/api/sessions/${started.id}/messages`, { text: 'Yes, merge it.' })).statusCode).toBe(202);
    await until(async () => ((await w.store.sessions.get(started.id))?.turnWait === null ? true : undefined), 'the wait cleared');
    await until(async () => ((await closedOutcomes(w.store, started.id)).length === 1 ? true : undefined), 'the item closed');
    expect(await closedOutcomes(w.store, started.id)).toEqual(['new-turn']);
    await waitForStatus(w.store, started.id, ['done']);
    await until(async () => ((await session(started.id)).status === 'done' ? true : undefined), 'done');
    expect(await waitingItems(started.id)).toEqual([]);
  });

  it('turn_status stores a declaration (validated); Not waiting and a Dismiss of its Inbox item clear it; a new episode raises a new item', async () => {
    const w = await setup();
    const started = await w.supervisor.start(newSession(), w.place);
    await waitForStatus(w.store, started.id, ['done']);
    expect((await session(started.id)).status).toBe('done');

    // Refusals: no ask with waiting_for_you / blocked, an unknown status, a too long ask, a foreign token.
    expect((await agent(started.id, { status: 'waiting_for_you' })).statusCode).toBe(422);
    expect((await agent(started.id, { status: 'maybe', ask: 'x' })).statusCode).toBe(422);
    expect((await agent(started.id, { status: 'blocked', ask: 'x'.repeat(301) })).statusCode).toBe(422);
    expect(
      (
        await app!.inject({ method: 'POST', url: '/agent/v1/turn-status', headers: { host: HOST, 'x-switchboard-session': started.id, authorization: `Bearer ${agentTokenFor(token, 'another')}`, 'content-type': 'application/json' }, payload: '{"status":"done"}' })
      ).statusCode,
    ).toBe(401);

    const declared = await agent(started.id, { status: 'waiting_for_you', ask: '  Pick   A or B  ' });
    expect(declared.statusCode).toBe(200);
    expect(declared.json()).toMatchObject({ status: 'waiting_for_you', ask: 'Pick A or B', source: 'declared' });
    const shown = await session(started.id);
    expect(shown).toMatchObject({ status: 'need', turnWait: { status: 'waiting_for_you', ask: 'Pick A or B', source: 'declared' } });
    const [item] = await until(async () => {
      const found = await waitingItems(started.id);
      return found.length > 0 ? found : undefined;
    }, 'the item');
    expect(item?.label).toBe('Waiting for you');

    // Not waiting: the false "needs you" goes, the item closes.
    const cleared = await call('POST', `/api/sessions/${started.id}/not-waiting`, { at: shown.turnWait?.at });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ status: 'done', turnWait: null });
    await until(async () => ((await waitingItems(started.id)).length === 0 ? true : undefined), 'the item closed');

    // Blocked: a new episode, a new item; its Dismiss clears the session's wait too.
    expect((await agent(started.id, { status: 'blocked', ask: 'Approve the production environment' })).statusCode).toBe(200);
    const [blocked] = await until(async () => {
      const found = await waitingItems(started.id);
      return found.length > 0 ? found : undefined;
    }, 'the blocked item');
    expect((await session(started.id)).status).toBe('need');
    expect((await call('POST', `/api/inbox/${blocked?.id}/actions/dismiss`, {})).statusCode).toBe(204);
    await until(async () => ((await session(started.id)).status === 'done' ? true : undefined), 'cleared by the Dismiss');
    expect((await session(started.id)).turnWait).toBeNull();
    // A declared done changes nothing for the developer.
    expect((await agent(started.id, { status: 'done' })).statusCode).toBe(200);
    expect((await session(started.id)).status).toBe('done');
    expect(await waitingItems(started.id)).toEqual([]);
    expect(await closedOutcomes(w.store, started.id)).toHaveLength(2);
  });
});

describe('D124 · the turn wait service (precedence, clearing)', () => {
  let dir = '';
  let store: Store | undefined;

  afterEach(async () => {
    await store?.close();
    if (dir) await removeTempDir(dir);
    store = undefined;
    dir = '';
  });

  async function service(): Promise<{ turns: TurnStatusService; id: string; published: string[] }> {
    dir = await makeTempDir('turn-status');
    store = await openTempStore(dir);
    const id = (await store.sessions.create({ name: 'turns', claudeSessionId: randomUUID(), status: 'run' })).id;
    const published: string[] = [];
    const turns = new TurnStatusService({ store, publish: async (sessionId) => void published.push(sessionId), now: () => new Date('2026-10-21T10:00:00.000Z') });
    return { turns, id, published };
  }

  it('a declared done beats a question at the turn end; a declared waiting beats a done text; a new turn clears it', async () => {
    const { turns, id, published } = await service();
    await turns.declare(id, { status: 'done' });
    await turns.turnEnded(id, { outcome: 'success', text: 'Shall I go on?' });
    expect((await store!.sessions.get(id))?.turnWait).toMatchObject({ status: 'done', source: 'declared' });

    await turns.turnStarted(id);
    expect((await store!.sessions.get(id))?.turnWait).toBeNull();
    await turns.declare(id, { status: 'waiting_for_you', ask: 'Which region?' });
    await turns.turnEnded(id, { outcome: 'success', text: 'All done.' });
    expect((await store!.sessions.get(id))?.turnWait).toMatchObject({ status: 'waiting_for_you', ask: 'Which region?', source: 'declared' });

    // A detected wait of an earlier turn is no declaration: the next end's text decides again.
    await turns.turnStarted(id);
    await turns.turnEnded(id, { outcome: 'success', text: 'Do you want the migration too?' });
    expect((await store!.sessions.get(id))?.turnWait).toMatchObject({ source: 'detected', ask: 'Do you want the migration too?' });
    await turns.turnEnded(id, { outcome: 'success', text: 'Merged. Nothing left.' });
    expect((await store!.sessions.get(id))?.turnWait).toBeNull();
    // A stopped or failed turn is not text-checked.
    await turns.turnEnded(id, { outcome: 'stopped', text: null });
    await turns.turnEnded(id, { outcome: 'error', text: 'Should I retry?' });
    expect((await store!.sessions.get(id))?.turnWait).toBeNull();
    expect(published.length).toBeGreaterThanOrEqual(6);
    expect(new Set(published)).toEqual(new Set([id]));
  });

  it('a declaration that reached Switchboard after the turn\'s start was seen is that turn\'s: its start does not clear it', async () => {
    const { turns, id } = await service();
    await turns.declare(id, { status: 'waiting_for_you', ask: 'Which region?' });
    // The turn's `init` arrived at 09:59 but was handled after the call (10:00): the declaration stays.
    expect(await turns.turnStarted(id, new Date('2026-10-21T09:59:59.000Z'))).toBe(false);
    expect((await store!.sessions.get(id))?.turnWait).toMatchObject({ ask: 'Which region?' });
    // A later turn clears it.
    expect(await turns.turnStarted(id, new Date('2026-10-21T10:00:01.000Z'))).toBe(true);
    expect((await store!.sessions.get(id))?.turnWait).toBeNull();
  });

  it('a chat (D106) is not text-checked; its agent\'s declaration still counts', async () => {
    const { turns } = await service();
    const chat = (await store!.sessions.create({ name: 'a-chat', claudeSessionId: randomUUID(), kind: 'chat', status: 'run' })).id;
    await turns.turnEnded(chat, { outcome: 'success', text: 'Want me to compare the two options in a table?' });
    expect((await store!.sessions.get(chat))?.turnWait).toBeNull();
    await turns.turnStarted(chat);
    await turns.declare(chat, { status: 'waiting_for_you', ask: 'Pick an option' });
    await turns.turnEnded(chat, { outcome: 'success', text: 'Done.' });
    expect((await store!.sessions.get(chat))?.turnWait).toMatchObject({ ask: 'Pick an option', source: 'declared' });
  });

  it('Not waiting with another episode\'s time leaves the current wait', async () => {
    const { turns, id } = await service();
    await turns.declare(id, { status: 'blocked', ask: 'Rotate the key' });
    await turns.notWaiting(id, '2026-01-01T00:00:00.000Z');
    expect((await store!.sessions.get(id))?.turnWait).toMatchObject({ status: 'blocked' });
    await turns.notWaiting(id, '2026-10-21T10:00:00.000Z');
    expect((await store!.sessions.get(id))?.turnWait).toBeNull();
  });
});

describe('D124 · Not waiting on a paired machine and a phone', () => {
  it('is forwarded to a peer (answering the session) and allowed for devices', () => {
    expect(peerApiAllowed('POST', '/api/sessions/s1/not-waiting')).toBe(true);
    expect(peerAnswerKind('POST', '/api/sessions/s1/not-waiting')).toBe('session');
    expect(DEVICE_ALLOWED.some(([methods, pattern]) => methods.split('|').includes('POST') && pattern.test('/api/sessions/s1/not-waiting'))).toBe(true);
  });
});

describe('D124 · the turn_status tool (the helper)', () => {
  it('sends status and ask to /agent/v1/turn-status; refuses, sending nothing, without an ask for waiting_for_you / blocked or with an unknown status', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const api: AgentApi = async (method, route, body) => {
      calls.push([method, route, body]);
      return { status: 200, body: { status: (body as { status: string }).status, ask: (body as { ask?: string }).ask ?? null, source: 'declared', at: 'x' } };
    };
    expect((await turnStatus(api, { status: 'waiting_for_you' })).isError).toBe(true);
    expect((await turnStatus(api, { status: 'later', ask: 'x' })).isError).toBe(true);
    expect(calls).toEqual([]);
    const waiting = await turnStatus(api, { status: 'waiting_for_you', ask: ' Pick A or B ' });
    expect(waiting.isError).toBeUndefined();
    expect(waiting.content).toEqual([{ type: 'text', text: 'Recorded: waiting for the developer (Pick A or B). Switchboard shows the developer this ask until the next turn starts.' }]);
    const done = await turnStatus(api, { status: 'done' });
    expect(done.content).toEqual([{ type: 'text', text: 'Recorded: done. Switchboard shows this turn as finished.' }]);
    expect(calls).toEqual([
      ['POST', '/agent/v1/turn-status', { status: 'waiting_for_you', ask: 'Pick A or B' }],
      ['POST', '/agent/v1/turn-status', { status: 'done' }],
    ]);
  });
});

describe('D124 · push and the D75 reminder', () => {
  function waitingItem(id: string, createdAt: string): InboxItem {
    return { id, kind: 'system', systemKind: 'turn-waiting', sessionId: 's1', source: 'Acme release', status: 'need', title: 'Waiting for you: Acme release', label: 'Waiting for you', detail: 'Pick A or B', createdAt, branches: [], actions: [] };
  }

  it('a new "Waiting for you" item is pushed like a question ("<session> needs you", the ask); run → need is no "finished" push', async () => {
    expect(inboxNotice(waitingItem('i1', '2026-10-21T10:00:00.000Z'))).toMatchObject({ kind: 'questions', urgency: 'high', payload: { title: 'Acme release needs you', body: 'Pick A or B', url: '/sessions/s1' } });
    let now = Date.parse('2026-10-21T10:00:00.000Z');
    const bus = new HubBus();
    let items: InboxItem[] = [];
    const sent: string[] = [];
    const notifier = new PushNotifier({ bus, inbox: async () => items, now: () => now, deliver: async (notice) => void sent.push(`${notice.kind} ${notice.payload.title} | ${notice.payload.body}`) });
    await notifier.start();
    bus.publish('sessionUpdated', { id: 's1', name: 'Acme release', status: 'run' } as unknown as Session);
    now += 1_000;
    bus.publish('sessionUpdated', { id: 's1', name: 'Acme release', status: 'need', turnWait: { status: 'waiting_for_you', ask: 'Pick A or B', source: 'declared', at: new Date(now).toISOString() } } as unknown as Session);
    items = [waitingItem('i1', new Date(now).toISOString())];
    bus.publish('inboxChanged', { count: 1 });
    await notifier.idle();
    expect(sent).toEqual(['questions Acme release needs you | Pick A or B']);
    await notifier.stop();
  });

  it('a turn that ends waiting for you sends no finish reminder; the next turn that ends done does', async () => {
    const tmp = await makeTempDir('turn-status-reminder');
    const store = await openTempStore(tmp);
    try {
      let clock = Date.parse('2026-10-21T10:00:00.000Z');
      const bus = new HubBus();
      const todos = new TodoService({ store, bus, now: () => clock });
      const delivered: string[] = [];
      const reminder = new TodoReminder({ bus, todos, now: () => clock, enabled: async () => true, deliver: async (_id, text) => void delivered.push(text) !== undefined });
      reminder.start();
      const id = (await store.sessions.create({ name: 'remind-wait', claudeSessionId: randomUUID() })).id;
      const item = (await todos.add(id, { title: 'Started' }, 'developer')).todo;
      await todos.startItem(id, item.id, async () => undefined);
      const update = (status: Session['status'], turnWait: Session['turnWait'] = null) => bus.publish('sessionUpdated', { id, status, closedAt: null, turnWait } as unknown as Session);
      update('idle');
      clock += 1_000;
      update('run');
      clock += 1_000;
      update('need', { status: 'waiting_for_you', ask: 'Which region?', source: 'detected', at: new Date(clock).toISOString() });
      await reminder.idle();
      expect(delivered).toEqual([]);
      // The developer answers: a new turn; it ends done with the item untouched: one reminder.
      clock += 1_000;
      update('run');
      clock += 1_000;
      update('done');
      await reminder.idle();
      expect(delivered).toHaveLength(1);
      await reminder.stop();
    } finally {
      await store.close();
      await removeTempDir(tmp);
    }
  });
});

