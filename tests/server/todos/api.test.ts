import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionTodoList, TodoGroup } from '../../../src/core/api.ts';
import { mapPeerAnswer, peerAnswerKind, peerHubEvent } from '../../../src/core/peer-wire.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HubBus, type HubMessage } from '../../../src/server/hub/bus.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { agentTokenFor, agentTokenMatches } from '../../../src/server/todos/agent-token.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D68 oracle: the UI's todo routes, the agent's (`/agent/v1/todos`, only with the
 * session's own agent token: a token for session A never reaches session B), the
 * cross-session `GET /api/todos`, the hub events, the peer allow-list and the
 * peer mapping of the answers.
 */

const PORT = 4876; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;
const MACHINE = { id: 'abcdefghijkl', name: 'studio-pc', state: 'online' as const };

let tmp: string;
let store: Store;
let app: FastifyInstance;
let token: string;
let published: HubMessage[];

beforeEach(async () => {
  tmp = await makeTempDir('api-todos');
  store = await openTempStore(tmp);
  token = generateToken();
  const bus = new HubBus();
  published = [];
  bus.subscribe((message) => published.push(message));
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
  app = await buildApp({ config, token, store, webRoot: tmp, bus });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await store.close();
  await removeTempDir(tmp);
});

function ui(method: InjectOptions['method'], url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

function agent(sessionId: string, bearer: string | null, method: InjectOptions['method'], url: string, payload?: unknown, extra: Record<string, string> = {}) {
  return app.inject({
    method,
    url,
    headers: {
      host: HOST,
      'x-switchboard-session': sessionId,
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...extra,
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

async function session(name: string): Promise<string> {
  return (await store.sessions.create({ name, claudeSessionId: randomUUID() })).id;
}

describe('the UI routes (D68)', () => {
  it('add, edit, tick, untick, reorder, delete, clear done: each answers the whole list; 404 / 422 as documented', async () => {
    const id = await session('ui');
    expect((await ui('GET', `/api/sessions/${id}/todos`)).json()).toEqual({ sessionId: id, todos: [], openCount: 0, doneCount: 0 });
    const added = await ui('POST', `/api/sessions/${id}/todos`, { text: 'Write the docs' });
    expect(added.statusCode).toBe(201);
    const first = (added.json() as SessionTodoList).todos[0]!;
    expect(first).toMatchObject({ text: 'Write the docs', addedBy: 'developer', state: 'open', position: 0 });
    const second = ((await ui('POST', `/api/sessions/${id}/todos`, { text: 'Run the tests' })).json() as SessionTodoList).todos[1]!;
    expect((await ui('PUT', `/api/sessions/${id}/todos/${first.id}`, { text: 'Write the API docs' })).json().todos[0].text).toBe('Write the API docs');
    const ticked = (await ui('PUT', `/api/sessions/${id}/todos/${first.id}`, { state: 'done' })).json() as SessionTodoList;
    expect(ticked).toMatchObject({ openCount: 1, doneCount: 1 });
    expect(ticked.todos[0]?.removeAt).not.toBeNull();
    expect((await ui('PUT', `/api/sessions/${id}/todos/${first.id}`, { state: 'open' })).json().todos[0]).toMatchObject({ state: 'open', doneAt: null, removeAt: null });
    expect((await ui('PUT', `/api/sessions/${id}/todos/order`, { ids: [second.id, first.id] })).json().todos.map((t: { text: string }) => t.text)).toEqual(['Run the tests', 'Write the API docs']);
    expect((await ui('PUT', `/api/sessions/${id}/todos/order`, { ids: [second.id] })).statusCode).toBe(422);
    await ui('PUT', `/api/sessions/${id}/todos/${second.id}`, { state: 'done' });
    expect((await ui('POST', `/api/sessions/${id}/todos/clear-done`)).json()).toMatchObject({ openCount: 1, doneCount: 0 });
    expect((await ui('DELETE', `/api/sessions/${id}/todos/${first.id}`)).json()).toMatchObject({ todos: [], openCount: 0 });
    expect((await ui('DELETE', `/api/sessions/${id}/todos/${first.id}`)).statusCode).toBe(404);
    expect((await ui('POST', `/api/sessions/${id}/todos`, { text: '' })).statusCode).toBe(422);
    expect((await ui('POST', `/api/sessions/${id}/todos`, {})).statusCode).toBe(422);
    expect((await ui('GET', '/api/sessions/nope/todos')).statusCode).toBe(404);
    // The cookie is needed, as on every API route.
    expect((await app.inject({ method: 'GET', url: `/api/sessions/${id}/todos`, headers: { host: HOST } })).statusCode).toBe(401);
  });

  it('every change publishes todosChanged and the session (its openTodoCount)', async () => {
    const id = await session('events');
    await ui('POST', `/api/sessions/${id}/todos`, { text: 'one' });
    expect(published.filter((m) => m.name === 'todosChanged').map((m) => m.payload)).toEqual([{ sessionId: id, openCount: 1, doneCount: 0 }]);
    const sessions = (await ui('GET', '/api/sessions')).json() as Array<{ id: string; openTodoCount: number }>;
    expect(sessions.find((s) => s.id === id)?.openTodoCount).toBe(1);
  });

  it('GET /api/todos groups every open session with items', async () => {
    const a = await session('alpha');
    const b = await session('beta');
    await session('empty');
    await ui('POST', `/api/sessions/${a}/todos`, { text: 'a1' });
    await ui('POST', `/api/sessions/${b}/todos`, { text: 'b1' });
    const groups = (await ui('GET', '/api/todos')).json() as TodoGroup[];
    expect(groups.map((g) => g.title).sort()).toEqual(['alpha', 'beta']);
    expect(groups.every((g) => g.machine === null)).toBe(true);
  });
});

describe('title, description and plan (D69)', () => {
  it('the UI adds and edits all three; `text` is an alias of title on input and equals it on output; limits are 422', async () => {
    const id = await session('fields');
    const added = await ui('POST', `/api/sessions/${id}/todos`, { title: '  Fix the login test flake ', description: 'Retries hide a race.', plan: '## Steps\n1. Find the race' });
    expect(added.statusCode).toBe(201);
    const item = (added.json() as SessionTodoList).todos[0]!;
    expect(item).toMatchObject({ title: 'Fix the login test flake', text: 'Fix the login test flake', description: 'Retries hide a race.', plan: '## Steps\n1. Find the race' });
    // A 1.7.0 client sends `text` only: it is the title; title wins when both come.
    const legacy = ((await ui('POST', `/api/sessions/${id}/todos`, { text: 'Rename PROJ-12 keys' })).json() as SessionTodoList).todos[1]!;
    expect(legacy).toMatchObject({ title: 'Rename PROJ-12 keys', text: 'Rename PROJ-12 keys', description: null, plan: null });
    expect(((await ui('POST', `/api/sessions/${id}/todos`, { title: 'Title wins', text: 'ignored' })).json() as SessionTodoList).todos[2]).toMatchObject({ title: 'Title wins' });
    // Edit: only the given fields change; '' or null removes a description / plan.
    const edited = (await ui('PUT', `/api/sessions/${id}/todos/${item.id}`, { description: '' })).json() as SessionTodoList;
    expect(edited.todos[0]).toMatchObject({ title: 'Fix the login test flake', description: null, plan: '## Steps\n1. Find the race' });
    expect(((await ui('PUT', `/api/sessions/${id}/todos/${item.id}`, { plan: null, title: 'Fix it' })).json() as SessionTodoList).todos[0]).toMatchObject({ title: 'Fix it', text: 'Fix it', plan: null });
    expect(((await ui('PUT', `/api/sessions/${id}/todos/${legacy.id}`, { text: 'Renamed by 1.7.0' })).json() as SessionTodoList).todos[1]).toMatchObject({ title: 'Renamed by 1.7.0' });
    // Limits: title 1–120, one line; description 4,000; plan 8,000.
    for (const body of [{ title: 'x'.repeat(121) }, { title: 'two\nlines' }, { title: 'ok', description: 'd'.repeat(4_001) }, { title: 'ok', plan: 'p'.repeat(8_001) }, { title: 'ok', plan: 5 }]) {
      expect((await ui('POST', `/api/sessions/${id}/todos`, body)).statusCode, JSON.stringify(body).slice(0, 40)).toBe(422);
    }
    expect((await ui('POST', `/api/sessions/${id}/todos`, { title: 'x'.repeat(120), description: 'd'.repeat(4_000), plan: 'p'.repeat(8_000) })).statusCode).toBe(201);
    expect((await ui('PUT', `/api/sessions/${id}/todos/${item.id}`, { title: '' })).statusCode).toBe(422);
  });

  it('the agent reads one item in full (todo_get), only in its own session', async () => {
    const a = await session('get-a');
    const b = await session('get-b');
    const bearer = agentTokenFor(token, a);
    const { todo } = (await agent(a, bearer, 'POST', '/agent/v1/todos', { title: 'Plan me', description: 'For you.', plan: 'For the next agent.' })).json() as { todo: { id: string } };
    expect((await agent(a, bearer, 'GET', `/agent/v1/todos/${todo.id}`)).json()).toMatchObject({ id: todo.id, title: 'Plan me', description: 'For you.', plan: 'For the next agent.', addedBy: 'agent' });
    expect((await agent(a, bearer, 'GET', '/agent/v1/todos/nope')).statusCode).toBe(404);
    const itemB = ((await ui('POST', `/api/sessions/${b}/todos`, { title: 'B only' })).json() as SessionTodoList).todos[0]!;
    expect((await agent(a, bearer, 'GET', `/agent/v1/todos/${itemB.id}`)).statusCode).toBe(404);
  });
});

describe("the agent routes: scoped to the token's session (D68)", () => {
  it("the agent adds (addedBy agent), lists, ticks, renames and removes its own session's items", async () => {
    const id = await session('agent');
    const bearer = agentTokenFor(token, id);
    const added = await agent(id, bearer, 'POST', '/agent/v1/todos', { text: 'Add a test for the parser' });
    expect(added.statusCode).toBe(201);
    const { todo } = added.json() as { todo: { id: string; addedBy: string } };
    expect(todo.addedBy).toBe('agent');
    expect((await agent(id, bearer, 'GET', '/agent/v1/todos')).json()).toMatchObject({ sessionId: id, openCount: 1 });
    expect((await agent(id, bearer, 'PUT', `/agent/v1/todos/${todo.id}`, { state: 'done' })).json()).toMatchObject({ todo: { state: 'done' } });
    expect((await agent(id, bearer, 'PUT', `/agent/v1/todos/${todo.id}`, { text: 'Parser tests' })).json()).toMatchObject({ todo: { text: 'Parser tests' } });
    expect((await agent(id, bearer, 'DELETE', `/agent/v1/todos/${todo.id}`)).json()).toMatchObject({ todos: [] });
    expect(published.filter((m) => m.name === 'todosChanged')).toHaveLength(4);
  });

  it("a token for session A cannot read or touch session B's items", async () => {
    const a = await session('a');
    const b = await session('b');
    const tokenA = agentTokenFor(token, a);
    const itemB = ((await ui('POST', `/api/sessions/${b}/todos`, { text: 'B only' })).json() as SessionTodoList).todos[0]!;
    // A's token naming B: refused before any route runs.
    expect((await agent(b, tokenA, 'GET', '/agent/v1/todos')).statusCode).toBe(401);
    expect((await agent(b, tokenA, 'POST', '/agent/v1/todos', { text: 'sneaky' })).statusCode).toBe(401);
    // A's own session cannot reach B's item by its id either.
    expect((await agent(a, tokenA, 'PUT', `/agent/v1/todos/${itemB.id}`, { state: 'done' })).statusCode).toBe(404);
    expect((await agent(a, tokenA, 'DELETE', `/agent/v1/todos/${itemB.id}`)).statusCode).toBe(404);
    expect((await ui('GET', `/api/sessions/${b}/todos`)).json()).toMatchObject({ openCount: 1, todos: [{ text: 'B only', state: 'open' }] });
    expect(agentTokenMatches(token, a, tokenA)).toBe(true);
    expect(agentTokenMatches(token, b, tokenA)).toBe(false);
    expect(agentTokenFor(generateToken(), a)).not.toBe(tokenA);
  });

  it('no token, a wrong one, the cookie, or a browser Origin: refused', async () => {
    const id = await session('guard');
    expect((await agent(id, null, 'GET', '/agent/v1/todos')).statusCode).toBe(401);
    expect((await agent(id, 'x'.repeat(43), 'GET', '/agent/v1/todos')).statusCode).toBe(401);
    expect((await agent('', agentTokenFor(token, ''), 'GET', '/agent/v1/todos')).statusCode).toBe(401);
    expect((await agent(id, null, 'GET', '/agent/v1/todos', undefined, { cookie: `sb_token=${token}` })).statusCode).toBe(401);
    expect((await agent(id, agentTokenFor(token, id), 'GET', '/agent/v1/todos', undefined, { origin: `http://${HOST}` })).statusCode).toBe(403);
    expect((await agent(id, agentTokenFor(token, id), 'GET', '/agent/v1/todos', undefined, { host: 'evil.example:4876' })).statusCode).toBe(403);
    // The agent token opens nothing else.
    expect((await agent(id, agentTokenFor(token, id), 'GET', '/api/sessions')).statusCode).toBe(401);
    // A session that does not exist (a valid token for an unknown id): 404.
    expect((await agent('gone', agentTokenFor(token, 'gone'), 'GET', '/agent/v1/todos')).statusCode).toBe(404);
  });
});

describe('peers (D48 / D68)', () => {
  it('the todo routes are on the peer allow-list; the agent routes are not', () => {
    for (const [method, url] of [
      ['GET', '/api/sessions/s1/todos'],
      ['POST', '/api/sessions/s1/todos'],
      ['POST', '/api/sessions/s1/todos/clear-done'],
      ['PUT', '/api/sessions/s1/todos/order'],
      ['PUT', '/api/sessions/s1/todos/abc'],
      ['DELETE', '/api/sessions/s1/todos/abc'],
      ['GET', '/api/todos'],
    ] as const) {
      expect(peerApiAllowed(method, url), `${method} ${url}`).toBe(true);
    }
    expect(peerApiAllowed('GET', '/agent/v1/todos')).toBe(false);
    expect(peerApiAllowed('GET', '/api/sessions/r~abcdefghijkl~s1/todos')).toBe(false);
  });

  it("a peer's answers and todosChanged carry its remote session ids; a 1.7.0 peer's items get title = text (D69)", () => {
    // A peer still on 1.7.0 answers items with `text` only.
    const legacyItem = { id: 't1', sessionId: 's1', text: 'x', state: 'open', addedBy: 'agent', position: 0, createdAt: 'a', updatedAt: 'a', doneAt: null, removeAt: null } as unknown as SessionTodoList['todos'][number];
    const list: SessionTodoList = { sessionId: 's1', openCount: 1, doneCount: 0, todos: [legacyItem] };
    expect(peerAnswerKind('PUT', '/api/sessions/s1/todos/t1')).toBe('todo-list');
    expect(peerAnswerKind('POST', '/api/sessions/s1/todos/clear-done')).toBe('todo-list');
    expect(peerAnswerKind('GET', '/api/todos')).toBe('todo-groups');
    const mapped = mapPeerAnswer(MACHINE, 'todo-list', list) as SessionTodoList;
    expect(mapped.sessionId).toBe('r~abcdefghijkl~s1');
    expect(mapped.todos[0]).toMatchObject({ id: 't1', sessionId: 'r~abcdefghijkl~s1', title: 'x', text: 'x', description: null, plan: null });
    const group: TodoGroup = { sessionId: 's1', title: 'T', solutions: [], folderPath: null, machine: null, lastActivityAt: null, todos: list.todos };
    expect((mapPeerAnswer(MACHINE, 'todo-groups', [group]) as TodoGroup[])[0]).toMatchObject({ sessionId: 'r~abcdefghijkl~s1', machine: { id: MACHINE.id, name: 'studio-pc' } });
    expect(peerHubEvent(MACHINE, 'todosChanged', { sessionId: 's1', openCount: 2, doneCount: 0 })).toEqual({ sessionId: 'r~abcdefghijkl~s1', openCount: 2, doneCount: 0 });
  });
});
