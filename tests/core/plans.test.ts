import { describe, expect, it } from 'vitest';
import {
  PLAN_TOOLS,
  type PlanItemFacts,
  checksFromRollup,
  findCycle,
  forbiddenTargetReason,
  normalizeItemKey,
  planItemBranch,
  planView,
  readyItems,
  topologicalOrder,
} from '../../src/core/plans.ts';
import { AGENT_MCP_INSTRUCTIONS } from '../../src/core/todos.ts';

const NOW = Date.parse('2026-10-13T12:00:00Z');

function fact(id: string, patch: Partial<PlanItemFacts> = {}): PlanItemFacts {
  return {
    id,
    todoId: `t-${id}`,
    key: `PROJ-${id}`,
    title: `Item ${id}`,
    hold: false,
    solutions: [],
    state: 'pending',
    reason: null,
    note: null,
    waitingOn: null,
    runSessionId: null,
    branch: null,
    prUrl: null,
    checks: null,
    conflicts: 0,
    estimateMinutes: 30,
    position: Number(id),
    startedAt: null,
    waitingSince: null,
    mergedAt: null,
    doneAt: null,
    sessionStatus: null,
    ...patch,
  };
}

const DIAMOND = [
  { from: '1', to: '2' },
  { from: '1', to: '3' },
  { from: '2', to: '4' },
  { from: '3', to: '4' },
];

describe('D99 · plan graph rules', () => {
  it('finds the cycle an edge would close, and orders the items', () => {
    expect(findCycle(DIAMOND, '4', '1')).toEqual(['4', '1', '2', '4']);
    expect(findCycle(DIAMOND, '1', '4')).toBeNull();
    expect(findCycle([], 'a', 'a')).toEqual(['a', 'a']);
    expect(topologicalOrder(['4', '3', '2', '1'], DIAMOND)).toEqual(['1', '3', '2', '4']);
    expect(topologicalOrder(['1', '2'], [{ from: '1', to: '2' }, { from: '2', to: '1' }])).toBeNull();
  });

  it('ready items: pending with every dependency done, in order, up to the free slots', () => {
    const items = [fact('1', { state: 'done' }), fact('2'), fact('3'), fact('4')];
    expect(readyItems(items, DIAMOND, 5).map((item) => item.id)).toEqual(['2', '3']);
    expect(readyItems(items, DIAMOND, 1).map((item) => item.id)).toEqual(['2']);
    expect(readyItems(items, DIAMOND, 0)).toEqual([]);
  });

  it('view states, the blocked reason, the critical path by actual / estimated time, progress and the time left', () => {
    const view = planView({
      mode: 'agents-with-holds',
      targetBranch: 'feature/PROJ-1-x',
      maxConcurrency: 3,
      edges: DIAMOND,
      now: NOW,
      items: [
        fact('1', { state: 'done', startedAt: '2026-10-13T10:00:00Z', doneAt: '2026-10-13T11:00:00Z' }),
        fact('2', { state: 'running', startedAt: '2026-10-13T11:50:00Z', estimateMinutes: 45, sessionStatus: 'need' }),
        fact('3', { state: 'running', startedAt: '2026-10-13T11:00:00Z', hold: true, waitingOn: 'merge', sessionStatus: 'idle' }),
        fact('4', { estimateMinutes: null }),
      ],
    });
    expect(view.items.map((item) => [item.id, item.state])).toEqual([
      ['1', 'done'],
      ['2', 'question'],
      ['3', 'ready-to-merge'],
      ['4', 'waiting'],
    ]);
    expect(view.items[3]?.reason).toBe('waiting on PROJ-2, PROJ-3');
    // 1 took 60; 3 runs 60 so far (> its 30 estimate); 2 is estimated 45; 4 the default 30.
    expect(view.criticalPath).toEqual({ itemIds: ['1', '3', '4'], minutes: 150 });
    expect(view.items.filter((item) => item.onCriticalPath).map((item) => item.id)).toEqual(['1', '3', '4']);
    expect(view.progress).toEqual({ done: 1, total: 4, percent: 25 });
    // Left: 2 → 35, 3 → 1 (past its estimate), 4 → 30: the longest chain 35 + 30.
    expect(view.estimatedMinutesLeft).toBe(65);
    expect(view.items[2]).toMatchObject({ developerMerges: true, actualMinutes: 60 });

    const blocked = planView({ mode: 'agents', targetBranch: 't', maxConcurrency: 3, edges: DIAMOND, now: NOW, items: [fact('1', { state: 'failed', reason: 'was discarded' }), fact('2'), fact('3'), fact('4')] });
    expect(blocked.items.map((item) => [item.state, item.reason])).toEqual([
      ['blocked', 'was discarded'],
      ['blocked', 'waiting on PROJ-1, which was discarded'],
      ['blocked', 'waiting on PROJ-1, which was discarded'],
      ['blocked', 'waiting on PROJ-2, which is blocked'],
    ]);
    expect(blocked.estimatedMinutesLeft).toBeNull();
  });

  it('reads PR checks: red names the failures, pending, none counts as green', () => {
    expect(checksFromRollup([])).toEqual({ state: 'none', summary: null, sha: null });
    expect(checksFromRollup([{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'StatusContext', context: 'ci/lint', state: 'SUCCESS' }])).toMatchObject({ state: 'green' });
    expect(checksFromRollup([{ name: 'build', status: 'IN_PROGRESS', conclusion: '' }])).toMatchObject({ state: 'pending', summary: 'running: build' });
    expect(checksFromRollup([{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }, { context: 'lint', state: 'ERROR' }, { name: 'e2e', status: 'QUEUED' }], 'abc')).toEqual({ state: 'red', summary: 'failed: unit, lint', sha: 'abc' });
  });

  it('target safeguard, keys and branch names', () => {
    for (const name of ['dev', 'master', 'main', 'origin/main', 'develop']) expect(forbiddenTargetReason(name)).toMatch(/never merge into/);
    expect(forbiddenTargetReason('feature/PROJ-1-x')).toBeNull();
    expect(forbiddenTargetReason('trunk', { defaultBranches: ['trunk'] })).toMatch(/default branch/);
    expect(forbiddenTargetReason('release', { protectedBranches: ['release'] })).toMatch(/protected/);
    expect(normalizeItemKey(' proj-12 ')).toBe('PROJ-12');
    expect(normalizeItemKey('')).toBeNull();
    expect(normalizeItemKey('not a key')).toBeUndefined();
    expect(planItemBranch('PROJ-12', 'fix-login')).toBe('PROJ-12-fix-login');
    expect(planItemBranch(null, 'fix-login')).toBe('todo/fix-login');
  });

  it('the MCP tools: five plan tools, plan_start requires the merge mode and tells the agent to ask', () => {
    expect(PLAN_TOOLS.map((tool) => tool.name)).toEqual(['plan_create', 'plan_add_item', 'plan_add_dependency', 'plan_status', 'plan_start']);
    const start = PLAN_TOOLS.find((tool) => tool.name === 'plan_start');
    expect(start?.inputSchema['required']).toEqual(['plan_id', 'merge_mode']);
    expect(start?.description).toContain('ASK the developer');
    expect(start?.description).toContain('never choose it yourself');
    expect(PLAN_TOOLS.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name)).toEqual(['plan_status']);
    // Experimental (D99): the server's instructions never name the plan tools (they exist only while Plans is on).
    expect(AGENT_MCP_INSTRUCTIONS).not.toContain('plan_');
  });
});
