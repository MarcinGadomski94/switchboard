import { describe, expect, it } from 'vitest';
import type { SessionTodo, TodoGroup } from '../../src/core/api.ts';
import { agentMatches, agentSections, agentTasksPath, agentsFromSearch, agentsSearch, filterGroups, liveFilter, readStoredAgents, taskAgents, toggleAgent } from '../../src/web/v2/agents/tasks/tasks-agents.ts';

/** D188 · the Tasks page by agent: the filter, its address, the grouped board. */

function todo(id: string, state: SessionTodo['state'] = 'open'): SessionTodo {
  return { id, sessionId: 's', title: id, text: id, state, position: 0, priority: 'medium', createdAt: '2026-11-24T10:00:00.000Z' } as unknown as SessionTodo;
}

function group(sessionId: string, title: string, todos: SessionTodo[], machine: string | null = null): TodoGroup {
  return { sessionId, title, solutions: [], folderPath: null, machine: machine ? { id: 'm1', name: machine, state: 'online' } : null, lastActivityAt: null, todos };
}

const GROUPS = [
  group('s2', 'beta-agent', [todo('b1'), todo('b2', 'done')]),
  group('r~m1~s3', 'acme-api', [todo('c1', 'in_progress')], 'Acme-MacBook'),
  group('s4', 'empty-agent', []),
  group('s1', 'alpha-agent', [todo('a1')]),
];

describe('D188 · tasks by agent', () => {
  it('lists the agents that have tasks, by name, with their computer and counts (an agent without tasks left out)', () => {
    expect(taskAgents(GROUPS)).toEqual([
      { sessionId: 'r~m1~s3', title: 'acme-api', computer: 'Acme-MacBook', count: 1, open: 1 },
      { sessionId: 's1', title: 'alpha-agent', computer: null, count: 1, open: 1 },
      { sessionId: 's2', title: 'beta-agent', computer: null, count: 2, open: 1 },
    ]);
  });

  it('the search matches a name or a computer, any case', () => {
    expect(agentMatches({ title: 'acme-api', computer: 'Acme-MacBook' }, 'MACBOOK')).toBe(true);
    expect(agentMatches({ title: 'alpha-agent', computer: null }, 'ALP')).toBe(true);
    expect(agentMatches({ title: 'alpha-agent', computer: null }, 'beta')).toBe(false);
    expect(agentMatches({ title: 'alpha-agent', computer: null }, '  ')).toBe(true);
  });

  it('reads and writes the address (?agent=a,b), a paired computer’s id kept readable', () => {
    expect(agentsFromSearch('')).toBeNull();
    expect(agentsFromSearch('?q=x')).toBeNull();
    expect(agentsFromSearch('?agent=')).toEqual([]);
    expect(agentsFromSearch('?agent=s1,r~m1~s3,s1')).toEqual(['s1', 'r~m1~s3']);
    expect(agentsSearch([])).toBe('');
    expect(agentsSearch(['s1', 'r~m1~s3'])).toBe('?agent=s1,r~m1~s3');
    expect(agentsFromSearch(agentsSearch(['s1', 'r~m1~s3']))).toEqual(['s1', 'r~m1~s3']);
    expect(agentTasksPath('s1')).toBe('/tasks?agent=s1');
  });

  it('a remembered filter that does not read is every agent', () => {
    expect(readStoredAgents(null)).toEqual([]);
    expect(readStoredAgents('not json')).toEqual([]);
    expect(readStoredAgents('{"a":1}')).toEqual([]);
    expect(readStoredAgents('["s1", 2, ""]')).toEqual(['s1']);
  });

  it('keeps only the picked agents’ lists; none picked = every one; an agent gone from the list is dropped from the filter', () => {
    expect(filterGroups(GROUPS, [])).toBe(GROUPS);
    expect(filterGroups(GROUPS, ['s1', 'r~m1~s3']).map((g) => g.sessionId)).toEqual(['r~m1~s3', 's1']);
    expect(liveFilter(['s1', 'gone'], taskAgents(GROUPS))).toEqual(['s1']);
    expect(toggleAgent(['s1'], 's2')).toEqual(['s1', 's2']);
    expect(toggleAgent(['s1', 's2'], 's1')).toEqual(['s2']);
  });

  it('groups the board by agent in the service’s order, each with its own columns and counts; an agent with nothing shown has no section', () => {
    const sections = agentSections(GROUPS, () => 'done');
    expect(sections.map((s) => s.group.sessionId)).toEqual(['s2', 'r~m1~s3', 's1']);
    const beta = sections[0];
    expect(beta?.total).toBe(2);
    expect(beta?.open).toBe(1);
    expect(beta?.board.open.map((card) => card.todo.id)).toEqual(['b1']);
    expect(beta?.board.done.map((card) => card.todo.id)).toEqual(['b2']);
    // In progress with its agent stopped = Review (the board's own rule).
    expect(sections[1]?.board.review.map((card) => card.todo.id)).toEqual(['c1']);
    // A card on its way out (a delete's Undo window) is not counted.
    expect(agentSections(GROUPS, () => 'done', new Set(['s1\u0000a1'])).map((s) => s.group.sessionId)).toEqual(['s2', 'r~m1~s3']);
  });
});
