import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionTodo, SessionTodoList, TodoGroup } from '../../../src/core/api.ts';
import { peerAnswerKind, peerSession, peerTodo } from '../../../src/core/peer-wire.ts';
import { formatTokens, resultTurnTokens, todoActualsLabel, todoActualsTotal, todoActualsTotalLabel, todoCalibration } from '../../../src/core/todo-actuals.ts';
import { splitTodos, todoCountsLabel, todoIsOpen, todoLine, todoListText } from '../../../src/core/todos.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { openDatabase } from '../../../src/server/db/database.ts';
import { loadMigrations, migrate, needsForeignKeysOff } from '../../../src/server/db/migrate.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { DEVICE_ALLOWED } from '../../../src/server/devices/local-only.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { agentTokenFor } from '../../../src/server/todos/agent-token.ts';
import { TodoReviewLink } from '../../../src/server/todos/review-link.ts';
import { todoRunOptions } from '../../../src/server/todos/run-options.ts';
import { runSlug, runTitle } from '../../../src/server/todos/run.ts';
import { TodoService } from '../../../src/server/todos/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D76 / D77 / D78 oracle (`docs/todos.md` → *Run in a new session*, *Review*, *Board*,
 * *Actual vs. estimate*): migration 0032, the review state (done of an item with an active
 * run is review; the board's drag skips it; `reviewResolved` moves it on), the run
 * session's scope on its one linked item, the actuals (time in progress only, the turns'
 * tokens, the history that outlives the done hour) and the agents' calibration line.
 */

let tmp: string;
let store: Store;
let clock: number;

beforeEach(async () => {
  tmp = await makeTempDir('todos-run');
  clock = Date.parse('2026-10-08T10:00:00.000Z');
  store = await openTempStore(tmp, { now: () => new Date(clock) });
});

afterEach(async () => {
  await store.close();
  await removeTempDir(tmp);
});

async function session(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await store.sessions.create({ name, claudeSessionId: randomUUID(), ...extra })).id;
}

function service(bus = new HubBus()): TodoService {
  return new TodoService({ store, bus, now: () => clock });
}

const MIN = 60_000;

/** A turn's result event of session `sessionId` at the clock, with `tokens`. */
async function turn(sessionId: string, tokens: number | null): Promise<void> {
  await store.events.append({ sessionId, kind: 'ok', ts: new Date(clock).toISOString(), payload: { type: 'result', subtype: 'success', isError: false, ...(tokens === null ? {} : { tokens }) } });
}

describe('migration 0032 (D76 / D78)', () => {
  it('rebuilds session_todos with review, run and actuals columns; rows stay; sessions.todo_link; todo_actuals', async () => {
    const shipped = await loadMigrations();
    const m32 = shipped.find((m) => m.version === 32);
    expect(m32).toMatchObject({ name: 'todo_run' });
    expect(needsForeignKeysOff(m32!)).toBe(false);
    const db = await openDatabase(':memory:');
    migrate(db, shipped.filter((m) => m.version <= 31));
    const ts = '2026-10-08T09:00:00.000Z';
    db.prepare('INSERT INTO sessions (id, name, claude_session_id, cwd, root, root_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('s', 'old', 'c', '/tmp/x', '/tmp/x', 'repo', ts, ts);
    const insert = db.prepare(
      'INSERT INTO session_todos (id, session_id, title, plan, priority, estimate_minutes, state, added_by, position, created_at, updated_at, done_at, started_at, started_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run('a', 's', 'Started', '1. Do it', 'high', 45, 'in_progress', 'agent', 0, ts, ts, null, ts, 'start');
    insert.run('b', 's', 'Done', 'No plan', 'medium', null, 'done', 'developer', 1, ts, ts, ts, null, null);
    expect(migrate(db, shipped.filter((m) => m.version <= 32)).applied).toEqual([32]);
    const columns = db.prepare('PRAGMA table_info(session_todos)').all().map((row) => String(row['name']));
    expect(columns.slice(-6)).toEqual(['run_session_id', 'run_state', 'started_first_at', 'span_started_at', 'actual_ms', 'actual_tokens']);
    expect(db.prepare('SELECT id, state, started_at, started_by, done_at, run_session_id, actual_ms FROM session_todos ORDER BY position').all().map((row) => ({ ...row }))).toEqual([
      { id: 'a', state: 'in_progress', started_at: ts, started_by: 'start', done_at: null, run_session_id: null, actual_ms: null },
      { id: 'b', state: 'done', started_at: null, started_by: null, done_at: ts, run_session_id: null, actual_ms: null },
    ]);
    // review needs a run; a run needs its state; run is a start source now.
    expect(() => db.prepare(`UPDATE session_todos SET state = 'review' WHERE id = 'a'`).run()).toThrow(/CHECK/);
    expect(() => db.prepare(`UPDATE session_todos SET run_session_id = 'r' WHERE id = 'a'`).run()).toThrow(/CHECK/);
    db.prepare(`UPDATE session_todos SET run_session_id = 'r', run_state = 'active', started_by = 'run' WHERE id = 'a'`).run();
    db.prepare(`UPDATE session_todos SET state = 'review' WHERE id = 'a'`).run();
    expect(() => db.prepare(`UPDATE session_todos SET run_state = 'paused' WHERE id = 'a'`).run()).toThrow(/CHECK/);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session_todos' AND sql IS NOT NULL ORDER BY name`).all().map((row) => row['name'])).toEqual([
      'session_todos_done',
      'session_todos_run',
      'session_todos_session',
    ]);
    // sessions.todo_link (JSON object or NULL) and the actuals history.
    expect(db.prepare(`SELECT todo_link FROM sessions`).get()?.['todo_link']).toBeNull();
    expect(() => db.prepare(`UPDATE sessions SET todo_link = '[1]'`).run()).toThrow(/CHECK/);
    expect(db.prepare('PRAGMA table_info(todo_actuals)').all().map((row) => String(row['name']))).toEqual(['todo_id', 'session_id', 'folder', 'title', 'estimate_minutes', 'actual_ms', 'actual_tokens', 'completed_at']);
    db.close();
  });
});

describe('the rules (D76 / D78)', () => {
  const item = (id: string, state: SessionTodo['state'], extra: Partial<SessionTodo> = {}): SessionTodo => ({
    id,
    sessionId: 's',
    title: id,
    text: id,
    description: null,
    plan: 'No plan',
    priority: 'medium',
    estimateMinutes: null,
    state,
    addedBy: 'agent',
    position: 0,
    createdAt: '',
    updatedAt: '',
    doneAt: null,
    removeAt: null,
    ...extra,
  });

  it('review is neither open nor done; the counts, the split and the tools show it', () => {
    const todos = [item('a', 'open', { estimateMinutes: 30 }), item('b', 'review', { estimateMinutes: 600, position: 1 }), item('c', 'done', { position: 2 })];
    expect(todos.map(todoIsOpen)).toEqual([true, false, false]);
    expect(splitTodos(todos)).toMatchObject({ open: [{ id: 'a' }], review: [{ id: 'b' }], done: [{ id: 'c' }] });
    expect(todoCountsLabel(todos)).toBe('1 open · ~30m · 1 in review · 1 done');
    expect(todoLine(item('b', 'review'))).toBe('[b] ◑ IN REVIEW MEDIUM ~? b');
    expect(todoListText({ sessionId: 's', todos, openCount: 1, doneCount: 1 })).toContain('In review (1):\n[b] ◑ IN REVIEW MEDIUM ~10h b');
  });

  it('actuals: tokens of a result line, the labels, the totals and the calibration line', () => {
    expect(resultTurnTokens({ usage: { input_tokens: 10, cache_creation_input_tokens: 28_787, cache_read_input_tokens: 17_675, output_tokens: 95 } })).toBe(28_892);
    expect(resultTurnTokens({ usage: { input_tokens: 0, output_tokens: 0 } })).toBeNull();
    expect(resultTurnTokens({ modelUsage: {} })).toBeNull();
    expect([formatTokens(850), formatTokens(1_250), formatTokens(41_200), formatTokens(1_250_000)]).toEqual(['850', '1.3k', '41k', '1.3M']);
    expect(todoActualsLabel(item('a', 'done', { actualMs: 32 * MIN, actualTokens: 41_000 }))).toBe('took 32m · 41k tokens');
    expect(todoActualsLabel(item('a', 'review', { actualMs: 20_000, actualTokens: null }))).toBe('took <1m');
    expect(todoActualsLabel(item('a', 'in_progress', { actualMs: 32 * MIN }))).toBe('');
    const total = todoActualsTotal([
      { estimateMinutes: 60, actualMs: 90 * MIN, actualTokens: 100_000 },
      { estimateMinutes: null, actualMs: 10 * MIN, actualTokens: 5_000 },
    ]);
    expect(total).toEqual({ count: 2, estimated: 1, estimateMinutes: 60, estimatedActualMs: 90 * MIN, actualMs: 100 * MIN, tokens: 105_000 });
    expect(todoActualsTotalLabel(total)).toBe('est ~1h · took 1h 30m · 105k tokens (2 done)');
    const low = Array.from({ length: 12 }, () => ({ estimateMinutes: 10, actualMs: 14 * MIN, actualTokens: null }));
    expect(todoCalibration(low, 'this session')).toBe('Calibration: your last 10 estimates (this session) were 1.4× too low on average.');
    expect(todoCalibration(low.slice(0, 3).map((s) => ({ ...s, actualMs: 5 * MIN })), 'this folder')).toBe('Calibration: your last 3 estimates (this folder) were 2.0× too high on average.');
    expect(todoCalibration(low.slice(0, 3).map((s) => ({ ...s, actualMs: 10 * MIN })), 'this folder')).toBe('Calibration: your last 3 estimates (this folder) were about right on average.');
    expect(todoCalibration(low.slice(0, 2), 'this session')).toBeNull();
  });

  it('todoRunOptions: the source session’s CLI, model, effort and account unless a D82 rule routes it; the run’s title and slug', () => {
    const source = { provider: 'codex' as const, model: 'gpt-5', effort: 'high', profileId: 'p1' };
    expect(todoRunOptions({ source, todo: item('a', 'open') })).toEqual({ settings: source, rule: null, explanation: null });
    // D82 wired in: a matching Model by task rule routes the run (its line explains it); no match or no rules = the source's settings.
    const rule = { id: 'r1', priority: 'low' as const, estimate: { kind: 'at-most' as const, minutes: 30 }, provider: 'claude' as const, model: 'sonnet' };
    const routed = todoRunOptions({ source, todo: item('a', 'open', { priority: 'low', estimateMinutes: 20 }), rules: [rule] });
    expect(routed).toEqual({ settings: { provider: 'claude', model: 'sonnet', effort: null, profileId: null }, rule, explanation: 'Routed by rule: low ≤30 min → sonnet' });
    expect(todoRunOptions({ source, todo: item('a', 'open', { priority: 'low', estimateMinutes: 45 }), rules: [rule] })).toEqual({ settings: source, rule: null, explanation: null });
    expect(todoRunOptions({ source, todo: item('a', 'open', { priority: 'low', estimateMinutes: 20 }), rules: [] }).settings).toEqual(source);
    expect(runTitle('x'.repeat(120))).toHaveLength(80);
    expect(runSlug('Fix the login flake!')).toBe('fix-the-login-flake');
  });

  it('peers: the run route is allowed and mapped; a run session id and a todo link are namespaced', () => {
    const machine = { id: 'm1', name: 'Office', state: 'online' as const };
    expect(peerApiAllowed('POST', '/api/sessions/s1/todos/t1/run')).toBe(true);
    expect(DEVICE_ALLOWED.some(([methods, pattern]) => methods.split('|').includes('POST') && pattern.test('/api/sessions/s1/todos/t1/run'))).toBe(true);
    expect(peerAnswerKind('POST', '/api/sessions/s1/todos/t1/run')).toBe('todo-run');
    expect(peerTodo(machine, item('a', 'review', { runSessionId: 'run1' }))).toMatchObject({ state: 'review', runSessionId: 'r~m1~run1', sessionId: 'r~m1~s' });
    const session = peerSession(machine, { id: 'run1', todoLink: { sourceSessionId: 's', todoId: 'a' } } as never);
    expect(session.todoLink).toEqual({ sourceSessionId: 'r~m1~s', todoId: 'a' });
  });
});

describe('TodoService: review and the run scope (D76)', () => {
  it('done of an item with an active run is review (not open, not removed); the board drag skips it; review needs a run', async () => {
    const todos = service();
    const id = await session('source');
    const run = await session('run');
    const { todo } = await todos.add(id, { title: 'Run me', estimateMinutes: 30 }, 'developer');
    await expect(todos.update(id, todo.id, { state: 'review' })).rejects.toMatchObject({ status: 422 });
    await todos.beginRun(id, todo.id, run);
    expect((await todos.get(id, todo.id))).toMatchObject({ state: 'in_progress', startedBy: 'run', runSessionId: run, runState: 'active' });
    const reviewed = await todos.update(id, todo.id, { state: 'done' });
    expect(reviewed.todo).toMatchObject({ state: 'review', doneAt: null, removeAt: null });
    expect(reviewed.list).toMatchObject({ openCount: 0, doneCount: 0, reviewCount: 1 });
    // Done from review is done (the developer approves); back to review by hand; the board's drag to Done skips review.
    expect((await todos.update(id, todo.id, { state: 'done' })).todo.state).toBe('done');
    expect((await todos.update(id, todo.id, { state: 'review' })).todo.state).toBe('review');
    expect((await todos.update(id, todo.id, { state: 'in_progress' })).todo.state).toBe('in_progress');
    expect((await todos.update(id, todo.id, { state: 'done', skipReview: true })).todo.state).toBe('done');
  });

  it('reviewResolved: merged / committed / dismissed → done, discarded → open (run discarded, link kept), sent back → in progress', async () => {
    const bus = new HubBus();
    const todos = service(bus);
    const link = new TodoReviewLink({ bus, todos });
    link.start();
    const id = await session('source');
    const outcomes = ['merged', 'committed', 'dismissed', 'discarded', 'sent-back'] as const;
    const items: Record<string, string> = {};
    for (const outcome of outcomes) {
      const run = await session(`run-${outcome}`);
      const { todo } = await todos.add(id, { title: outcome }, 'developer');
      await todos.beginRun(id, todo.id, run);
      await todos.update(id, todo.id, { state: 'done' }, 'agent');
      items[outcome] = todo.id;
      bus.publish('reviewResolved', { sessionId: run, outcome });
    }
    // A resolution for a session without items in review changes nothing.
    bus.publish('reviewResolved', { sessionId: 'unknown', outcome: 'merged' });
    await link.idle();
    const byId = new Map((await todos.list(id)).todos.map((t) => [t.id, t]));
    expect(byId.get(items['merged']!)?.state).toBe('done');
    expect(byId.get(items['committed']!)?.state).toBe('done');
    expect(byId.get(items['dismissed']!)?.state).toBe('done');
    expect(byId.get(items['discarded']!)).toMatchObject({ state: 'open', runState: 'discarded' });
    expect(byId.get(items['discarded']!)?.runSessionId).toMatch(/.+/);
    expect(byId.get(items['sent-back']!)).toMatchObject({ state: 'in_progress', startedBy: 'run', runState: 'active' });
    // A discarded run's item done again is done (no active run).
    expect((await todos.update(id, items['discarded']!, { state: 'done' })).todo.state).toBe('done');
    await link.stop();
  });

  it("a run session's agent reaches its one linked item (get, start, done → review), nothing else of the source's list", async () => {
    const todos = service();
    const id = await session('source');
    const { todo } = await todos.add(id, { title: 'Linked' }, 'developer');
    const { todo: other } = await todos.add(id, { title: 'Other' }, 'developer');
    const run = await session('run', { todoLink: { sourceSessionId: id, todoId: todo.id } });
    await todos.beginRun(id, todo.id, run);
    expect(await todos.agentScope(run, todo.id)).toEqual({ sessionId: id, linked: true });
    expect(await todos.agentScope(run, other.id)).toEqual({ sessionId: run, linked: false });
    expect((await todos.linkedTodo(run))?.id).toBe(todo.id);
    expect(await todos.linkedTodo(id)).toBeNull();
    // The reminder: the run session for its linked item; the source session not (started by run).
    expect((await todos.remindable(run, 0)).map((t) => t.id)).toEqual([todo.id]);
    expect(await todos.remindable(id, 0)).toEqual([]);
    // Once the run is discarded the link no longer reaches it.
    await store.todos.setRun(todo.id, run, 'discarded');
    expect(await todos.agentScope(run, todo.id)).toEqual({ sessionId: run, linked: false });
  });
});

describe('actuals (D78)', () => {
  it('time in progress only (open time excluded), the working session’s turn tokens, the history outlives the done hour', async () => {
    const todos = service();
    const id = await session('source', { root: '/repo/one', rootKind: 'repo' });
    const { todo } = await todos.add(id, { title: 'Measure', estimateMinutes: 20 }, 'developer');
    await todos.update(id, todo.id, { state: 'in_progress' }, 'agent');
    clock += 10 * MIN;
    await turn(id, 30_000);
    clock += 5 * MIN;
    // Back to open: 15 minutes so far; time in open does not count.
    await todos.update(id, todo.id, { state: 'open' });
    clock += 60 * MIN;
    await turn(id, 99_999);
    await todos.update(id, todo.id, { state: 'in_progress' }, 'agent');
    clock += 3 * MIN;
    await turn(id, 11_000);
    clock += 2 * MIN;
    const done = (await todos.update(id, todo.id, { state: 'done' }, 'agent')).todo;
    expect(done).toMatchObject({ state: 'done', actualMs: 20 * MIN, actualTokens: 41_000, startedFirstAt: '2026-10-08T10:00:00.000Z' });
    expect(todoActualsLabel(done)).toBe('took 20m · 41k tokens');
    // The group's totals; still there after the done hour removed the item.
    const group = (await todos.groups()).find((g: TodoGroup) => g.sessionId === id);
    expect(group?.actuals).toMatchObject({ count: 1, estimated: 1, estimateMinutes: 20, actualMs: 20 * MIN, tokens: 41_000 });
    await todos.start();
    clock += 61 * MIN;
    await todos.sweep();
    todos.close();
    expect((await todos.list(id)).todos).toEqual([]);
    expect((await todos.groups()).find((g) => g.sessionId === id)).toBeUndefined();
    expect((await store.todos.actualsFor([id])).get(id)).toEqual([{ estimateMinutes: 20, actualMs: 20 * MIN, actualTokens: 41_000 }]);
  });

  it('a run item counts the run session’s turns; reopening drops its record; ▶ Start again keeps the span', async () => {
    const todos = service();
    const id = await session('source');
    const run = await session('run');
    const { todo } = await todos.add(id, { title: 'Run', estimateMinutes: 10 }, 'developer');
    await todos.beginRun(id, todo.id, run);
    clock += 4 * MIN;
    await turn(id, 5_000);
    await turn(run, 7_000);
    clock += MIN;
    // ▶ Start of an item already in progress keeps its span.
    await store.todos.start(todo.id, 'start');
    clock += 5 * MIN;
    const reviewed = (await todos.update(id, todo.id, { state: 'done' }, 'agent')).todo;
    expect(reviewed).toMatchObject({ state: 'review', actualMs: 10 * MIN, actualTokens: 7_000 });
    expect((await store.todos.actualsFor([id])).get(id)).toHaveLength(1);
    await todos.update(id, todo.id, { state: 'open' });
    expect((await store.todos.actualsFor([id])).get(id)).toBeUndefined();
  });

  it('calibration: this session’s last estimates when it has three, else its folder’s; none below three', async () => {
    const todos = service();
    const a = await session('a', { root: '/repo/one', rootKind: 'repo' });
    const b = await session('b', { root: '/repo/one', rootKind: 'repo' });
    const finish = async (sessionId: string, estimate: number, minutes: number): Promise<void> => {
      const { todo } = await todos.add(sessionId, { title: `t${clock}`, estimateMinutes: estimate }, 'agent');
      await todos.update(sessionId, todo.id, { state: 'in_progress' }, 'agent');
      clock += minutes * MIN;
      await todos.update(sessionId, todo.id, { state: 'done' }, 'agent');
    };
    expect(await todos.calibration(a)).toBeNull();
    for (let i = 0; i < 3; i++) await finish(a, 10, 20);
    expect(await todos.calibration(a)).toBe('Calibration: your last 3 estimates (this session) were 2.0× too low on average.');
    // b has none of its own: its folder's (a's) count.
    expect(await todos.calibration(b)).toBe('Calibration: your last 3 estimates (this folder) were 2.0× too low on average.');
  });
});

describe('the agent routes (D76 / D78)', () => {
  const PORT = 4877;
  const HOST = `127.0.0.1:${PORT}`;
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    token = generateToken();
    const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
    app = await buildApp({ config, token, store, webRoot: tmp, bus: new HubBus() });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  function ui(method: InjectOptions['method'], url: string, payload?: unknown) {
    return app.inject({ method, url, headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
  }

  function agent(sessionId: string, method: InjectOptions['method'], url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { host: HOST, 'x-switchboard-session': sessionId, authorization: `Bearer ${agentTokenFor(token, sessionId)}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  }

  it("the run session's token: its linked item (get, start, done → review), its own list in the answers; the rest of the source's list stays out of reach", async () => {
    const id = await session('source');
    const list = (await ui('POST', `/api/sessions/${id}/todos`, { title: 'Linked', plan: '1. Do it' })).json() as SessionTodoList;
    const linked = list.todos[0]!.id;
    const other = ((await ui('POST', `/api/sessions/${id}/todos`, { title: 'Secret' })).json() as SessionTodoList).todos.find((t) => t.title === 'Secret')!.id;
    const run = await session('run', { todoLink: { sourceSessionId: id, todoId: linked } });
    await store.todos.setRun(linked, run, 'active');
    await store.todos.start(linked, 'run');

    const listed = (await agent(run, 'GET', '/agent/v1/todos')).json() as Record<string, unknown>;
    expect(listed).toMatchObject({ sessionId: run, todos: [], linked: { id: linked, title: 'Linked' }, calibration: null });
    expect(JSON.stringify(listed)).not.toContain('Secret');
    expect((await agent(run, 'GET', `/agent/v1/todos/${linked}`)).json()).toMatchObject({ id: linked, plan: '1. Do it' });
    expect((await agent(run, 'GET', `/agent/v1/todos/${other}`)).statusCode).toBe(404);
    expect((await agent(run, 'PUT', `/agent/v1/todos/${other}`, { state: 'done' })).statusCode).toBe(404);
    expect((await agent(run, 'DELETE', `/agent/v1/todos/${linked}`)).statusCode).toBe(404);
    const done = await agent(run, 'PUT', `/agent/v1/todos/${linked}`, { state: 'done' });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ todo: { id: linked, state: 'review' }, list: { sessionId: run, todos: [] }, linked: true });
    expect(done.body).not.toContain('Secret');
    // The source's list: in review; the UI's drag to Done (skipReview) makes it done.
    const after = (await ui('PUT', `/api/sessions/${id}/todos/${linked}`, { state: 'done', skipReview: true })).json() as SessionTodoList;
    expect(after.todos.find((t) => t.id === linked)?.state).toBe('done');
    // The session carries its link.
    expect((await ui('GET', `/api/sessions/${run}`)).json()).toMatchObject({ todoLink: { sourceSessionId: id, todoId: linked } });
  });

  it('todo_add / todo_update answers carry the calibration line once there are three completed estimates', async () => {
    const id = await session('cal', { root: '/repo/cal', rootKind: 'repo' });
    for (let i = 0; i < 3; i++) {
      const added = (await agent(id, 'POST', '/agent/v1/todos', { title: `t${i}`, plan: 'No plan', priority: 'medium', estimateMinutes: 10 })).json() as { todo: SessionTodo; calibration: string | null };
      await agent(id, 'PUT', `/agent/v1/todos/${added.todo.id}`, { state: 'in_progress' });
      clock += 15 * MIN;
      await agent(id, 'PUT', `/agent/v1/todos/${added.todo.id}`, { state: 'done' });
    }
    const added = (await agent(id, 'POST', '/agent/v1/todos', { title: 'next', plan: 'No plan', priority: 'medium', estimateMinutes: 10 })).json() as { calibration: string | null };
    expect(added.calibration).toBe('Calibration: your last 3 estimates (this session) were 1.5× too low on average.');
  });
});
