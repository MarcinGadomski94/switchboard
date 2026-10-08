import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session, SessionTodo, SessionTodoList } from '../../../src/core/api.ts';
import { peerAnswerKind, peerTodo } from '../../../src/core/peer-wire.ts';
import {
  AGENT_MCP_INSTRUCTIONS,
  TODO_TOOLS,
  splitTodos,
  todoCountsLabel,
  todoDetailText,
  todoEstimateTotal,
  todoLine,
  todoReminderMessage,
  todoStartMessage,
} from '../../../src/core/todos.ts';
import { DEFAULT_STANDING_INSTRUCTION } from '../../../src/core/settings.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { openDatabase } from '../../../src/server/db/database.ts';
import { loadMigrations, migrate } from '../../../src/server/db/migrate.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { DEVICE_ALLOWED } from '../../../src/server/devices/local-only.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { agentTokenFor } from '../../../src/server/todos/agent-token.ts';
import { TodoReminder } from '../../../src/server/todos/reminder.ts';
import { TodoError, TodoService } from '../../../src/server/todos/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D75 oracle (`docs/todos.md` → *In progress (D75)*): migration 0031, the third
 * state (open → in progress → done and back), ▶ Start (in progress + the start
 * message sent, put back when it cannot be sent), the agent's `todo_start`, the
 * counts, the tools' text, the peer mapping and allow-lists, and the one finish
 * reminder when a turn ends with a started item untouched.
 */

let tmp: string;
let store: Store;
let clock: number;

beforeEach(async () => {
  tmp = await makeTempDir('todos-progress');
  clock = Date.parse('2026-10-08T10:00:00.000Z');
  store = await openTempStore(tmp, { now: () => new Date(clock) });
});

afterEach(async () => {
  await store.close();
  await removeTempDir(tmp);
});

async function session(name: string, extra: { hooked?: boolean } = {}): Promise<string> {
  return (await store.sessions.create({ name, claudeSessionId: randomUUID(), ...extra })).id;
}

/** An item as the API shapes it. */
function item(id: string, state: SessionTodo['state'], extra: Partial<SessionTodo> = {}): SessionTodo {
  return {
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
  };
}

describe('migration 0031 (D75)', () => {
  it('rebuilds session_todos with in_progress and the start columns; rows, ids and done times stay; the checks hold', async () => {
    const shipped = await loadMigrations();
    expect(shipped.find((m) => m.version === 31)).toMatchObject({ name: 'todo_in_progress' });
    const db = await openDatabase(':memory:');
    migrate(db, shipped.filter((m) => m.version <= 30));
    const ts = '2026-10-08T09:00:00.000Z';
    db.prepare('INSERT INTO sessions (id, name, claude_session_id, cwd, root, root_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('s', 'old', 'c', '/tmp/x', '/tmp/x', 'repo', ts, ts);
    const insert = db.prepare(
      'INSERT INTO session_todos (id, session_id, title, description, plan, priority, estimate_minutes, state, added_by, position, created_at, updated_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run('a', 's', 'Open one', 'Why', '1. Do it', 'high', 45, 'open', 'agent', 0, ts, ts, null);
    insert.run('b', 's', 'Done one', null, 'No plan', 'medium', null, 'done', 'developer', 1, ts, ts, ts);
    expect(migrate(db, shipped.filter((m) => m.version <= 31)).applied).toEqual([31]);
    const columns = db.prepare('PRAGMA table_info(session_todos)').all().map((row) => String(row['name']));
    expect(columns).toEqual(['id', 'session_id', 'title', 'state', 'added_by', 'position', 'created_at', 'updated_at', 'done_at', 'description', 'plan', 'priority', 'estimate_minutes', 'started_at', 'started_by', 'reminded_at']);
    expect(db.prepare('SELECT id, title, description, plan, priority, estimate_minutes, state, done_at, started_at, started_by, reminded_at FROM session_todos ORDER BY position').all().map((row) => ({ ...row }))).toEqual([
      { id: 'a', title: 'Open one', description: 'Why', plan: '1. Do it', priority: 'high', estimate_minutes: 45, state: 'open', done_at: null, started_at: null, started_by: null, reminded_at: null },
      { id: 'b', title: 'Done one', description: null, plan: 'No plan', priority: 'medium', estimate_minutes: null, state: 'done', done_at: ts, started_at: null, started_by: null, reminded_at: null },
    ]);
    // in_progress is a state now, and needs its start; an unknown state or source is refused.
    db.prepare(`UPDATE session_todos SET state = 'in_progress', started_at = ?, started_by = 'start' WHERE id = 'a'`).run(ts);
    expect(() => db.prepare(`UPDATE session_todos SET state = 'in_progress', started_at = NULL, started_by = NULL WHERE id = 'a'`).run()).toThrow(/CHECK/);
    expect(() => db.prepare(`UPDATE session_todos SET state = 'paused' WHERE id = 'a'`).run()).toThrow(/CHECK/);
    expect(() => db.prepare(`UPDATE session_todos SET started_by = 'robot' WHERE id = 'a'`).run()).toThrow(/CHECK/);
    // The indexes came back; deleting the session still deletes its items.
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session_todos' AND sql IS NOT NULL ORDER BY name`).all().map((row) => row['name'])).toEqual(['session_todos_done', 'session_todos_session']);
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare(`DELETE FROM sessions WHERE id = 's'`).run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM session_todos').get()?.['n']).toBe(0);
    db.close();
  });
});

describe('the rules (D75)', () => {
  it('in-progress items are open ones: they keep their priority place, count as open, and their estimates count', () => {
    const todos = [
      item('low-open', 'open', { priority: 'low', position: 0, estimateMinutes: 30 }),
      item('high-started', 'in_progress', { priority: 'high', position: 1, estimateMinutes: 90 }),
      item('medium-started', 'in_progress', { priority: 'medium', position: 2 }),
      item('urgent-open', 'open', { priority: 'urgent', position: 3, estimateMinutes: 15 }),
      item('finished', 'done', { position: 4, estimateMinutes: 600 }),
    ];
    const { open, done } = splitTodos(todos);
    // Not moved to the top: priority order, in progress or not.
    expect(open.map((t) => t.id)).toEqual(['urgent-open', 'high-started', 'medium-started', 'low-open']);
    expect(done.map((t) => t.id)).toEqual(['finished']);
    expect(todoEstimateTotal(todos)).toBe('~2h 15m+');
    expect(todoCountsLabel(todos)).toBe('2 in progress · 2 open · ~2h 15m+ · 1 done');
    // None in progress: the D70 header as before.
    expect(todoCountsLabel([item('a', 'open', { estimateMinutes: 120 }), item('b', 'done')])).toBe('1 open · ~2h · 1 done');
    expect(todoCountsLabel([item('a', 'in_progress')])).toBe('1 in progress · 0 open · 0 done');
  });

  it('the tools show the state; the start message ends with the finish line; the reminder text', () => {
    const started = item('a1b2c3d4e5f6', 'in_progress', { title: 'Fix the flake', priority: 'high', estimateMinutes: 45 });
    expect(todoLine(started)).toBe('[a1b2c3d4e5f6] ◐ IN PROGRESS HIGH ~45m Fix the flake');
    expect(todoDetailText(started).split('\n')[0]).toBe('[a1b2c3d4e5f6] ◐ in progress · added by the agent');
    expect(todoStartMessage({ id: 'a1b2c3d4e5f6', title: 'Fix the flake', description: null, plan: 'No plan' })).toBe(
      "Work on todo [a1b2c3d4e5f6]: Fix the flake\n\nWhen it's finished, mark it done with todo_done [a1b2c3d4e5f6]; if you stop before it's finished, say what's left.",
    );
    expect(todoReminderMessage(started)).toBe("Todo [a1b2c3d4e5f6] 'Fix the flake' is still in progress. If it's finished, mark it done with todo_done; if not, say what's left.");
  });

  it('todo_start is a tool; the tools, the MCP instructions and the default standing instruction say to start and finish every item', () => {
    expect(TODO_TOOLS.map((tool) => tool.name)).toEqual(['todo_list', 'todo_get', 'todo_add', 'todo_update', 'todo_start', 'todo_done', 'todo_remove']);
    const start = TODO_TOOLS.find((tool) => tool.name === 'todo_start');
    expect(start?.inputSchema).toEqual({ type: 'object', properties: { id: expect.any(Object) }, required: ['id'], additionalProperties: false });
    expect(start?.annotations).toEqual({ title: 'Start a todo item', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(start?.description).toMatch(/in progress when you start.*Always mark it done with todo_done/);
    expect(TODO_TOOLS.find((tool) => tool.name === 'todo_done')?.description).toMatch(/always/);
    expect(AGENT_MCP_INSTRUCTIONS).toContain('Mark an item in progress with todo_start when you start it and done with todo_done when you finish it: always.');
    expect(DEFAULT_STANDING_INSTRUCTION).toContain('always mark an item in progress when you start it and done when you finish it');
  });

  it('a peer before D75: no start, any unknown state reads as open; a D75 peer keeps in_progress and its start', () => {
    const machine = { id: 'abcdefghijkl', name: 'studio-pc', state: 'online' as const };
    const old = { ...item('x', 'open'), state: 'paused' } as unknown as SessionTodo;
    expect(peerTodo(machine, old)).toMatchObject({ state: 'open', startedAt: null, startedBy: null });
    expect(peerTodo(machine, item('y', 'in_progress', { startedAt: '2026-10-08T09:00:00.000Z', startedBy: 'start' }))).toMatchObject({ state: 'in_progress', startedAt: '2026-10-08T09:00:00.000Z', startedBy: 'start' });
    expect(peerAnswerKind('POST', '/api/sessions/s1/todos/t1/start')).toBe('todo-list');
    expect(peerApiAllowed('POST', '/api/sessions/s1/todos/t1/start')).toBe(true);
    expect(DEVICE_ALLOWED.some(([methods, path]) => methods.split('|').includes('POST') && path.test('/api/sessions/s1/todos/t1/start'))).toBe(true);
  });
});

describe('TodoService (D75)', () => {
  function service(bus = new HubBus()): TodoService {
    return new TodoService({ store, bus, now: () => clock });
  }

  it('open → in progress → done, done → reopen (open), in progress → open; the start is recorded and cleared', async () => {
    const todos = service();
    const id = await session('states');
    const { todo } = await todos.add(id, { title: 'One' }, 'developer');
    const started = await todos.update(id, todo.id, { state: 'in_progress' });
    expect(started.todo).toMatchObject({ state: 'in_progress', startedAt: '2026-10-08T10:00:00.000Z', startedBy: 'developer', doneAt: null });
    expect(started.list).toMatchObject({ openCount: 1, inProgressCount: 1, doneCount: 0 });
    expect((await store.sessions.get(id)) && (await store.todos.openCount(id))).toBe(1);
    clock += 60_000;
    const done = await todos.update(id, todo.id, { state: 'done' });
    expect(done.todo).toMatchObject({ state: 'done', doneAt: '2026-10-08T10:01:00.000Z', startedAt: '2026-10-08T10:00:00.000Z' });
    expect(done.list).toMatchObject({ openCount: 0, inProgressCount: 0, doneCount: 1 });
    expect((await todos.update(id, todo.id, { state: 'open' })).todo).toMatchObject({ state: 'open', doneAt: null, startedAt: null, startedBy: null });
    await todos.update(id, todo.id, { state: 'in_progress' }, 'agent');
    expect((await todos.get(id, todo.id)).startedBy).toBe('agent');
    expect((await todos.update(id, todo.id, { state: 'open' })).todo).toMatchObject({ state: 'open', startedAt: null });
    await expect(todos.update(id, todo.id, { state: 'paused' })).rejects.toMatchObject({ status: 422, message: 'state must be open, in_progress, review or done' });
  });

  it('▶ Start: in progress and the start message sent; again re-arms it; a done item is refused; a refused send puts it back', async () => {
    const bus = new HubBus();
    const published: string[] = [];
    bus.subscribe((message) => published.push(message.name));
    const todos = service(bus);
    const id = await session('start');
    const { todo } = await todos.add(id, { title: 'Fix the flake', plan: '1. Find the race', priority: 'high' }, 'developer');
    const sent: Array<[string, string]> = [];
    const send = async (sessionId: string, text: string): Promise<void> => {
      sent.push([sessionId, text]);
    };
    published.length = 0;
    const result = await todos.startItem(id, todo.id, send);
    expect(sent).toEqual([[id, todoStartMessage({ id: todo.id, title: 'Fix the flake', description: null, plan: '1. Find the race' })]]);
    expect(result.todo).toMatchObject({ state: 'in_progress', startedBy: 'start', startedAt: '2026-10-08T10:00:00.000Z' });
    expect(published).toContain('todosChanged');
    // Started again (in progress already): a fresh start, the reminder re-armed.
    await store.todos.markReminded(todo.id);
    clock += 5_000;
    await todos.startItem(id, todo.id, send);
    expect(await store.todos.get(todo.id)).toMatchObject({ state: 'in_progress', startedAt: '2026-10-08T10:00:05.000Z', remindedAt: null });
    expect(sent).toHaveLength(2);
    // The message cannot be sent: the item is as it was, the error goes on.
    const other = (await todos.add(id, { title: 'Other' }, 'developer')).todo;
    await expect(todos.startItem(id, other.id, async () => Promise.reject(new Error('closed')))).rejects.toThrow('closed');
    expect(await store.todos.get(other.id)).toMatchObject({ state: 'open', startedAt: null, startedBy: null });
    await todos.update(id, other.id, { state: 'done' });
    await expect(todos.startItem(id, other.id, send)).rejects.toBeInstanceOf(TodoError);
    await expect(todos.startItem(id, 'nope', send)).rejects.toMatchObject({ status: 404 });
  });

  it("the agent's todo_start on an item the developer marked in progress makes it the agent's start", async () => {
    const todos = service();
    const id = await session('upgrade');
    const { todo } = await todos.add(id, { title: 'One' }, 'developer');
    await todos.update(id, todo.id, { state: 'in_progress' });
    clock += 1_000;
    await todos.update(id, todo.id, { state: 'in_progress' }, 'agent');
    expect(await todos.get(id, todo.id)).toMatchObject({ startedBy: 'agent', startedAt: '2026-10-08T10:00:01.000Z' });
  });

  it('a take-over carries in progress and its start; an older source has none', async () => {
    const todos = service();
    const id = await session('target');
    await todos.import(id, [
      { title: 'Started', state: 'in_progress', addedBy: 'agent', createdAt: '2026-10-08T08:00:00.000Z', doneAt: null, startedAt: '2026-10-08T09:00:00.000Z', startedBy: 'start' },
      { text: 'From 1.11', state: 'open', addedBy: 'developer', createdAt: '2026-10-08T08:00:00.000Z', doneAt: null },
      { title: 'Weird', state: 'paused', addedBy: 'developer', createdAt: '2026-10-08T08:00:00.000Z', doneAt: null },
    ]);
    const list = await todos.list(id);
    expect(list.todos.map((t) => [t.title, t.state, t.startedAt, t.startedBy])).toEqual([
      ['Started', 'in_progress', '2026-10-08T09:00:00.000Z', 'start'],
      ['From 1.11', 'open', null, null],
      ['Weird', 'open', null, null],
    ]);
  });
});

describe('the finish reminder (D75)', () => {
  /** A minimal `sessionUpdated` payload: the reminder reads its id, status and closed time. */
  function update(bus: HubBus, id: string, status: Session['status']): void {
    bus.publish('sessionUpdated', { id, status, closedAt: null } as unknown as Session);
  }

  async function world(options: { enabled?: boolean; deliver?: (sessionId: string, text: string) => Promise<boolean> } = {}) {
    const bus = new HubBus();
    const todos = new TodoService({ store, bus, now: () => clock });
    const delivered: Array<[string, string]> = [];
    const reminder = new TodoReminder({
      bus,
      todos,
      now: () => clock,
      enabled: async () => options.enabled ?? true,
      deliver:
        options.deliver ??
        (async (sessionId, text) => {
          delivered.push([sessionId, text]);
          return true;
        }),
    });
    reminder.start();
    return { bus, todos, reminder, delivered };
  }

  it('a turn that ends with a started item untouched sends one reminder for it, once per start; not for a done, open or hand-marked item', async () => {
    const { bus, todos, reminder, delivered } = await world();
    const id = await session('remind');
    const started = (await todos.add(id, { title: 'Started' }, 'developer')).todo;
    const byAgent = (await todos.add(id, { title: 'By the agent' }, 'agent')).todo;
    const byHand = (await todos.add(id, { title: 'By hand' }, 'developer')).todo;
    const finished = (await todos.add(id, { title: 'Finished' }, 'developer')).todo;
    await todos.add(id, { title: 'Open' }, 'developer');
    await todos.startItem(id, started.id, async () => undefined);
    await todos.startItem(id, finished.id, async () => undefined);
    await todos.update(id, byHand.id, { state: 'in_progress' });
    update(bus, id, 'idle');
    clock += 1_000;
    update(bus, id, 'run');
    clock += 1_000;
    // The agent starts one itself (not a "touch") and finishes another during the turn.
    await todos.update(id, byAgent.id, { state: 'in_progress' }, 'agent');
    await todos.update(id, finished.id, { state: 'done' }, 'agent');
    update(bus, id, 'done');
    await reminder.idle();
    expect(delivered).toEqual([
      [id, todoReminderMessage({ id: started.id, title: 'Started' })],
      [id, todoReminderMessage({ id: byAgent.id, title: 'By the agent' })],
    ]);
    expect((await store.todos.get(started.id))?.remindedAt).toBe('2026-10-08T10:00:02.000Z');
    // The next turn (the reminder's own) ends with them still in progress: no second reminder.
    update(bus, id, 'run');
    update(bus, id, 'idle');
    await reminder.idle();
    expect(delivered).toHaveLength(2);
    // ▶ Start again = a new start: one more reminder at the next turn's end.
    await todos.startItem(id, started.id, async () => undefined);
    update(bus, id, 'run');
    update(bus, id, 'done');
    await reminder.idle();
    expect(delivered.map(([, text]) => text)).toEqual([
      todoReminderMessage({ id: started.id, title: 'Started' }),
      todoReminderMessage({ id: byAgent.id, title: 'By the agent' }),
      todoReminderMessage({ id: started.id, title: 'Started' }),
    ]);
    await reminder.stop();
  });

  it('an item the agent changed during the turn gets none; a waiting-for-you pause is the same turn; another machine, a closed session or the setting off: none', async () => {
    const off = await world({ enabled: false });
    const id = await session('quiet');
    const a = (await off.todos.add(id, { title: 'A' }, 'developer')).todo;
    await off.todos.startItem(id, a.id, async () => undefined);
    update(off.bus, id, 'run');
    update(off.bus, id, 'idle');
    await off.reminder.idle();
    expect(off.delivered).toEqual([]);
    await off.reminder.stop();

    const on = await world();
    const b = (await on.todos.add(id, { title: 'B' }, 'developer')).todo;
    await on.todos.startItem(id, b.id, async () => undefined);
    update(on.bus, id, 'run');
    clock += 1_000;
    update(on.bus, id, 'need');
    // The agent updates B's plan (what is left) while the turn waits for the developer, then the turn goes on and ends.
    await on.todos.update(id, b.id, { plan: 'Left: the docs' }, 'agent');
    update(on.bus, id, 'run');
    update(on.bus, id, 'idle');
    await on.reminder.idle();
    // A was never reminded (the setting was off then); B was touched in the turn.
    expect(on.delivered.map(([, text]) => text)).toEqual([todoReminderMessage({ id: a.id, title: 'A' })]);
    // A paired machine's session and a closed one are not reminded here.
    on.bus.publish('sessionUpdated', { id: `r~abcdefghijkl~${id}`, status: 'run', closedAt: null } as unknown as Session);
    on.bus.publish('sessionUpdated', { id: `r~abcdefghijkl~${id}`, status: 'idle', closedAt: null } as unknown as Session);
    update(on.bus, id, 'run');
    on.bus.publish('sessionUpdated', { id, status: 'done', closedAt: '2026-10-08T10:05:00.000Z' } as unknown as Session);
    await on.reminder.idle();
    expect(on.delivered).toHaveLength(1);
    await on.reminder.stop();
  });

  it('not delivered (a hooked session without a waiter): not recorded, so a later turn end tries again', async () => {
    let waiter = false;
    const delivered: string[] = [];
    const { bus, todos, reminder } = await world({
      deliver: async (_sessionId, text) => {
        if (!waiter) return false;
        delivered.push(text);
        return true;
      },
    });
    const id = await session('hooked', { hooked: true });
    const c = (await todos.add(id, { title: 'C' }, 'developer')).todo;
    await todos.startItem(id, c.id, async () => undefined);
    update(bus, id, 'run');
    update(bus, id, 'idle');
    await reminder.idle();
    expect(delivered).toEqual([]);
    expect((await store.todos.get(c.id))?.remindedAt).toBeNull();
    waiter = true;
    update(bus, id, 'run');
    update(bus, id, 'idle');
    await reminder.idle();
    expect(delivered).toEqual([todoReminderMessage({ id: c.id, title: 'C' })]);
    await reminder.stop();
  });
});

describe('the routes (D75)', () => {
  const PORT = 4877; // inject() opens no socket; the port feeds the Host check only
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
    return app.inject({
      method,
      url,
      headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  }

  function agent(sessionId: string, method: InjectOptions['method'], url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { host: HOST, 'x-switchboard-session': sessionId, authorization: `Bearer ${agentTokenFor(token, sessionId)}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  }

  it('▶ Start on a hooked session: the message waits in its mailbox, the item is in progress; a closed session refuses and the item stays open', async () => {
    const id = await session('hooked-start', { hooked: true });
    const added = (await ui('POST', `/api/sessions/${id}/todos`, { title: 'Fix the flake', description: 'Retries hide a race.' })).json() as SessionTodoList;
    const todoId = added.todos[0]!.id;
    const started = await ui('POST', `/api/sessions/${id}/todos/${todoId}/start`);
    expect(started.statusCode, started.body).toBe(200);
    expect((started.json() as SessionTodoList)).toMatchObject({ openCount: 1, inProgressCount: 1, todos: [{ id: todoId, state: 'in_progress', startedBy: 'start' }] });
    const pending = await store.pendingMessages.pending(id);
    expect(pending.map((message) => message.text)).toEqual([todoStartMessage({ id: todoId, title: 'Fix the flake', description: 'Retries hide a race.', plan: 'No plan' })]);
    // The sidebar's count includes it.
    const sessions = (await ui('GET', '/api/sessions')).json() as Session[];
    expect(sessions.find((s) => s.id === id)?.openTodoCount).toBe(1);

    const closed = await session('closed-start');
    const other = ((await ui('POST', `/api/sessions/${closed}/todos`, { title: 'Never' })).json() as SessionTodoList).todos[0]!.id;
    await store.sessions.update(closed, { closedAt: '2026-10-08T09:00:00.000Z' });
    const refused = await ui('POST', `/api/sessions/${closed}/todos/${other}/start`);
    expect(refused.statusCode).toBe(409);
    expect(((await ui('GET', `/api/sessions/${closed}/todos`)).json() as SessionTodoList).todos[0]).toMatchObject({ state: 'open', startedAt: null });
    expect((await ui('POST', `/api/sessions/${id}/todos/nope/start`)).statusCode).toBe(404);
  });

  it('the UI marks in progress / not started by hand; the agent route starts with todo_start (state in_progress)', async () => {
    const id = await session('by-hand');
    const todoId = ((await ui('POST', `/api/sessions/${id}/todos`, { title: 'One' })).json() as SessionTodoList).todos[0]!.id;
    expect(((await ui('PUT', `/api/sessions/${id}/todos/${todoId}`, { state: 'in_progress' })).json() as SessionTodoList).todos[0]).toMatchObject({ state: 'in_progress', startedBy: 'developer' });
    expect(((await ui('PUT', `/api/sessions/${id}/todos/${todoId}`, { state: 'open' })).json() as SessionTodoList).todos[0]).toMatchObject({ state: 'open', startedBy: null });
    const answer = await agent(id, 'PUT', `/agent/v1/todos/${todoId}`, { state: 'in_progress' });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({ todo: { state: 'in_progress', startedBy: 'agent' } });
    expect((await agent(id, 'GET', '/agent/v1/todos')).json()).toMatchObject({ inProgressCount: 1 });
  });
});
