import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Folder, Session, SessionTodo, SessionTodoList, TodoRunResult } from '../../../src/core/api.ts';
import type { ModelRule } from '../../../src/core/model-routing.ts';
import { HANDLED_BY_AGENT, type Review, type ReviewResolvedEvent, resolutionLabel } from '../../../src/core/reviews.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { ReviewGit } from '../../../src/server/reviews/git.ts';
import { ReviewService } from '../../../src/server/reviews/service.ts';
import { agentTokenFor } from '../../../src/server/todos/agent-token.ts';
import { TodoService } from '../../../src/server/todos/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import { fakeGhCommand } from '../../../tools/fake-gh/command.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';
import { type SupervisorWorld, makeSupervisorWorld, readFakeLog, until } from '../../helpers/supervisor.ts';

/**
 * Integration of the 1.13 lanes on the real path (fake-claude, temp git repos, the real
 * worktree manager, the real TodoService / ReviewService / TodoReviewLink on one bus):
 *
 * - D76 × D79: a todo runs in its own session; its agent marks it done → the item waits in
 *   `review`; the run session's Review card is resolved → merge / commit / dismiss → done,
 *   discard → open (run discarded, link kept), send back → in progress, changes gone without a
 *   click → "Handled by the agent" + dismissed → done.
 * - D76 × D80: the run session has a checkpoint before its first turn.
 * - D76 × D82: a *Model by task* rule routes a run (and says so); no matching rule = the source's settings.
 * - D76 × D83: a fresh continuation moves the list with its run links, actuals and capture flags.
 */
const PORT = 4878; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

let sw: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let reviews: ReviewService | undefined;
let token = '';

afterEach(async () => {
  await app?.close();
  await reviews?.stop();
  await sw?.cleanup();
  app = undefined;
  reviews = undefined;
  sw = undefined;
});

interface Rig {
  readonly s: SupervisorWorld;
  readonly g: GitWorld;
  readonly bus: HubBus;
  readonly repo: Folder;
  readonly repoPath: string;
  readonly resolved: ReviewResolvedEvent[];
  readonly sent: Array<{ sessionId: string; text: string }>;
}

async function setup(): Promise<Rig> {
  sw = await makeSupervisorWorld({ scenario: 'handoff-start' });
  const g = await makeGitWorld({ root: sw.root, workspace: sw.workspace, store: sw.store, baseEnv: sw.env });
  const repoPath = await g.makeRepo(path.join(sw.root, 'solo'));
  const worktrees = g.manager({ sessions: sw.supervisor });
  const bus = new HubBus();
  const resolved: ReviewResolvedEvent[] = [];
  bus.subscribe((message) => {
    if (message.name === 'reviewResolved') resolved.push(message.payload);
  });
  const sent: Array<{ sessionId: string; text: string }> = [];
  const errors = sw.errors;
  reviews = new ReviewService({
    store: sw.store,
    bus,
    git: new ReviewGit({ gh: fakeGhCommand(), env: g.env }),
    resolveRepo: (solution, folder) => worktrees.resolveRepo(solution, folder),
    enabled: async () => true,
    send: async (sessionId, text) => {
      sent.push({ sessionId, text });
    },
    onError: (error) => errors.push(error),
  });
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: sw.root }, platform: 'linux', home: sw.root, cwd: sw.root });
  app = await buildApp({ config: { ...base, port: PORT }, token, store: sw.store, webRoot: sw.root, supervisor: sw.supervisor, worktrees, providers: { diff: worktrees }, bus, reviews });
  await app.ready();
  const repo = (await call('POST', '/api/folders', { path: repoPath })).json() as Folder;
  return { s: sw, g, bus, repo, repoPath, resolved, sent };
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

/** ▸ Run in new session, then its agent's work: a commit in its worktree, and it marks the item done (→ review). */
async function runAndFinish(rig: Rig, sourceId: string, title: string): Promise<{ run: Session; todoId: string; card: Review }> {
  const todoId = await addTodo(sourceId, title);
  const response = await call('POST', `/api/sessions/${sourceId}/todos/${todoId}/run`);
  expect(response.statusCode, response.body).toBe(201);
  const run = (response.json() as TodoRunResult).session;
  // D80: the run session's first turn has its checkpoint.
  await until(async () => (await rig.s.store.checkpoints.listOf(run.id, 'turn')).length > 0, 'the run session’s first checkpoint');
  await rig.g.commit(run.cwd ?? '', `${todoId}.txt`, `${title}\n`, `Work on ${title}`);
  const done = await agent(run.id, 'PUT', `/agent/v1/todos/${todoId}`, { state: 'done' });
  expect(done.statusCode, done.body).toBe(200);
  expect(await itemOf(sourceId, todoId)).toMatchObject({ state: 'review', runSessionId: run.id, runState: 'active' });
  // D79: the run session gets a Review card for its changes (raised at a turn's end; evaluated here directly).
  const card = await reviews!.evaluate(run.id);
  expect(card).toMatchObject({ sessionId: run.id, state: 'pending', mode: 'branch' });
  return { run, todoId, card: card as Review };
}

async function settled(sourceId: string, todoId: string, state: SessionTodo['state']): Promise<SessionTodo> {
  return until(async () => {
    const item = await itemOf(sourceId, todoId);
    return item?.state === state ? item : undefined;
  }, `the item ${state}`);
}

describe('a todo run through review (D76 × D79 × D80)', () => {
  it('run → agent marks done → review → the card resolves it: merge, dismiss → done; discard → open; send back → in progress; changes gone → handled by the agent, done', async () => {
    const rig = await setup();
    const src = await source(rig);

    // Merge → done.
    const merged = await runAndFinish(rig, src.id, 'Merge me');
    expect(merged.card.actions).toContain('merge');
    await reviews!.act(merged.card.id, 'merge', {});
    expect(await settled(src.id, merged.todoId, 'done')).toMatchObject({ runSessionId: merged.run.id });
    expect(await rig.g.git(rig.repoPath, 'show', `main:${merged.todoId}.txt`)).toBe('Merge me');

    // Dismiss → done.
    const dismissed = await runAndFinish(rig, src.id, 'Dismiss me');
    await reviews!.act(dismissed.card.id, 'dismiss', {});
    await settled(src.id, dismissed.todoId, 'done');

    // Discard → open; the run is kept as history (discarded) and the item can run again.
    const discarded = await runAndFinish(rig, src.id, 'Discard me');
    await reviews!.act(discarded.card.id, 'discard', { confirm: true });
    expect(await settled(src.id, discarded.todoId, 'open')).toMatchObject({ runSessionId: discarded.run.id, runState: 'discarded' });

    // Send back → in progress (the run's), the comment goes to the run session.
    const sentBack = await runAndFinish(rig, src.id, 'Send me back');
    await reviews!.act(sentBack.card.id, 'send-back', { comment: 'Add a test.' });
    expect(await settled(src.id, sentBack.todoId, 'in_progress')).toMatchObject({ startedBy: 'run', runState: 'active' });
    expect(rig.sent.some((entry) => entry.sessionId === sentBack.run.id && entry.text.includes('Add a test.'))).toBe(true);

    // The changes vanish without a click (the agent reverted them): "Handled by the agent", dismissed → done.
    const vanished = await runAndFinish(rig, src.id, 'Vanish');
    await rig.g.git(vanished.run.cwd ?? '', 'reset', '-q', '--hard', 'HEAD~1');
    const listed = await reviews!.list();
    const handled = listed.find((review) => review.id === vanished.card.id);
    expect(handled).toMatchObject({ state: 'resolved', outcome: 'dismissed', handledByAgent: true });
    expect(resolutionLabel(handled as Review)).toBe(HANDLED_BY_AGENT);
    await settled(src.id, vanished.todoId, 'done');

    expect(rig.resolved.map((event) => event.outcome)).toEqual(['merged', 'dismissed', 'discarded', 'sent-back', 'dismissed']);
    expect(rig.resolved.every((event) => Object.keys(event).sort().join() === 'outcome,sessionId')).toBe(true);
  }, 120_000);

  it('a run working in a repo folder (no worktree): Commit → done', async () => {
    const rig = await setup();
    const src = await source(rig);
    const todoId = await addTodo(src.id, 'Commit me');
    // A run session working in place in the repo (folder mode), linked like ▸ Run links it.
    const runRecord = await rig.s.store.sessions.create({ name: 'commit-run', claudeSessionId: randomUUID(), cwd: rig.repoPath, root: rig.repoPath, rootKind: 'repo', solutions: [], worktrees: false });
    await rig.s.store.sessions.update(runRecord.id, { todoLink: { sourceSessionId: src.id, todoId } });
    await new TodoService({ store: rig.s.store, bus: rig.bus }).beginRun(src.id, todoId, runRecord.id);
    expect(await itemOf(src.id, todoId)).toMatchObject({ state: 'in_progress', runSessionId: runRecord.id });
    expect((await agent(runRecord.id, 'PUT', `/agent/v1/todos/${todoId}`, { state: 'done' })).statusCode).toBe(200);
    expect(await itemOf(src.id, todoId)).toMatchObject({ state: 'review' });
    await writeFile(path.join(rig.repoPath, 'commit-me.txt'), 'done\n');
    const card = await reviews!.evaluate(runRecord.id);
    expect(card).toMatchObject({ mode: 'folder', state: 'pending' });
    expect(card?.actions).toContain('commit');
    await reviews!.act(card!.id, 'commit', { message: 'Commit me' });
    await settled(src.id, todoId, 'done');
    expect(await rig.g.git(rig.repoPath, 'log', '-1', '--format=%s')).toBe('Commit me');
    expect(rig.resolved).toEqual([{ sessionId: runRecord.id, outcome: 'committed' }]);
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
    // Its review resolves the item (the review card is the fresh run session's).
    await todos.update(freshSource, running, { state: 'done' });
    expect((await todos.get(freshSource, running)).state).toBe('review');
    await todos.resolveReview(runFresh, 'merged');
    expect((await todos.get(freshSource, running)).state).toBe('done');
  }, 60_000);
});
