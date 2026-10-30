import { describe, expect, it } from 'vitest';
import type { SessionTodo, TodoGroup } from '../../src/core/api.ts';
import type { SessionStatus } from '../../src/core/model.ts';
import { TASKS_WORDS } from '../../src/web/v2/glossary.ts';
import {
  TASK_COLUMNS,
  addedTodo,
  blockedReason,
  boardOf,
  cardKey,
  elapsedMs,
  estimateAccuracy,
  estimateText,
  movePatch,
  moveTargets,
  overEstimate,
  priorityLook,
  quickAddInput,
  taskColumnOf,
  unfinishedCount,
  workerOf,
} from '../../src/web/v2/agents/tasks/tasks-model.ts';

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const MIN = 60_000;

function todo(id: string, extra: Partial<SessionTodo> = {}): SessionTodo {
  return {
    id,
    sessionId: 's1',
    title: `Task ${id}`,
    text: `Task ${id}`,
    description: null,
    plan: 'No plan',
    priority: 'medium',
    estimateMinutes: null,
    state: 'open',
    addedBy: 'developer',
    position: 0,
    createdAt: '2026-10-25T10:00:00.000Z',
    updatedAt: '2026-10-25T10:00:00.000Z',
    doneAt: null,
    removeAt: null,
    ...extra,
  };
}

function group(sessionId: string, todos: SessionTodo[], extra: Partial<TodoGroup> = {}): TodoGroup {
  return { sessionId, title: `Agent ${sessionId}`, solutions: [], folderPath: null, machine: null, lastActivityAt: null, todos: todos.map((item) => ({ ...item, sessionId })), ...extra };
}

describe('v2 Tasks · columns', () => {
  it('maps the three todo states onto Open · In progress · Review · Done', () => {
    expect(TASK_COLUMNS).toEqual(['open', 'progress', 'review', 'done']);
    expect(taskColumnOf({ state: 'open' }, 'run')).toBe('open');
    expect(taskColumnOf({ state: 'done' }, 'idle')).toBe('done');
    // In progress while its agent runs (or is unknown), Review once it stopped.
    expect(taskColumnOf({ state: 'in_progress' }, 'run')).toBe('progress');
    expect(taskColumnOf({ state: 'in_progress' }, null)).toBe('progress');
    for (const status of ['idle', 'done', 'need', 'fail', 'paused'] as const) expect(taskColumnOf({ state: 'in_progress' }, status)).toBe('review');
  });

  it('the worker is the active run session, else the own session', () => {
    expect(workerOf({ sessionId: 's1', runSessionId: 'r1', runState: 'active' })).toBe('r1');
    expect(workerOf({ sessionId: 's1', runSessionId: 'r1', runState: 'discarded' })).toBe('s1');
    expect(workerOf({ sessionId: 's1' })).toBe('s1');
  });

  it('builds the board: priority first, then the groups’ order, then position; Done newest first; hidden cards left out', () => {
    const statuses: Record<string, SessionStatus> = { a: 'run', b: 'idle', r9: 'run' };
    const groups = [
      group('a', [todo('1', { priority: 'low', position: 0 }), todo('2', { priority: 'urgent', position: 1 }), todo('3', { state: 'in_progress', position: 2 }), todo('4', { state: 'done', doneAt: '2026-10-25T11:00:00.000Z', position: 3 })]),
      group('b', [todo('5', { priority: 'urgent', position: 0 }), todo('6', { state: 'in_progress' }), todo('7', { state: 'in_progress', runSessionId: 'r9', runState: 'active' }), todo('8', { state: 'done', doneAt: '2026-10-25T11:30:00.000Z' })]),
    ];
    const board = boardOf(groups, (id) => statuses[id] ?? null, new Set([cardKey('a', '1')]));
    expect(board.open.map((card) => card.todo.id)).toEqual(['2', '5']);
    expect(board.progress.map((card) => card.todo.id)).toEqual(['3', '7']);
    expect(board.review.map((card) => card.todo.id)).toEqual(['6']);
    expect(board.done.map((card) => card.todo.id)).toEqual(['8', '4']);
    expect(board.open[1]?.group.sessionId).toBe('b');
  });
});

describe('v2 Tasks · estimate vs actual', () => {
  it('says the estimate, the time so far and the time taken', () => {
    expect(estimateText(todo('o', { estimateMinutes: 20 }), NOW)).toBe('est 20m');
    expect(estimateText(todo('o'), NOW)).toBe('');
    const running = todo('p', { state: 'in_progress', estimateMinutes: 15, actualMs: 10 * MIN, startedAt: new Date(NOW - 8 * MIN).toISOString() });
    expect(estimateText(running, NOW)).toBe('est 15m · 18m so far');
    expect(overEstimate(running, NOW)).toBe(true);
    expect(estimateText(todo('d', { state: 'done', estimateMinutes: 60, actualMs: 48 * MIN, workingMs: 48 * MIN }), NOW)).toBe('est 1h · took 48m');
    expect(overEstimate(todo('d', { state: 'done', estimateMinutes: 60, actualMs: 48 * MIN, workingMs: 48 * MIN }), NOW)).toBe(false);
    expect(estimateText(todo('d', { state: 'done', actualMs: 20_000, workingMs: 20_000 }), NOW)).toBe('took <1m');
    // D147: the working time is what it took; the open time beside it; an item finished before D147 has open time only (never "over").
    const waited = todo('d', { state: 'done', estimateMinutes: 45, actualMs: (51 * 60 + 3) * MIN, workingMs: 12 * MIN });
    expect(estimateText(waited, NOW)).toBe('est 45m · took 12m (open 51h 3m)');
    expect(overEstimate(waited, NOW)).toBe(false);
    expect(overEstimate({ ...waited, workingMs: 50 * MIN }, NOW)).toBe(true);
    const old = todo('d', { state: 'done', estimateMinutes: 45, actualMs: 100 * 60 * MIN, workingMs: null });
    expect(estimateText(old, NOW)).toBe('est 45m · open 100h');
    expect(overEstimate(old, NOW)).toBe(false);
    expect(estimateText(todo('d', { state: 'done', estimateMinutes: 30 }), NOW)).toBe('est 30m');
  });

  it('counts the running span from startedAt', () => {
    expect(elapsedMs({ state: 'in_progress', actualMs: null, startedAt: new Date(NOW - 5 * MIN).toISOString() }, NOW)).toBe(5 * MIN);
    expect(elapsedMs({ state: 'in_progress', actualMs: null, startedAt: null }, NOW)).toBeNull();
    expect(elapsedMs({ state: 'open', actualMs: 3 * MIN, startedAt: null }, NOW)).toBe(3 * MIN);
  });

  it('sums the estimates’ accuracy over every agent', () => {
    expect(estimateAccuracy([null, undefined])).toBeNull();
    const working = (estimated: number, estimateMinutes: number, minutes: number) => ({ count: estimated, ms: minutes * MIN, openMs: minutes * MIN, estimated, estimateMinutes, estimatedMs: minutes * MIN, estimatedOpenMs: 10 * minutes * MIN });
    const total = (estimated: number, estimateMinutes: number, actualMinutes: number) => ({ count: estimated, estimated, estimateMinutes, estimatedActualMs: 10 * actualMinutes * MIN, actualMs: 10 * actualMinutes * MIN, tokens: 0, working: working(estimated, estimateMinutes, actualMinutes) });
    expect(estimateAccuracy([total(2, 50, 57), total(0, 0, 0)])).toEqual({ percent: 86, count: 2 });
    expect(estimateAccuracy([total(1, 10, 40)])).toEqual({ percent: 0, count: 1 });
    // D147: open-time-only totals (before D147, an older peer) do not count.
    expect(estimateAccuracy([{ count: 3, estimated: 3, estimateMinutes: 30, estimatedActualMs: 30 * MIN, actualMs: 30 * MIN, tokens: 0 }])).toBeNull();
    expect(TASKS_WORDS.accuracy(82, 5)).toBe('Estimates were 82% accurate on 5 completed tasks.');
  });
});

describe('v2 Tasks · priority, moves, quick add, availability', () => {
  it('shows each priority as icon + word + colour', () => {
    expect(priorityLook('urgent')).toEqual({ key: 'urgent', label: 'Urgent', icon: 'alert', tone: 'red' });
    expect(priorityLook('high')).toMatchObject({ label: 'High', tone: 'amber' });
    expect(priorityLook('medium')).toMatchObject({ label: 'Medium', tone: 'grey' });
    expect(priorityLook('low')).toMatchObject({ label: 'Low', icon: 'chev-down' });
    expect(priorityLook('weird')).toMatchObject({ key: 'medium' });
  });

  it('moves to a state column; Review is not a state', () => {
    expect(movePatch({ state: 'open' }, 'progress')).toEqual({ state: 'in_progress' });
    expect(movePatch({ state: 'in_progress' }, 'done')).toEqual({ state: 'done' });
    expect(movePatch({ state: 'done' }, 'open')).toEqual({ state: 'open' });
    expect(movePatch({ state: 'open' }, 'open')).toBeNull();
    expect(movePatch({ state: 'open' }, 'review')).toBeNull();
    expect(moveTargets({ state: 'in_progress' })).toEqual(['open', 'done']);
  });

  it('turns the quick add text into a capture', () => {
    expect(quickAddInput('   ')).toBeNull();
    expect(quickAddInput('task ')).toBeNull();
    expect(quickAddInput('Task Update the PROJ-123 copy')).toEqual({ title: 'Update the PROJ-123 copy', note: null });
    expect(quickAddInput('Tasks page polish')).toEqual({ title: 'Tasks page polish', note: null });
    const long = `Fix ${'the checkout '.repeat(12)}`.trim();
    const input = quickAddInput(long);
    expect(input?.note).toBe(long);
    expect(input?.title.length).toBeLessThanOrEqual(120);
    expect(input?.title.endsWith('…')).toBe(true);
  });

  it('says why a paired computer’s task cannot start', () => {
    expect(blockedReason(null, TASKS_WORDS)).toBeNull();
    expect(blockedReason({ name: 'Studio-PC', state: 'online' }, TASKS_WORDS)).toBeNull();
    expect(blockedReason({ name: 'Studio-PC', state: 'offline' }, TASKS_WORDS)).toBe('Studio-PC is offline');
    expect(blockedReason({ name: 'Studio-PC', state: 'reconnecting' }, TASKS_WORDS)).toBe('Reconnecting to Studio-PC…');
  });

  it('finds the item a capture added', () => {
    const list = [todo('a'), todo('b', { createdAt: '2026-10-25T11:00:00.000Z' }), todo('c', { createdAt: '2026-10-25T11:05:00.000Z' })];
    expect(addedTodo(new Set(['a']), list)?.id).toBe('c');
    expect(addedTodo(new Set(['a', 'b', 'c']), list)).toBeNull();
  });
});

describe('v2 Tasks · the rail badge', () => {
  it('counts every agent\'s tasks not done yet (Open, In progress and Review together)', () => {
    const groups = [group('a', [todo('1'), todo('2', { state: 'in_progress' }), todo('3', { state: 'done' })]), group('b', [todo('4', { state: 'in_progress' }), todo('5', { state: 'done' })]), group('c', [])];
    expect(unfinishedCount(groups)).toBe(3);
    // The board puts the same three in Open, In progress and Review, whatever the agents' status.
    const board = boardOf(groups, (id) => (id === 'b' ? 'idle' : 'run'));
    expect(board.open.length + board.progress.length + board.review.length).toBe(3);
  });

  it('is 0 before the list loads, with no groups and when everything is done', () => {
    expect(unfinishedCount(null)).toBe(0);
    expect(unfinishedCount(undefined)).toBe(0);
    expect(unfinishedCount([])).toBe(0);
    expect(unfinishedCount([group('a', [todo('1', { state: 'done' })])])).toBe(0);
  });
});
