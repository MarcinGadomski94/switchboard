import { describe, expect, it } from 'vitest';
import { BOARD_COLUMNS as AGENT_COLUMNS, columnOf } from '../../src/web/v2/agents/agents-model.ts';
import { BOARD_COLUMNS as PROJECT_COLUMNS, boardColumn } from '../../src/web/v2/projects/project-model.ts';
import { BOARD_COLUMNS, BOARD_COLUMN_ICON, agentOpening, boardCounts, boardFlipKey } from '../../src/web/v2/shared/board-model.ts';

/** D131 · lane X · the one v2 board's pure part: shared by the Agents board and a project's Board view. */

describe('the shared board', () => {
  it('has the prototype’s four columns, the same for Agents and for a project', () => {
    expect(BOARD_COLUMNS).toEqual(['needs', 'working', 'ready', 'done']);
    expect(AGENT_COLUMNS).toBe(BOARD_COLUMNS);
    expect(PROJECT_COLUMNS).toBe(BOARD_COLUMNS);
    expect(Object.keys(BOARD_COLUMN_ICON)).toEqual([...BOARD_COLUMNS]);
  });

  it('counts each column with the caller’s rule; off-board items are not counted', () => {
    const counts = boardCounts(['needs', 'working', 'working', 'idle', 'done'] as const, (status) => columnOf(status));
    expect(counts).toEqual({ needs: 1, working: 2, ready: 0, done: 1 });
    // A project's steps: every step sits in a column (a waiting one under Working).
    const steps = [{ state: 'waiting', reason: null }, { state: 'done', reason: null }] as unknown as Parameters<typeof boardColumn>[0][];
    expect(boardCounts(steps, (step) => boardColumn(step))).toEqual({ needs: 0, working: 1, ready: 0, done: 1 });
  });

  it('changes the FLIP key only when a card changes lane or column', () => {
    const before = boardFlipKey([{ id: 'p1', cards: [{ id: 'a', column: 'working' }, { id: 'b', column: 'needs' }] }]);
    expect(boardFlipKey([{ id: 'p1', cards: [{ id: 'a', column: 'working' }, { id: 'b', column: 'needs' }] }])).toBe(before);
    expect(boardFlipKey([{ id: 'p1', cards: [{ id: 'a', column: 'ready' }, { id: 'b', column: 'needs' }] }])).not.toBe(before);
    expect(boardFlipKey([{ id: 'p2', cards: [{ id: 'a', column: 'working' }, { id: 'b', column: 'needs' }] }])).not.toBe(before);
  });

  it('opens an agent in the peek sheet on a desktop or a tablet, its page on a phone', () => {
    expect(agentOpening('desktop')).toBe('peek');
    expect(agentOpening('tablet')).toBe('peek');
    expect(agentOpening('phone')).toBe('page');
  });
});
