import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Folder, Session, SessionTodo, SessionTodoList, TodoRunResult } from '../../../src/core/api.ts';
import type { ModelRule } from '../../../src/core/model-routing.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { agentTokenFor } from '../../../src/server/todos/agent-token.ts';
import { TodoService } from '../../../src/server/todos/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';
import { type SupervisorWorld, makeSupervisorWorld, readFakeLog, until } from '../../helpers/supervisor.ts';

/**
 * Integration of the 1.13 lanes on the real path (fake-claude, temp git repos, the real
 * worktree manager, the real TodoService on one bus):
 *
 * - D76 × D102: a todo runs in its own session; its agent marks it done → done (no review
 *   state, no review card: `/api/reviews` is gone).
 * - D76 × D80: the run session has a checkpoint before its first turn.
 * - D76 × D82: a *Model by task* rule routes a run (and says so); no matching rule = the source's settings.
 * - D76 × D83: a fresh continuation moves the list with its run links, actuals and capture flags.
 */
const PORT = 4878; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

let sw: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';

afterEach(async () => {
  await app?.close();
  await sw?.cleanup();
  app = undefined;
  sw = undefined;
});

interface Rig {
  readonly s: SupervisorWorld;
  readonly g: GitWorld;
  readonly bus: HubBus;
  readonly repo: Folder;
  readonly repoPath: string;
}

async function setup(): Promise<Rig> {
  sw = await makeSupervisorWorld({ scenario: 'handoff-start' });
  const g = await makeGitWorld({ root: sw.root, workspace: sw.workspace, store: sw.store, baseEnv: sw.env });
  const repoPath = await g.makeRepo(path.join(sw.root, 'solo'));
  const worktrees = g.manager({ sessions: sw.supervisor });
  const bus = new HubBus();
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: sw.root }, platform: 'linux', home: sw.root, cwd: sw.root });
  app = await buildApp({ config: { ...base, port: PORT }, token, store: sw.store, webRoot: sw.root, supervisor: sw.supervisor, worktrees, providers: { diff: worktrees }, bus });
  await app.ready();
  const repo = (await call('POST', '/api/folders', { path: repoPath })).json() as Folder;
  return { s: sw, g, bus, repo, repoPath };
}

function call(method: InjectOptions['method'], url: string, payload?: unknown) {
  if (!app) throw new Error('no app');
  return app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

function agent(sessionId: string, method: InjectOptions['method'], url: string, payload?: unknown) {
  if (!app) throw new Error('no app');
  return app.inject({
    method,
    url,
    headers: { host: HOST, 'x-switchboard-session': sessionId, authorization: `Bearer ${agentTokenFor(token, sessionId)}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

async function source(rig: Rig): Promise<Session> {
  const started = await call('POST', '/api/sessions', { simple: true, name: 'source', title: 'Source', task: 'Hello', folder: rig.repo.id, worktrees: false, model: 'opus', effort: 'high' });
  expect(started.statusCode, started.body).toBe(201);
  return started.json() as Session;
}

async function addTodo(sessionId: string, title: string, fields: { priority?: string; estimateMinutes?: number } = {}): Promise<string> {
  const list = (await call('POST', `/api/sessions/${sessionId}/todos`, { title, plan: 'No plan', priority: fields.priority ?? 'high', estimateMinutes: fields.estimateMinutes ?? 30 })).json() as SessionTodoList;
  const item = list.todos.find((todo) => todo.title === title);
  if (!item) throw new Error('no item');
  return item.id;
}

async function itemOf(sessionId: string, todoId: string): Promise<SessionTodo | undefined> {
  return ((await call('GET', `/api/sessions/${sessionId}/todos`)).json() as SessionTodoList).todos.find((todo) => todo.id === todoId);
}

describe('a todo run (D76 × D80 × D102)', () => {
  it('run → its agent commits and marks the item done → done (no review state); no review card, no /api/reviews', async () => {
    const rig = await setup();
    const src = await source(rig);
    const todoId = await addTodo(src.id, 'Finish me');
    const response = await call('POST', `/api/sessions/${src.id}/todos/${todoId}/run`);
    expect(response.statusCode, response.body).toBe(201);
    const run = (response.json() as TodoRunResult).session;
    // D80: the run session's first turn has its checkpoint.
    await until(async () => (await rig.s.store.checkpoints.listOf(run.id, 'turn')).length > 0, 'the run session’s first checkpoint');
    await rig.g.commit(run.cwd ?? '', `${todoId}.txt`, 'done\n', 'Work on it');
    const done = await agent(run.id, 'PUT', `/agent/v1/todos/${todoId}`, { state: 'done' });
    expect(done.statusCode, done.body).toBe(200);
    expect(await itemOf(src.id, todoId)).toMatchObject({ state: 'done', runSessionId: run.id, runState: 'active' });
    const list = (await call('GET', `/api/sessions/${src.id}/todos`)).json() as SessionTodoList;
    expect(list).toMatchObject({ openCount: 0, doneCount: 1 });
    expect(list).not.toHaveProperty('reviewCount');
    // D102: the review queue is gone: no route, no Inbox item for the run's changes.
    for (const [method, url] of [['GET', '/api/reviews'], ['POST', '/api/reviews/abc/merge'], ['POST', '/api/reviews/abc/dismiss']] as const) expect((await call(method, url)).statusCode, url).toBe(404);
    expect(((await call('GET', '/api/inbox')).json() as Array<{ kind: string }>).filter((item) => item.kind !== 'questions' && item.kind !== 'permission')).toEqual([]);
    expect(rig.s.errors).toEqual([]);
  }, 60_000);
});

describe('D82 routes a todo run (D76 × D82)', () => {
  it('a rule "low ≤30 min → Sonnet" routes a matching run and says so; no matching rule = the source’s settings', async () => {
    const rig = await setup();
    const src = await source(rig);
    const rule: ModelRule = { id: 'quick', priority: 'low', estimate: { kind: 'at-most', minutes: 30 }, provider: 'claude', model: 'sonnet' };
    const saved = await call('PUT', '/api/settings', { 'sessions.modelRules': [rule] });
    expect(saved.statusCode, saved.body).toBe(200);

    const quick = await addTodo(src.id, 'Quick fix', { priority: 'low', estimateMinutes: 20 });
    const routed = await call('POST', `/api/sessions/${src.id}/todos/${quick}/run`);
    expect(routed.statusCode, routed.body).toBe(201);
    const routedResult = routed.json() as TodoRunResult;
    // The label comes from the CLI's reported model list (`Sonnet …`).
    expect(routedResult.routing).toMatch(/^Routed by rule: low ≤30 min → Sonnet\b/);
    expect(await rig.s.store.sessions.get(routedResult.session.id)).toMatchObject({ provider: 'claude', model: 'sonnet', effort: null });
    const spawn = await until(async () => (await readFakeLog(rig.s.logFile)).find((line) => line.kind === 'argv' && line.argv?.includes(routedResult.session.claudeSessionId)), 'the routed spawn');
    expect(spawn.argv).toEqual(expect.arrayContaining(['--model', 'sonnet']));

    const long = await addTodo(src.id, 'Long refactor', { priority: 'low', estimateMinutes: 120 });
    const plain = (await call('POST', `/api/sessions/${src.id}/todos/${long}/run`)).json() as TodoRunResult;
    expect(plain.routing).toBeNull();
    expect(await rig.s.store.sessions.get(plain.session.id)).toMatchObject({ provider: 'claude', model: 'opus', effort: 'high' });
  }, 60_000);
});

describe('D83 moves a list with its D76 / D78 / D81 fields', () => {
  it('moveAll keeps run links, actuals and capture flags; a continued run session keeps its item; runs of moved items name the fresh source', async () => {
    const rig = await setup();
    const store = rig.s.store;
    const todos = new TodoService({ store, bus: rig.bus });
    const create = async (name: string) => (await store.sessions.create({ name, claudeSessionId: randomUUID() })).id;
    const oldSource = await create('old-source');
    const freshSource = await create('fresh-source');
    const runOld = await create('run-old');
    const runFresh = await create('run-fresh');

    // The old source's list: a running item (D76), a captured one (D81), one done with actuals (D78).
    const running = (await todos.add(oldSource, { title: 'Running', plan: 'No plan', priority: 'low', estimateMinutes: 10 }, 'agent')).todo.id;
    await store.sessions.update(runOld, { todoLink: { sourceSessionId: oldSource, todoId: running } });
    await todos.beginRun(oldSource, running, runOld);
    const captured = (await todos.capture(oldSource, { title: 'Captured', from: 'palette' }, true)).todo;
    const finished = (await todos.add(oldSource, { title: 'Finished', plan: 'No plan', estimateMinutes: 5 }, 'agent')).todo.id;
    await todos.update(oldSource, finished, { state: 'in_progress' });
    await todos.update(oldSource, finished, { state: 'done' });
    const before = await todos.list(oldSource);

    // The old source continues in a fresh session (D83): its list moves.
    expect(await todos.moveAll(oldSource, freshSource)).toBe(3);
    const after = await todos.list(freshSource);
    expect(after.todos.map((todo) => todo.id).sort()).toEqual(before.todos.map((todo) => todo.id).sort());
    expect(after.todos.find((todo) => todo.id === running)).toMatchObject({ state: 'in_progress', startedBy: 'run', runSessionId: runOld, runState: 'active' });
    expect(after.todos.find((todo) => todo.id === captured.id)).toMatchObject({ needsEnrichment: captured.needsEnrichment, capturedFrom: 'palette' });
    const done = after.todos.find((todo) => todo.id === finished);
    expect(done?.actualMs).toBe(before.todos.find((todo) => todo.id === finished)?.actualMs);
    expect((await todos.groups()).find((group) => group.sessionId === freshSource)?.actuals).toMatchObject({ count: 1 });
    // The run's link names the fresh source: its agent still reaches the item.
    expect((await store.sessions.get(runOld))?.todoLink).toEqual({ sourceSessionId: freshSource, todoId: running });
    expect(await todos.agentScope(runOld, running)).toEqual({ sessionId: freshSource, linked: true });

    // The run session itself continues in a fresh one: the item's run follows, and the fresh run session reaches it.
    await todos.moveAll(runOld, runFresh);
    expect((await todos.get(freshSource, running)).runSessionId).toBe(runFresh);
    expect((await store.sessions.get(runFresh))?.todoLink).toEqual({ sourceSessionId: freshSource, todoId: running });
    expect(await todos.agentScope(runFresh, running)).toEqual({ sessionId: freshSource, linked: true });
    // Its run finishing it makes it done (D102: no review state).
    await todos.update(freshSource, running, { state: 'done' }, 'agent');
    expect((await todos.get(freshSource, running)).state).toBe('done');
  }, 60_000);
});
