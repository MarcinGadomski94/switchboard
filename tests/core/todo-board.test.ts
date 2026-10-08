import { describe, expect, it } from 'vitest';
import type { SessionTodo, TodoGroup } from '../../src/core/api.ts';
import { NO_BOARD_FILTERS, boardCanDrop, boardColumns, boardDrop } from '../../src/core/todo-board.ts';

/** D77 oracle (`docs/todos.md` → *Board*): the columns, their order, the filters and the drops. */

function todo(id: string, state: SessionTodo['state'], extra: Partial<SessionTodo> = {}): SessionTodo {
  return { id, sessionId: 's', title: id, text: id, description: null, plan: 'No plan', priority: 'medium', estimateMinutes: null, state, addedBy: 'agent', position: 0, createdAt: '', updatedAt: '', doneAt: null, removeAt: null, ...extra };
}

function group(sessionId: string, title: string, todos: SessionTodo[], extra: Partial<TodoGroup> = {}): TodoGroup {
  return { sessionId, title, solutions: [], folderPath: '/repos/one', machine: null, lastActivityAt: null, todos, ...extra };
}

const groups: TodoGroup[] = [
  group('a', 'Alpha', [todo('a-low', 'open', { priority: 'low', position: 0 }), todo('a-high', 'open', { priority: 'high', position: 1 }), todo('a-run', 'review', { runSessionId: 'r1' })]),
  group('b', 'Beta', [todo('b-high', 'open', { priority: 'high', position: 0, description: 'needle here' }), todo('b-done', 'done')], { folderPath: '/repos/two', machine: { id: 'm1', name: 'Office', state: 'online' } }),
];

describe('the board (D77)', () => {
  it('columns by state; within one: priority, then the sessions in page order, then position', () => {
    const columns = boardColumns(groups, NO_BOARD_FILTERS);
    expect(columns.open.map((card) => card.todo.id)).toEqual(['a-high', 'b-high', 'a-low']);
    expect(columns.review.map((card) => card.todo.id)).toEqual(['a-run']);
    expect(columns.done.map((card) => card.todo.id)).toEqual(['b-done']);
    expect(columns.in_progress).toEqual([]);
  });

  it('filters: priority, machine (this one / a paired one), folder, session, search (title, description, session title)', () => {
    const ids = (filters: Partial<typeof NO_BOARD_FILTERS>) => Object.values(boardColumns(groups, { ...NO_BOARD_FILTERS, ...filters })).flat().map((card) => card.todo.id).sort();
    expect(ids({ priority: 'high' })).toEqual(['a-high', 'b-high']);
    expect(ids({ machine: 'local' })).toEqual(['a-high', 'a-low', 'a-run']);
    expect(ids({ machine: 'm1' })).toEqual(['b-done', 'b-high']);
    expect(ids({ folder: '/repos/two' })).toEqual(['b-done', 'b-high']);
    expect(ids({ session: 'a' })).toEqual(['a-high', 'a-low', 'a-run']);
    expect(ids({ search: 'NEEDLE' })).toEqual(['b-high']);
    expect(ids({ search: 'alpha' })).toEqual(['a-high', 'a-low', 'a-run']);
  });

  it('drops: in progress without a message, Done skips review, Review only with a run, the same column nothing', () => {
    expect(boardDrop({ state: 'open', runSessionId: null }, 'in_progress')).toEqual({ state: 'in_progress' });
    expect(boardDrop({ state: 'in_progress', runSessionId: 'r' }, 'done')).toEqual({ state: 'done', skipReview: true });
    expect(boardDrop({ state: 'open', runSessionId: null }, 'review')).toBeNull();
    expect(boardDrop({ state: 'done', runSessionId: 'r' }, 'review')).toEqual({ state: 'review' });
    expect(boardDrop({ state: 'done', runSessionId: null }, 'open')).toEqual({ state: 'open' });
    expect(boardCanDrop({ state: 'open', runSessionId: null }, 'open')).toBe(false);
  });
});
