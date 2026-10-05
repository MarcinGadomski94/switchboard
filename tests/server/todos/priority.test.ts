import { describe, expect, it } from 'vitest';
import type { SessionTodo, SessionTodoList, TodoPriority } from '../../../src/core/api.ts';
import {
  TODO_ESTIMATE_MAX,
  TODO_PRIORITIES,
  TODO_PRIORITY_LABELS,
  checkNewTodo,
  checkTodoEstimate,
  checkTodoPatch,
  checkTodoPriority,
  formatTodoMinutes,
  moveTodo,
  parseTodoEstimate,
  splitTodos,
  todoDetailText,
  todoEstimateInput,
  todoEstimateLabel,
  todoEstimateTotal,
  todoHasPlan,
  todoLine,
  todoListText,
  todoMoveScope,
} from '../../../src/core/todos.ts';
import { openDatabase } from '../../../src/server/db/database.ts';
import { loadMigrations, migrate } from '../../../src/server/db/migrate.ts';

/**
 * D70 oracle (`docs/todos.md` → *Priority, estimate and the mandatory plan*):
 * migration 0028 on 0027 rows, the field rules, the order (priority, then the
 * manual order within a level), Move up / down within a level, the estimate's
 * labels and totals, and the agent tools' compact lines.
 */

/** An open item (D70 fields given). */
function t(id: string, position: number, priority: TodoPriority = 'medium', extra: Partial<SessionTodo> = {}): SessionTodo {
  return {
    id,
    sessionId: 's',
    title: id,
    text: id,
    description: null,
    plan: 'No plan',
    priority,
    estimateMinutes: null,
    state: 'open',
    addedBy: 'agent',
    position,
    createdAt: '',
    updatedAt: '',
    doneAt: null,
    removeAt: null,
    ...extra,
  };
}

describe('migration 0028 (D70)', () => {
  it('0028 adds priority (medium) and estimate (none) are added; empty plans become No plan; titles and descriptions stay', async () => {
    const shipped = await loadMigrations();
    // Later migrations (0029, D71) are their own tests' concern: up to 0028.
    expect(shipped.find((m) => m.version === 28)).toMatchObject({ name: 'todo_priority' });
    const db = await openDatabase(':memory:');
    migrate(db, shipped.filter((m) => m.version <= 27));
    const ts = '2026-10-04T10:00:00.000Z';
    db.prepare('INSERT INTO sessions (id, name, claude_session_id, cwd, root, root_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('s', 'old', 'c', '/tmp/x', '/tmp/x', 'repo', ts, ts);
    const insert = db.prepare('INSERT INTO session_todos (id, session_id, title, description, plan, state, added_by, position, created_at, updated_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    // As 0027 left them: a long text split into a cut title + the whole text as the description.
    const long = 'x'.repeat(300);
    insert.run('split', 's', `${'x'.repeat(119)}…`, long, null, 'open', 'developer', 0, ts, ts, null);
    insert.run('planned', 's', 'Has a plan', null, '1. Do it', 'open', 'agent', 1, ts, ts, null);
    insert.run('blank', 's', 'Blank plan', 'Why', ' \n\t', 'done', 'agent', 2, ts, ts, ts);
    insert.run('empty', 's', 'Empty plan', null, '', 'open', 'agent', 3, ts, ts, null);
    expect(migrate(db, shipped.filter((m) => m.version <= 28)).applied).toEqual([28]);
    const columns = db.prepare('PRAGMA table_info(session_todos)').all().map((row) => String(row['name']));
    expect(columns).toEqual(['id', 'session_id', 'title', 'state', 'added_by', 'position', 'created_at', 'updated_at', 'done_at', 'description', 'plan', 'priority', 'estimate_minutes']);
    expect(db.prepare('SELECT id, title, description, plan, priority, estimate_minutes, state, done_at FROM session_todos ORDER BY position').all().map((row) => ({ ...row }))).toEqual([
      { id: 'split', title: `${'x'.repeat(119)}…`, description: long, plan: 'No plan', priority: 'medium', estimate_minutes: null, state: 'open', done_at: null },
      { id: 'planned', title: 'Has a plan', description: null, plan: '1. Do it', priority: 'medium', estimate_minutes: null, state: 'open', done_at: null },
      { id: 'blank', title: 'Blank plan', description: 'Why', plan: 'No plan', priority: 'medium', estimate_minutes: null, state: 'done', done_at: ts },
      { id: 'empty', title: 'Empty plan', description: null, plan: 'No plan', priority: 'medium', estimate_minutes: null, state: 'open', done_at: null },
    ]);
    // The checks: the four priorities; whole minutes 1–10,080 or NULL.
    const set = (column: string, value: unknown) => () => db.prepare(`UPDATE session_todos SET ${column} = ? WHERE id = 'planned'`).run(value as string);
    expect(set('priority', 'asap')).toThrow();
    expect(set('priority', null)).toThrow();
    for (const level of TODO_PRIORITIES) expect(set('priority', level)).not.toThrow();
    expect(set('estimate_minutes', 0)).toThrow();
    expect(set('estimate_minutes', 10_081)).toThrow();
    expect(set('estimate_minutes', 'soon')).toThrow();
    expect(set('estimate_minutes', 10_080)).not.toThrow();
    expect(set('estimate_minutes', null)).not.toThrow();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });
});

describe('the D70 field rules', () => {
  it('priority: one of four, absent = medium; estimate: whole minutes 1–10,080, absent = none', () => {
    expect(TODO_PRIORITIES).toEqual(['urgent', 'high', 'medium', 'low']);
    expect(TODO_PRIORITY_LABELS).toEqual({ urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' });
    expect(checkTodoPriority(undefined)).toEqual({ ok: true, value: 'medium' });
    expect(checkTodoPriority('high')).toEqual({ ok: true, value: 'high' });
    for (const bad of ['High', 'asap', '', 3]) expect(checkTodoPriority(bad)).toMatchObject({ ok: false });
    expect(TODO_ESTIMATE_MAX).toBe(10_080);
    expect(checkTodoEstimate(undefined)).toEqual({ ok: true, value: null });
    expect(checkTodoEstimate(null)).toEqual({ ok: true, value: null });
    expect(checkTodoEstimate(1)).toEqual({ ok: true, value: 1 });
    expect(checkTodoEstimate(10_080)).toEqual({ ok: true, value: 10_080 });
    for (const bad of [0, -5, 10_081, 1.5, '45', Number.NaN]) expect(checkTodoEstimate(bad), String(bad)).toMatchObject({ ok: false, message: expect.stringContaining('AI agent') });
  });

  it('a new item: the plan defaults to No plan (blank too); a patch cannot empty the plan; priority / estimate are checked', () => {
    expect(checkNewTodo({ title: 'T', plan: '   ' })).toMatchObject({ ok: true, value: { plan: 'No plan' } });
    expect(checkNewTodo({ title: 'T', plan: null, priority: 'urgent', estimateMinutes: 45 })).toEqual({ ok: true, value: { title: 'T', description: null, plan: 'No plan', priority: 'urgent', estimateMinutes: 45 } });
    expect(checkNewTodo({ title: 'T', priority: 'soon' })).toMatchObject({ ok: false, message: expect.stringContaining('urgent, high, medium, low') });
    expect(checkNewTodo({ title: 'T', estimateMinutes: 0 })).toMatchObject({ ok: false });
    expect(checkTodoPatch({ plan: '' })).toMatchObject({ ok: false, message: expect.stringContaining('No plan: <one-line reason>') });
    expect(checkTodoPatch({ plan: null })).toMatchObject({ ok: false });
    expect(checkTodoPatch({ plan: ' Steps ' })).toEqual({ ok: true, value: { plan: 'Steps' } });
    expect(checkTodoPatch({ priority: 'low', estimateMinutes: null })).toEqual({ ok: true, value: { priority: 'low', estimateMinutes: null } });
    expect(checkTodoPatch({ priority: null })).toMatchObject({ ok: false });
    expect(checkTodoPatch({ estimateMinutes: 2.5 })).toMatchObject({ ok: false });
  });

  it('No plan (with or without a reason) is not a handover plan', () => {
    expect(todoHasPlan('1. Do it')).toBe(true);
    expect(todoHasPlan('No planning needed? Yes: 1. Do it')).toBe(true);
    for (const none of ['No plan', 'no plan', 'No plan: a one-line fix', '  No plan  ', '', null, undefined]) expect(todoHasPlan(none), String(none)).toBe(false);
  });
});

describe('estimates', () => {
  it('labels: ~45m, ~2h, ~1h 30m; the form reads 45, 45m, 2h, 1h 30m, 1.5h', () => {
    expect([5, 45, 60, 90, 120, 135, 10_080].map(formatTodoMinutes)).toEqual(['5m', '45m', '1h', '1h 30m', '2h', '2h 15m', '168h']);
    expect(todoEstimateLabel(45)).toBe('~45m');
    expect(todoEstimateLabel(120)).toBe('~2h');
    expect(todoEstimateLabel(90)).toBe('~1h 30m');
    expect(todoEstimateLabel(null)).toBe('');
    expect(todoEstimateInput(90)).toBe('1h 30m');
    expect(todoEstimateInput(null)).toBe('');
    const read = (text: string) => parseTodoEstimate(text);
    expect(read('')).toEqual({ ok: true, value: null });
    expect(read('  ')).toEqual({ ok: true, value: null });
    expect(read('45')).toEqual({ ok: true, value: 45 });
    expect(read('45m')).toEqual({ ok: true, value: 45 });
    expect(read('45 min')).toEqual({ ok: true, value: 45 });
    expect(read('2h')).toEqual({ ok: true, value: 120 });
    expect(read('1h 30m')).toEqual({ ok: true, value: 90 });
    expect(read('1H30M')).toEqual({ ok: true, value: 90 });
    expect(read('1.5h')).toEqual({ ok: true, value: 90 });
    for (const bad of ['soon', '0', '0m', 'h', '-5', '1h 30', '169h', '2d']) expect(read(bad), bad).toMatchObject({ ok: false });
    // Every label reads back to its minutes.
    for (const minutes of [1, 45, 60, 90, 135, 10_080]) expect(read(todoEstimateInput(minutes))).toEqual({ ok: true, value: minutes });
  });

  it("the header total: the open items' known estimates, + when some are unknown, nothing when none is known", () => {
    expect(todoEstimateTotal([t('a', 0, 'high', { estimateMinutes: 45 }), t('b', 1, 'low', { estimateMinutes: 90 })])).toBe('~2h 15m');
    expect(todoEstimateTotal([t('a', 0, 'high', { estimateMinutes: 45 }), t('b', 1, 'low', { estimateMinutes: 90 }), t('c', 2)])).toBe('~2h 15m+');
    // Done items do not count.
    expect(todoEstimateTotal([t('a', 0, 'high', { estimateMinutes: 45 }), t('d', 1, 'low', { estimateMinutes: 600, state: 'done' })])).toBe('~45m');
    expect(todoEstimateTotal([t('a', 0), t('b', 1)])).toBe('');
    expect(todoEstimateTotal([])).toBe('');
  });
});

describe('order and moves (D70)', () => {
  const all = [
    t('low1', 0, 'low'),
    t('med1', 1, 'medium'),
    t('urg1', 2, 'urgent'),
    t('done1', 3, 'urgent', { state: 'done', doneAt: 'x' }),
    t('med2', 4, 'medium'),
    t('high1', 5, 'high'),
    t('urg2', 6, 'urgent'),
    t('low2', 7, 'low'),
  ];

  it('open items sort by priority, urgent first, then their manual order; done items keep the list order', () => {
    const { open, done } = splitTodos(all);
    expect(open.map((x) => x.id)).toEqual(['urg1', 'urg2', 'high1', 'med1', 'med2', 'low1', 'low2']);
    expect(done.map((x) => x.id)).toEqual(['done1']);
    // An unknown priority (a row written outside the service) ranks as medium.
    expect(splitTodos([t('odd', 0, 'whatever' as TodoPriority), t('m', 1, 'medium'), t('h', 2, 'high')]).open.map((x) => x.id)).toEqual(['h', 'odd', 'm']);
  });

  it('Move up / down swaps within the priority level only: disabled at the level edges', () => {
    expect(todoMoveScope(all, all[1]!).map((x) => x.id)).toEqual(['med1', 'med2']);
    expect(todoMoveScope(all, all[3]!).map((x) => x.id)).toEqual(['done1']);
    // med2 up: swaps positions with med1 (the items between keep theirs).
    const moved = moveTodo(all, 'med2', -1)!;
    expect(moved).toEqual(['low1', 'med2', 'urg1', 'done1', 'med1', 'high1', 'urg2', 'low2']);
    const after = moved.map((id, position) => ({ ...all.find((x) => x.id === id)!, position }));
    expect(splitTodos(after).open.map((x) => x.id)).toEqual(['urg1', 'urg2', 'high1', 'med2', 'med1', 'low1', 'low2']);
    // At the top / bottom of a level, or the only one of it: nothing moves (it never crosses into another level).
    expect(moveTodo(all, 'med1', -1)).toBeNull();
    expect(moveTodo(all, 'urg2', 1)).toBeNull();
    expect(moveTodo(all, 'high1', -1)).toBeNull();
    expect(moveTodo(all, 'high1', 1)).toBeNull();
    expect(moveTodo(all, 'low2', -1)).toEqual(['low2', 'med1', 'urg1', 'done1', 'med2', 'high1', 'urg2', 'low1']);
  });

  it('a changed priority re-sorts the item into its new level by its own position', () => {
    const changed = all.map((x) => (x.id === 'low2' ? { ...x, priority: 'urgent' as const } : x));
    expect(splitTodos(changed).open.map((x) => x.id)).toEqual(['urg1', 'urg2', 'low2', 'high1', 'med1', 'med2', 'low1']);
  });
});

describe("the agent's compact lines (D70)", () => {
  it('todo_list: priority and estimate on each line, open items by priority; todo_get: everything', () => {
    const items = [
      t('aaa111', 0, 'low', { title: 'Tidy the README', estimateMinutes: 15 }),
      t('bbb222', 1, 'high', { title: 'Fix the login test', description: 'Retries hide a race.', plan: '1. Find the race', estimateMinutes: 45, addedBy: 'developer' }),
      t('ccc333', 2, 'urgent', { title: 'Restore prod', plan: 'No plan: roll back' }),
    ];
    expect(todoLine(items[1]!)).toBe('[bbb222] ☐ HIGH ~45m Fix the login test (added by the developer) · has description, plan');
    expect(todoLine(items[2]!)).toBe('[ccc333] ☐ URGENT ~? Restore prod');
    const list: SessionTodoList = { sessionId: 's', todos: items, openCount: 3, doneCount: 0 };
    expect(todoListText(list).split('\n').slice(0, 4)).toEqual([
      'Open (3):',
      '[ccc333] ☐ URGENT ~? Restore prod',
      '[bbb222] ☐ HIGH ~45m Fix the login test (added by the developer) · has description, plan',
      '[aaa111] ☐ LOW ~15m Tidy the README',
    ]);
    expect(todoDetailText(items[1]!)).toBe(
      '[bbb222] ☐ open · added by the developer\nTitle: Fix the login test\nPriority: High\nEstimate: ~45m (45 minutes for an AI agent)\n\nDescription:\nRetries hide a race.\n\nPlan:\n1. Find the race',
    );
    expect(todoDetailText(items[2]!)).toContain('Priority: Urgent\nEstimate: (none)');
    expect(todoDetailText(items[2]!)).toContain('Plan:\nNo plan: roll back');
  });
});
