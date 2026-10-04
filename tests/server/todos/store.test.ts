import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubMessage } from '../../../src/server/hub/bus.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../../src/server/db/database.ts';
import { loadMigrations, migrate } from '../../../src/server/db/migrate.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { StoreError } from '../../../src/server/db/table.ts';
import type { TodoFields } from '../../../src/server/db/repos/todos.ts';
import { TodoError, TodoService } from '../../../src/server/todos/service.ts';
import {
  TODO_DESCRIPTION_MAX,
  TODO_DONE_TTL_MS,
  TODO_MAX_PER_SESSION,
  TODO_PLAN_MAX,
  TODO_TITLE_MAX,
  checkNewTodo,
  checkTodoNote,
  checkTodoPatch,
  checkTodoTitle,
  composerWithStart,
  legacyTodoFields,
  moveTodo,
  todoListText,
  todoRemovalLabel,
  todoStartMessage,
} from '../../../src/core/todos.ts';
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

/** An item's fields with only a title (D70: No plan, medium, no estimate). */
function f(title: string, priority: TodoFields['priority'] = 'medium', estimateMinutes: number | null = null): TodoFields {
  return { title, description: null, plan: 'No plan', priority, estimateMinutes };
}

async function session(name: string): Promise<string> {
  return (await store.sessions.create({ name, claudeSessionId: randomUUID() })).id;
}

/** A database migrated up to `version` (the shipped migrations), for the migration tests. */
async function databaseAt(version: number): Promise<DatabaseSync> {
  const db = await openDatabase(':memory:');
  migrate(db, (await loadMigrations()).filter((m) => m.version <= version));
  return db;
}

describe('migration 0026 (D68)', () => {
  it('creates session_todos with its checks and indexes', async () => {
    const shipped = await loadMigrations();
    expect(shipped.find((m) => m.version === 26)).toMatchObject({ name: 'session_todos' });
    const db = await databaseAt(26);
    const columns = db.prepare('PRAGMA table_info(session_todos)').all().map((row) => String(row['name']));
    expect(columns).toEqual(['id', 'session_id', 'text', 'state', 'added_by', 'position', 'created_at', 'updated_at', 'done_at']);
    const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session_todos' AND sql IS NOT NULL ORDER BY name`).all();
    expect(indexes.map((row) => row['name'])).toEqual(['session_todos_done', 'session_todos_session']);
    db.close();
    const id = await session('checks');
    // On the current schema (0027 renamed `text` to `title`; the checks came along).
    const insert = (state: string, doneAt: string | null, by = 'developer', text = 'x') =>
      store.db.prepare('INSERT INTO session_todos (id, session_id, title, state, added_by, position, created_at, updated_at, done_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)').run(randomUUID(), id, text, state, by, 'a', 'a', doneAt);
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
    await store.todos.add(a, f('one'), 'developer');
    await store.todos.add(b, f('two'), 'agent');
    await store.sessions.delete(a);
    expect(await store.todos.list(a)).toEqual([]);
    expect((await store.todos.list(b)).map((t) => t.title)).toEqual(['two']);
  });
});

describe('migration 0027 (D69)', () => {
  it('text becomes title, description and plan are added; a long or multi-line text keeps all of it as the description', async () => {
    const shipped = (await loadMigrations()).filter((m) => m.version <= 27);
    expect(shipped.at(-1)).toMatchObject({ version: 27, name: 'todo_fields' });
    const db = await databaseAt(26);
    const ts = '2026-10-04T10:00:00.000Z';
    db.prepare('INSERT INTO sessions (id, name, claude_session_id, cwd, root, root_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('s', 'old', 'c', '/tmp/x', '/tmp/x', 'repo', ts, ts);
    const insert = db.prepare('INSERT INTO session_todos (id, session_id, text, state, added_by, position, created_at, updated_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run('short', 's', 'Write the docs', 'open', 'developer', 0, ts, ts, null);
    insert.run('lines', 's', 'Fix the login test\r\nRetries hide a race.', 'done', 'agent', 1, ts, ts, ts);
    insert.run('long', 's', 'x'.repeat(130), 'open', 'agent', 2, ts, ts, null);
    insert.run('exact', 's', 'y'.repeat(120), 'open', 'agent', 3, ts, ts, null);
    expect(migrate(db, shipped).applied).toEqual([27]);
    const columns = db.prepare('PRAGMA table_info(session_todos)').all().map((row) => String(row['name']));
    expect(columns).toEqual(['id', 'session_id', 'title', 'state', 'added_by', 'position', 'created_at', 'updated_at', 'done_at', 'description', 'plan']);
    expect(db.prepare('SELECT id, title, description, plan, state, done_at FROM session_todos ORDER BY position').all().map((row) => ({ ...row }))).toEqual([
      { id: 'short', title: 'Write the docs', description: null, plan: null, state: 'open', done_at: null },
      { id: 'lines', title: 'Fix the login test', description: 'Fix the login test\r\nRetries hide a race.', plan: null, state: 'done', done_at: ts },
      { id: 'long', title: `${'x'.repeat(119)}…`, description: 'x'.repeat(130), plan: null, state: 'open', done_at: null },
      { id: 'exact', title: 'y'.repeat(120), description: null, plan: null, state: 'open', done_at: null },
    ]);
    // The same split as legacyTodoFields (a take-over from 1.7.0).
    expect(legacyTodoFields('Fix the login test\r\nRetries hide a race.')).toEqual({ title: 'Fix the login test', description: 'Fix the login test\r\nRetries hide a race.' });
    expect(legacyTodoFields('x'.repeat(130))).toEqual({ title: `${'x'.repeat(119)}…`, description: 'x'.repeat(130) });
    expect(legacyTodoFields('Write the docs')).toEqual({ title: 'Write the docs', description: null });
    expect(legacyTodoFields('  ')).toBeNull();
    // The title's non-empty check came along with the rename.
    expect(() => db.prepare(`UPDATE session_todos SET title = '' WHERE id = 'short'`).run()).toThrow();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });
});

describe('the D69 field rules', () => {
  it('title: trimmed, 1–120, one line; description ≤ 4,000 and plan ≤ 8,000, blank = none; text is the alias of title', () => {
    expect(checkTodoTitle('  Fix it ')).toEqual({ ok: true, value: 'Fix it' });
    expect(checkTodoTitle('x'.repeat(TODO_TITLE_MAX))).toMatchObject({ ok: true });
    expect(checkTodoTitle('x'.repeat(TODO_TITLE_MAX + 1))).toMatchObject({ ok: false, message: expect.stringContaining('120') });
    expect(checkTodoTitle('a\nb')).toMatchObject({ ok: false, message: expect.stringContaining('one line') });
    expect(checkTodoTitle('')).toMatchObject({ ok: false });
    expect(checkTodoTitle(3)).toMatchObject({ ok: false });
    expect(checkTodoNote(undefined, 'plan')).toEqual({ ok: true, value: null });
    expect(checkTodoNote('   ', 'plan')).toEqual({ ok: true, value: null });
    expect(checkTodoNote(' p ', 'plan')).toEqual({ ok: true, value: 'p' });
    expect(checkTodoNote('d'.repeat(TODO_DESCRIPTION_MAX), 'description')).toMatchObject({ ok: true });
    expect(checkTodoNote('d'.repeat(TODO_DESCRIPTION_MAX + 1), 'description')).toMatchObject({ ok: false });
    expect(checkTodoNote('p'.repeat(TODO_PLAN_MAX), 'plan')).toMatchObject({ ok: true });
    expect(checkTodoNote('p'.repeat(TODO_PLAN_MAX + 1), 'plan')).toMatchObject({ ok: false });
    expect([TODO_TITLE_MAX, TODO_DESCRIPTION_MAX, TODO_PLAN_MAX]).toEqual([120, 4_000, 8_000]);
    // D70: an absent plan is "No plan", the priority medium, no estimate (an older caller).
    expect(checkNewTodo({ text: 'Old' })).toEqual({ ok: true, value: { title: 'Old', description: null, plan: 'No plan', priority: 'medium', estimateMinutes: null } });
    expect(checkNewTodo({ title: 'New', text: 'Old', plan: 'Steps' })).toEqual({ ok: true, value: { title: 'New', description: null, plan: 'Steps', priority: 'medium', estimateMinutes: null } });
    expect(checkTodoPatch({ state: 'done' })).toEqual({ ok: true, value: {} });
    expect(checkTodoPatch({ description: '', text: 'Renamed' })).toEqual({ ok: true, value: { title: 'Renamed', description: null } });
  });

  it('▶ Start: the message is the id and title, then the plan (else the description); a draft is kept, the message added after it', () => {
    const item: { id: string; title: string; description: string | null; plan: string | null } = { id: 'a1b2c3d4e5f6', title: 'Fix the login test flake', description: 'Retries hide a race.', plan: '1. Find the race' };
    expect(todoStartMessage(item)).toBe('Work on todo [a1b2c3d4e5f6]: Fix the login test flake\n\n1. Find the race');
    expect(todoStartMessage({ ...item, plan: null })).toBe('Work on todo [a1b2c3d4e5f6]: Fix the login test flake\n\nRetries hide a race.');
    expect(todoStartMessage({ ...item, plan: null, description: null })).toBe('Work on todo [a1b2c3d4e5f6]: Fix the login test flake');
    // D70: "No plan" (with or without a reason) is not a plan: the description goes instead.
    expect(todoStartMessage({ ...item, plan: 'No plan' })).toBe('Work on todo [a1b2c3d4e5f6]: Fix the login test flake\n\nRetries hide a race.');
    expect(todoStartMessage({ ...item, plan: 'No plan: a one-line fix', description: null })).toBe('Work on todo [a1b2c3d4e5f6]: Fix the login test flake');
    expect(composerWithStart('', 'M')).toBe('M');
    expect(composerWithStart('  \n', 'M')).toBe('M');
    expect(composerWithStart('My draft\n', 'M')).toBe('My draft\n\nM');
  });

  it("a done card's countdown: minutes rounded up, 'removed soon' once due", () => {
    const at = Date.parse('2026-10-04T11:00:00.000Z');
    expect(todoRemovalLabel('2026-10-04T11:00:00.000Z', at - 42 * 60_000 + 10_000)).toBe('removed in 42m');
    expect(todoRemovalLabel('2026-10-04T11:00:00.000Z', at - 60 * 60_000)).toBe('removed in 60m');
    expect(todoRemovalLabel('2026-10-04T11:00:00.000Z', at)).toBe('removed soon');
    expect(todoRemovalLabel(null, at)).toBe('');
  });
});

describe('TodoRepository', () => {
  it('adds at the end, ticks / unticks with done_at, reorders exactly the session ids, clears done', async () => {
    const id = await session('repo');
    const one = await store.todos.add(id, f('one'), 'developer');
    const two = await store.todos.add(id, f('two'), 'agent');
    const three = await store.todos.add(id, f('three'), 'developer');
    expect((await store.todos.list(id)).map((t) => [t.title, t.position, t.addedBy])).toEqual([
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
    expect((await store.todos.reorder(id, [three.id, one.id, two.id])).map((t) => t.title)).toEqual(['three', 'one', 'two']);
    await store.todos.setState(one.id, 'done');
    expect(await store.todos.openCounts()).toEqual(new Map([[id, 2]]));
    expect(await store.todos.clearDone(id)).toBe(1);
    expect((await store.todos.list(id)).map((t) => t.title)).toEqual(['three', 'two']);
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
    await expect(todos.add(a, { title: '   ' }, 'developer')).rejects.toMatchObject({ status: 422 });
    await expect(todos.add(a, { title: 'x'.repeat(121) }, 'developer')).rejects.toMatchObject({ status: 422 });
    await expect(todos.add('no-such', { title: 'x' }, 'developer')).rejects.toMatchObject({ status: 404 });
    const { todo, list } = await todos.add(a, { title: '  Fix the login test  ' }, 'agent');
    expect(todo).toMatchObject({ title: 'Fix the login test', text: 'Fix the login test', description: null, plan: 'No plan', priority: 'medium', estimateMinutes: null, addedBy: 'agent', state: 'open', doneAt: null, removeAt: null });
    expect(list).toMatchObject({ sessionId: a, openCount: 1, doneCount: 0 });
    // Another session's item is not found through this session.
    await expect(todos.update(b, todo.id, { state: 'done' })).rejects.toBeInstanceOf(TodoError);
    await expect(todos.remove(b, todo.id)).rejects.toMatchObject({ status: 404 });
    await expect(todos.update(a, todo.id, {})).rejects.toMatchObject({ status: 422 });
    await expect(todos.update(a, todo.id, { state: 'later' })).rejects.toMatchObject({ status: 422 });
    const done = await todos.update(a, todo.id, { text: 'Fix the login tests', state: 'done' });
    expect(done.todo).toMatchObject({ title: 'Fix the login tests', text: 'Fix the login tests', state: 'done', doneAt: '2026-10-04T10:00:00.000Z', removeAt: '2026-10-04T11:00:00.000Z' });
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
    for (let i = 0; i < TODO_MAX_PER_SESSION; i++) await store.todos.add(a, f(`item ${i}`), 'agent');
    await expect(todos.add(a, { title: 'one more' }, 'agent')).rejects.toMatchObject({ status: 409, code: 'too-many' });
  });

  it('removes a done item one hour after done (sweep with a fake clock), keeps a reopened one, and survives a restart', async () => {
    const bus = new HubBus();
    const published: HubMessage[] = [];
    bus.subscribe((message) => published.push(message));
    const todos = service(bus);
    const a = await session('ttl');
    const keep = (await todos.add(a, { title: 'keep open' }, 'developer')).todo;
    const first = (await todos.add(a, { title: 'done first' }, 'developer')).todo;
    const reopened = (await todos.add(a, { title: 'reopened' }, 'developer')).todo;
    await todos.update(a, first.id, { state: 'done' });
    clock += 20 * 60_000;
    await todos.update(a, reopened.id, { state: 'done' });
    clock += 10 * 60_000;
    await todos.update(a, reopened.id, { state: 'open' }); // reopening cancels its removal
    clock += 29 * 60_000; // 59 minutes after `first` was done
    await todos.sweep();
    expect((await store.todos.list(a)).map((t) => t.title)).toEqual(['keep open', 'done first', 'reopened']);
    clock += 60_000; // the hour
    published.length = 0;
    await todos.sweep();
    expect((await store.todos.list(a)).map((t) => t.title)).toEqual(['keep open', 'reopened']);
    expect(published.map((m) => m.name)).toEqual(['todosChanged']);
    // A restart: a new service on the same store; an item whose hour passed while it was down goes at start.
    await todos.update(a, keep.id, { state: 'done' });
    todos.close();
    clock += TODO_DONE_TTL_MS + 1;
    const restarted = service();
    await restarted.start();
    expect((await store.todos.list(a)).map((t) => t.title)).toEqual(['reopened']);
    restarted.close();
  });

  it('arms a timer for the earliest done item: it fires at the hour without a sweep call', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const todos = service();
    await todos.start();
    const a = await session('timer');
    const item = (await todos.add(a, { title: 'tick me' }, 'developer')).todo;
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
    const one = (await todos.add(a, { title: 'one' }, 'developer')).todo;
    const two = (await todos.add(a, { title: 'two' }, 'developer')).todo;
    await expect(todos.reorder(a, [two.id])).rejects.toMatchObject({ status: 422 });
    await expect(todos.reorder(a, 'nope')).rejects.toMatchObject({ status: 422 });
    expect((await todos.reorder(a, [two.id, one.id])).todos.map((t) => t.title)).toEqual(['two', 'one']);
    await todos.update(a, one.id, { state: 'done' });
    expect(await todos.clearDone(a)).toMatchObject({ openCount: 1, doneCount: 0 });
    const b = await session('imported');
    expect(
      await todos.import(b, [
        { text: 'carried', title: 'carried', description: 'Why', plan: 'How', state: 'open', addedBy: 'agent', createdAt: '2026-10-01T00:00:00.000Z', doneAt: null },
        { text: 'finished', state: 'done', addedBy: 'developer', createdAt: '2026-10-01T00:00:00.000Z', doneAt: '2026-10-04T09:30:00.000Z' },
        { text: '', state: 'open' },
        'junk',
        // D69: a 1.7.0 source's long text is split like migration 0027.
        { text: `Line one\n${'z'.repeat(200)}`, state: 'open', addedBy: 'developer' },
      ]),
    ).toBe(3);
    // D70: an older source's items are medium, not estimated, and No plan.
    expect((await todos.list(b)).todos.map((t) => [t.title, t.description, t.plan, t.state, t.addedBy, t.doneAt, t.priority, t.estimateMinutes])).toEqual([
      ['carried', 'Why', 'How', 'open', 'agent', null, 'medium', null],
      ['finished', null, 'No plan', 'done', 'developer', '2026-10-04T09:30:00.000Z', 'medium', null],
      ['Line one', `Line one\n${'z'.repeat(200)}`, 'No plan', 'open', 'developer', null, 'medium', null],
    ]);
  });

  it('groups: open sessions with items, newest activity first; closed sessions are left out', async () => {
    const todos = service();
    const a = await session('group-a');
    const b = await session('group-b');
    const closed = await session('group-closed');
    await todos.add(a, { title: 'a1' }, 'developer');
    await todos.add(b, { title: 'b1' }, 'agent');
    await todos.add(closed, { title: 'c1' }, 'agent');
    await store.sessions.update(b, { lastActivityAt: '2026-10-04T12:00:00.000Z' });
    await store.sessions.update(closed, { closedAt: '2026-10-04T12:00:00.000Z' });
    const groups = await todos.groups();
    expect(groups.map((g) => [g.title, g.todos.map((t) => t.title), g.machine])).toEqual([
      ['group-b', ['b1'], null],
      ['group-a', ['a1'], null],
    ]);
  });
});

describe('moveTodo', () => {
  it('swaps with the neighbour of the same state only', () => {
    const t = (id: string, position: number, state: 'open' | 'done' = 'open') => ({ id, sessionId: 's', title: id, text: id, description: null, plan: 'No plan', priority: 'medium' as const, estimateMinutes: null, state, addedBy: 'developer' as const, position, createdAt: '', updatedAt: '', doneAt: null, removeAt: null });
    const all = [t('a', 0), t('x', 1, 'done'), t('b', 2), t('c', 3)];
    expect(moveTodo(all, 'b', -1)).toEqual(['b', 'x', 'a', 'c']);
    expect(moveTodo(all, 'a', -1)).toBeNull();
    expect(moveTodo(all, 'c', 1)).toBeNull();
    expect(moveTodo(all, 'x', 1)).toBeNull();
  });
});
