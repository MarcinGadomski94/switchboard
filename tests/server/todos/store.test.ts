import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubMessage } from '../../../src/server/hub/bus.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { loadMigrations } from '../../../src/server/db/migrate.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { StoreError } from '../../../src/server/db/table.ts';
import { TodoError, TodoService } from '../../../src/server/todos/service.ts';
import { TODO_DONE_TTL_MS, TODO_MAX_PER_SESSION, moveTodo, todoListText } from '../../../src/core/todos.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D68 oracle: migration 0026 (`session_todos`), the repository, and the
 * service's rules: validation, order, scoping, the hour after done (fake clock),
 * and the events it publishes.
 */

let tmp: string;
let store: Store;
let clock: number;
const now = (): number => clock;

beforeEach(async () => {
  tmp = await makeTempDir('todos-store');
  clock = Date.parse('2026-10-04T10:00:00.000Z');
  store = await openTempStore(tmp, { now: () => new Date(clock) });
});

afterEach(async () => {
  vi.useRealTimers();
  await store.close();
  await removeTempDir(tmp);
});

async function session(name: string): Promise<string> {
  return (await store.sessions.create({ name, claudeSessionId: randomUUID() })).id;
}

describe('migration 0026 (D68)', () => {
  it('is the newest shipped migration and creates session_todos with its checks and indexes', async () => {
    const shipped = await loadMigrations();
    expect(shipped.at(-1)).toMatchObject({ version: 26, name: 'session_todos' });
    expect(store.migrations.version).toBe(26);
    const columns = store.db.prepare('PRAGMA table_info(session_todos)').all().map((row) => String(row['name']));
    expect(columns).toEqual(['id', 'session_id', 'text', 'state', 'added_by', 'position', 'created_at', 'updated_at', 'done_at']);
    const indexes = store.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session_todos' AND sql IS NOT NULL ORDER BY name`).all();
    expect(indexes.map((row) => row['name'])).toEqual(['session_todos_done', 'session_todos_session']);
    const id = await session('checks');
    const insert = (state: string, doneAt: string | null, by = 'developer', text = 'x') =>
      store.db.prepare('INSERT INTO session_todos (id, session_id, text, state, added_by, position, created_at, updated_at, done_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)').run(randomUUID(), id, text, state, by, 'a', 'a', doneAt);
    expect(() => insert('open', '2026-10-04T10:00:00.000Z')).toThrow();
    expect(() => insert('done', null)).toThrow();
    expect(() => insert('gone', null)).toThrow();
    expect(() => insert('open', null, 'someone')).toThrow();
    expect(() => insert('open', null, 'developer', '')).toThrow();
    expect(() => insert('open', null)).not.toThrow();
  });

  it("deleting a session deletes its items (and only its)", async () => {
    const a = await session('a');
    const b = await session('b');
    await store.todos.add(a, 'one', 'developer');
    await store.todos.add(b, 'two', 'agent');
    await store.sessions.delete(a);
    expect(await store.todos.list(a)).toEqual([]);
    expect((await store.todos.list(b)).map((t) => t.text)).toEqual(['two']);
  });
});

describe('TodoRepository', () => {
  it('adds at the end, ticks / unticks with done_at, reorders exactly the session ids, clears done', async () => {
    const id = await session('repo');
    const one = await store.todos.add(id, 'one', 'developer');
    const two = await store.todos.add(id, 'two', 'agent');
    const three = await store.todos.add(id, 'three', 'developer');
    expect((await store.todos.list(id)).map((t) => [t.text, t.position, t.addedBy])).toEqual([
      ['one', 0, 'developer'],
      ['two', 1, 'agent'],
      ['three', 2, 'developer'],
    ]);
    expect(one.id).toMatch(/^[0-9a-f]{12}$/);
    clock += 1_000;
    expect(await store.todos.setState(two.id, 'done')).toMatchObject({ state: 'done', doneAt: '2026-10-04T10:00:01.000Z' });
    expect(await store.todos.setState(two.id, 'open')).toMatchObject({ state: 'open', doneAt: null });
    await expect(store.todos.reorder(id, [three.id, one.id])).rejects.toBeInstanceOf(StoreError);
    await expect(store.todos.reorder(id, [three.id, one.id, one.id])).rejects.toBeInstanceOf(StoreError);
    await expect(store.todos.reorder(id, [three.id, one.id, 'nope'])).rejects.toBeInstanceOf(StoreError);
    expect((await store.todos.reorder(id, [three.id, one.id, two.id])).map((t) => t.text)).toEqual(['three', 'one', 'two']);
    await store.todos.setState(one.id, 'done');
    expect(await store.todos.openCounts()).toEqual(new Map([[id, 2]]));
    expect(await store.todos.clearDone(id)).toBe(1);
    expect((await store.todos.list(id)).map((t) => t.text)).toEqual(['three', 'two']);
  });
});

describe('TodoService (D68)', () => {
  function service(bus = new HubBus(), announced: string[] = []) {
    return new TodoService({ store, bus, now, announce: async (sessionId) => void announced.push(sessionId), onError: (error) => { throw error; } });
  }

  it('validates text, keeps items in their session, and publishes todosChanged + the session on every change', async () => {
    const bus = new HubBus();
    const published: HubMessage[] = [];
    bus.subscribe((message) => published.push(message));
    const announced: string[] = [];
    const todos = service(bus, announced);
    const a = await session('a');
    const b = await session('b');
    await expect(todos.add(a, '   ', 'developer')).rejects.toMatchObject({ status: 422 });
    await expect(todos.add(a, 'x'.repeat(1_001), 'developer')).rejects.toMatchObject({ status: 422 });
    await expect(todos.add('no-such', 'x', 'developer')).rejects.toMatchObject({ status: 404 });
    const { todo, list } = await todos.add(a, '  Fix the login test  ', 'agent');
    expect(todo).toMatchObject({ text: 'Fix the login test', addedBy: 'agent', state: 'open', doneAt: null, removeAt: null });
    expect(list).toMatchObject({ sessionId: a, openCount: 1, doneCount: 0 });
    // Another session's item is not found through this session.
    await expect(todos.update(b, todo.id, { state: 'done' })).rejects.toBeInstanceOf(TodoError);
    await expect(todos.remove(b, todo.id)).rejects.toMatchObject({ status: 404 });
    await expect(todos.update(a, todo.id, {})).rejects.toMatchObject({ status: 422 });
    await expect(todos.update(a, todo.id, { state: 'later' })).rejects.toMatchObject({ status: 422 });
    const done = await todos.update(a, todo.id, { text: 'Fix the login tests', state: 'done' });
    expect(done.todo).toMatchObject({ text: 'Fix the login tests', state: 'done', doneAt: '2026-10-04T10:00:00.000Z', removeAt: '2026-10-04T11:00:00.000Z' });
    expect(published.filter((m) => m.name === 'todosChanged').map((m) => m.payload)).toEqual([
      { sessionId: a, openCount: 1, doneCount: 0 },
      { sessionId: a, openCount: 0, doneCount: 1 },
    ]);
    expect(announced).toEqual([a, a]);
    expect(todoListText(done.list)).toContain('Done (1');
  });

  it('caps a session at TODO_MAX_PER_SESSION items (409)', async () => {
    const todos = service();
    const a = await session('cap');
    for (let i = 0; i < TODO_MAX_PER_SESSION; i++) await store.todos.add(a, `item ${i}`, 'agent');
    await expect(todos.add(a, 'one more', 'agent')).rejects.toMatchObject({ status: 409, code: 'too-many' });
  });

  it('removes a done item one hour after done (sweep with a fake clock), keeps a reopened one, and survives a restart', async () => {
    const bus = new HubBus();
    const published: HubMessage[] = [];
    bus.subscribe((message) => published.push(message));
    const todos = service(bus);
    const a = await session('ttl');
    const keep = (await todos.add(a, 'keep open', 'developer')).todo;
    const first = (await todos.add(a, 'done first', 'developer')).todo;
    const reopened = (await todos.add(a, 'reopened', 'developer')).todo;
    await todos.update(a, first.id, { state: 'done' });
    clock += 20 * 60_000;
    await todos.update(a, reopened.id, { state: 'done' });
    clock += 10 * 60_000;
    await todos.update(a, reopened.id, { state: 'open' }); // reopening cancels its removal
    clock += 29 * 60_000; // 59 minutes after `first` was done
    await todos.sweep();
    expect((await store.todos.list(a)).map((t) => t.text)).toEqual(['keep open', 'done first', 'reopened']);
    clock += 60_000; // the hour
    published.length = 0;
    await todos.sweep();
    expect((await store.todos.list(a)).map((t) => t.text)).toEqual(['keep open', 'reopened']);
    expect(published.map((m) => m.name)).toEqual(['todosChanged']);
    // A restart: a new service on the same store; an item whose hour passed while it was down goes at start.
    await todos.update(a, keep.id, { state: 'done' });
    todos.close();
    clock += TODO_DONE_TTL_MS + 1;
    const restarted = service();
    await restarted.start();
    expect((await store.todos.list(a)).map((t) => t.text)).toEqual(['reopened']);
    restarted.close();
  });

  it('arms a timer for the earliest done item: it fires at the hour without a sweep call', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const todos = service();
    await todos.start();
    const a = await session('timer');
    const item = (await todos.add(a, 'tick me', 'developer')).todo;
    await todos.update(a, item.id, { state: 'done' });
    clock += TODO_DONE_TTL_MS - 1_000;
    await vi.advanceTimersByTimeAsync(TODO_DONE_TTL_MS - 1_000);
    expect(await store.todos.list(a)).toHaveLength(1);
    clock += 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(async () => expect(await store.todos.list(a)).toHaveLength(0));
    todos.close();
  });

  it('reorders (422 for a partial list), clears done, imports a taken-over list in order', async () => {
    const todos = service();
    const a = await session('order');
    const one = (await todos.add(a, 'one', 'developer')).todo;
    const two = (await todos.add(a, 'two', 'developer')).todo;
    await expect(todos.reorder(a, [two.id])).rejects.toMatchObject({ status: 422 });
    await expect(todos.reorder(a, 'nope')).rejects.toMatchObject({ status: 422 });
    expect((await todos.reorder(a, [two.id, one.id])).todos.map((t) => t.text)).toEqual(['two', 'one']);
    await todos.update(a, one.id, { state: 'done' });
    expect(await todos.clearDone(a)).toMatchObject({ openCount: 1, doneCount: 0 });
    const b = await session('imported');
    expect(
      await todos.import(b, [
        { text: 'carried', state: 'open', addedBy: 'agent', createdAt: '2026-10-01T00:00:00.000Z', doneAt: null },
        { text: 'finished', state: 'done', addedBy: 'developer', createdAt: '2026-10-01T00:00:00.000Z', doneAt: '2026-10-04T09:30:00.000Z' },
        { text: '', state: 'open' },
        'junk',
      ]),
    ).toBe(2);
    expect((await todos.list(b)).todos.map((t) => [t.text, t.state, t.addedBy, t.doneAt])).toEqual([
      ['carried', 'open', 'agent', null],
      ['finished', 'done', 'developer', '2026-10-04T09:30:00.000Z'],
    ]);
  });

  it('groups: open sessions with items, newest activity first; closed sessions are left out', async () => {
    const todos = service();
    const a = await session('group-a');
    const b = await session('group-b');
    const closed = await session('group-closed');
    await todos.add(a, 'a1', 'developer');
    await todos.add(b, 'b1', 'agent');
    await todos.add(closed, 'c1', 'agent');
    await store.sessions.update(b, { lastActivityAt: '2026-10-04T12:00:00.000Z' });
    await store.sessions.update(closed, { closedAt: '2026-10-04T12:00:00.000Z' });
    const groups = await todos.groups();
    expect(groups.map((g) => [g.title, g.todos.map((t) => t.text), g.machine])).toEqual([
      ['group-b', ['b1'], null],
      ['group-a', ['a1'], null],
    ]);
  });
});

describe('moveTodo', () => {
  it('swaps with the neighbour of the same state only', () => {
    const t = (id: string, position: number, state: 'open' | 'done' = 'open') => ({ id, sessionId: 's', text: id, state, addedBy: 'developer' as const, position, createdAt: '', updatedAt: '', doneAt: null, removeAt: null });
    const all = [t('a', 0), t('x', 1, 'done'), t('b', 2), t('c', 3)];
    expect(moveTodo(all, 'b', -1)).toEqual(['b', 'x', 'a', 'c']);
    expect(moveTodo(all, 'a', -1)).toBeNull();
    expect(moveTodo(all, 'c', 1)).toBeNull();
    expect(moveTodo(all, 'x', 1)).toBeNull();
  });
});
