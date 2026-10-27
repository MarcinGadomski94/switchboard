import { describe, expect, it } from 'vitest';
import {
  PLAN_PICK_REPOS_REASON,
  PLAN_STOPPED_GRACE_MS,
  PLAN_STOPPED_NO_MESSAGE,
  PLAN_TOOLS,
  type PlanItemFacts,
  pickReposMessage,
  checksFromRollup,
  findCycle,
  forbiddenTargetReason,
  normalizeItemKey,
  planItemBranch,
  planItemBrief,
  planItemSpanKind,
  planView,
  protectedTargetRefusal,
  readyItems,
  stoppedExcerpt,
  stoppedSince,
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
    // D99 follow-up 2026-10-15: a protected target needs the developer's acknowledgement (no longer a hard refusal).
    for (const name of ['dev', 'master', 'main', 'origin/main', 'develop']) expect(forbiddenTargetReason(name)).toMatch(/would merge straight into/);
    expect(protectedTargetRefusal('agents would merge straight into dev')).toContain('allowProtectedTarget: true');
    expect(forbiddenTargetReason('feature/PROJ-1-x')).toBeNull();
    expect(forbiddenTargetReason('trunk', { defaultBranches: ['trunk'] })).toMatch(/default branch/);
    expect(forbiddenTargetReason('release', { protectedBranches: ['release'] })).toMatch(/protected/);
    expect(normalizeItemKey(' proj-12 ')).toBe('PROJ-12');
    expect(normalizeItemKey('')).toBeNull();
    expect(normalizeItemKey('not a key')).toBeUndefined();
    expect(planItemBranch('PROJ-12', 'fix-login')).toBe('PROJ-12-fix-login');
    expect(planItemBranch(null, 'fix-login')).toBe('todo/fix-login');
  });

  it('D115: in a plan whose repos are picked per item, a pending item without solutions waits for them (a blocked dependency still wins)', () => {
    const items = [fact('1', { solutions: ['web-front'] }), fact('2'), fact('3', { state: 'failed', reason: 'was discarded' }), fact('4', { solutions: ['mobile'] })];
    const edges = [{ from: '3', to: '4' }];
    const view = planView({ mode: 'developer', targetBranch: 'feature/x', maxConcurrency: 3, edges, now: NOW, items, reposPerItem: true });
    const byId = new Map(view.items.map((item) => [item.id, item]));
    expect(byId.get('1')?.state).toBe('ready');
    expect(byId.get('2')).toMatchObject({ state: 'waiting', reason: PLAN_PICK_REPOS_REASON });
    expect(byId.get('4')?.state).toBe('blocked');
    // Without the flag an item without solutions runs in every repo of the plan (as before).
    expect(planView({ mode: 'developer', targetBranch: 'feature/x', maxConcurrency: 3, edges, now: NOW, items }).items.find((item) => item.id === '2')?.state).toBe('ready');
  });

  it('D115: the ask names the solutions and every item (key, id, todo, title, a cut description) and the tool', () => {
    const text = pickReposMessage({
      planId: 'p1',
      planTitle: 'PROJ-10 Acme checkout',
      solutions: ['web-front', 'mobile'],
      items: [
        { label: 'PROJ-11', id: 'i1', todoId: 't1', title: 'PROJ-11 Cart API', description: 'Expose the cart.' },
        { label: 'PROJ-12', id: 'i2', todoId: 't2', title: 'PROJ-12 Cart page', description: 'x'.repeat(2_000) },
      ],
    });
    expect(text).toContain('Please pick the repositories of the plan "PROJ-10 Acme checkout" [p1]');
    expect(text).toContain("The workspace's solutions you can pick from: web-front, mobile.");
    expect(text).toContain('- PROJ-11 [i1] (todo [t1]): PROJ-11 Cart API\n  Expose the cart.');
    expect(text).toContain('(the rest: todo_get)');
    expect(text).toContain('plan_set_solutions once with plan_id p1');
    expect(pickReposMessage({ planId: 'p1', planTitle: 'T', solutions: [], items: [], also: true })).toMatch(/^Also pick the repositories/);
  });

  it('the MCP tools: ten plan tools, plan_start requires the merge mode and tells the agent to ask', () => {
    expect(PLAN_TOOLS.map((tool) => tool.name)).toEqual(['plan_create', 'plan_add_item', 'plan_add_dependency', 'plan_status', 'plan_start', 'plan_set_solutions', 'plan_update_item', 'plan_remove_item', 'plan_remove_dependency', 'plan_set_mode']);
    const setSolutions = PLAN_TOOLS.find((tool) => tool.name === 'plan_set_solutions');
    expect(setSolutions?.inputSchema['required']).toEqual(['plan_id', 'items']);
    expect(setSolutions?.description).toContain('applied at once (it is not a proposal)');
    const start = PLAN_TOOLS.find((tool) => tool.name === 'plan_start');
    // D99 follow-up 2026-10-15: merge_mode may be left out for a plan without a target (the server still requires it with one).
    expect(start?.inputSchema['required']).toEqual(['plan_id']);
    expect(start?.description).toContain('ASK the developer');
    expect(start?.description).toContain('never choose it yourself');
    expect(Object.keys(start?.inputSchema['properties'] as object)).toEqual(['plan_id', 'merge_mode', 'allow_protected_target', 'sidebar_folder']);
    // D130: the agent asks for the runs' sidebar subfolder with the merge mode, suggesting the plan's title.
    expect(start?.description).toContain("ASK the developer for the sidebar subfolder the plan's runs go into (suggest the plan's title)");
    expect(JSON.stringify(start?.inputSchema['properties'])).toContain('"none"');
    expect(start?.description).toMatch(/allow_protected_target: true; never set it on your own/);
    const create = PLAN_TOOLS.find((tool) => tool.name === 'plan_create');
    expect(create?.inputSchema['required']).toEqual(['title']);
    expect(create?.description).toContain('Plans are for anything');
    expect(PLAN_TOOLS.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name)).toEqual(['plan_status']);
    // D129: items already in the plan; plan_add_item points there, plan_set_mode asks like plan_start.
    expect(PLAN_TOOLS.find((tool) => tool.name === 'plan_add_item')?.description).toContain('use plan_update_item; never add it again');
    const update = PLAN_TOOLS.find((tool) => tool.name === 'plan_update_item');
    expect(update?.inputSchema['required']).toEqual(['plan_id', 'item']);
    expect(Object.keys(update?.inputSchema['properties'] as object)).toEqual(['plan_id', 'item', 'hold', 'title', 'description', 'estimate_minutes']);
    expect(PLAN_TOOLS.find((tool) => tool.name === 'plan_remove_dependency')?.inputSchema['required']).toEqual(['plan_id', 'from', 'to']);
    const setMode = PLAN_TOOLS.find((tool) => tool.name === 'plan_set_mode');
    expect(setMode?.inputSchema['required']).toEqual(['plan_id', 'merge_mode']);
    expect(setMode?.description).toContain('ASK the developer before calling this');
    expect(setMode?.description).toMatch(/allow_protected_target: true; never set it on your own/);
    // Experimental (D99): the server's instructions never name the plan tools (they exist only while Plans is on).
    expect(AGENT_MCP_INSTRUCTIONS).not.toContain('plan_');
  });

  it('D99 follow-up 2026-10-15: a plan without a merge step — to-confirm, the brief, no merge rule', () => {
    const running = fact('1', { state: 'running', runSessionId: 's1', sessionStatus: 'idle', hold: true, waitingOn: 'merge' });
    const view = planView({ mode: 'none', targetBranch: null, maxConcurrency: 3, edges: [], now: NOW, items: [running, fact('2', { state: 'running', runSessionId: 's2', sessionStatus: 'run' })] });
    expect(view.items[0]).toMatchObject({ state: 'to-confirm', developerConfirms: true, developerMerges: false });
    expect(view.items[1]).toMatchObject({ state: 'running', developerConfirms: false });
    expect(planItemSpanKind({ state: 'running', heldReason: null }, view.items[0] as never)).toBe('waiting-you');
    const brief = planItemBrief({ planTitle: 'Research', targetBranch: null, noMerge: true, notes: null, key: null, branch: null, developerMerges: false, todo: { id: 't1', title: 'Read the docs', description: null, plan: null } });
    expect(brief).toContain('no merge step');
    expect(brief).toContain('You work in the source folder');
    expect(brief).not.toContain('gh pr create');
    // A merging plan into dev: no "never merge into dev" line any more.
    const dev = planItemBrief({ planTitle: 'Fixes', targetBranch: 'dev', notes: null, key: null, branch: 'todo/x', developerMerges: false, todo: { id: 't1', title: 'Fix', description: null, plan: null } });
    expect(dev).toContain('gh pr create --base dev');
    expect(dev).toContain('Never merge into any branch other than dev');
  });

  describe('D120 · stopped: its agent ended its turn without finishing', () => {
    const IDLE = '2026-10-13T11:50:00Z';
    // A started item whose run session is idle since 11:50 with its todo open.
    const idle = (patch: Partial<PlanItemFacts> = {}): PlanItemFacts =>
      fact('1', { state: 'running', runSessionId: 's1', sessionStatus: 'idle', todoDone: false, idleSince: IDLE, startedAt: '2026-10-13T11:00:00Z', ...patch });
    const view = (item: PlanItemFacts, options: { mode?: 'agents' | 'agents-with-holds' | 'developer' | 'none'; now?: number; grace?: number } = {}) =>
      planView({ mode: options.mode ?? 'agents', targetBranch: 'feature/PROJ-100', maxConcurrency: 3, edges: [{ from: '1', to: '2' }], now: options.now ?? NOW, items: [item, fact('2')], ...(options.grace !== undefined ? { stoppedGraceMs: options.grace } : {}) }).items;

    it('idle, todo open, past the grace period → stopped (red, waiting-you; its dependent keeps waiting)', () => {
      const [first, second] = view(idle());
      expect(first).toMatchObject({ state: 'stopped', reason: PLAN_STOPPED_NO_MESSAGE, stoppedSince: IDLE, storedState: 'running' });
      expect(second).toMatchObject({ state: 'waiting', reason: 'waiting on PROJ-1' });
      expect(planItemSpanKind({ state: 'running', heldReason: null }, first as never)).toBe('waiting-you');
      // done / paused session statuses count as a turn that is over too.
      expect(view(idle({ sessionStatus: 'done' }))[0]?.state).toBe('stopped');
      expect(view(idle({ sessionStatus: 'paused' }))[0]?.state).toBe('stopped');
    });

    it('within the grace period → running; the grace period is 2 minutes by default and can be shortened', () => {
      expect(PLAN_STOPPED_GRACE_MS).toBe(120_000);
      const justNow = idle({ idleSince: new Date(NOW - 60_000).toISOString() });
      expect(view(justNow)[0]).toMatchObject({ state: 'running', stoppedSince: null });
      expect(view(justNow, { grace: 30_000 })[0]?.state).toBe('stopped');
      expect(view(justNow, { now: NOW + 60_000 })[0]?.state).toBe('stopped');
    });

    it('working (a turn, subagents, a GitHub Actions wait or counted background work keep the status run) → running; working again → running', () => {
      expect(view(idle({ sessionStatus: 'run' }))[0]?.state).toBe('running');
      expect(stoppedSince(idle({ sessionStatus: 'run' }), 'agents')).toBeNull();
    });

    it('a question → question; an error → stopped (D139: Restart), its account waiting → says so; a todo done → not stopped', () => {
      expect(view(idle({ sessionStatus: 'need' }))[0]?.state).toBe('question');
      expect(view(idle({ sessionStatus: 'fail' }))[0]).toMatchObject({ state: 'stopped', stoppedBy: 'error', reason: 'its session stopped with an error' });
      expect(view(idle({ sessionStatus: 'fail', accountStop: "the account Work needs you — accept Anthropic's updated terms" }))[0]).toMatchObject({
        state: 'stopped',
        stoppedBy: 'account',
        reason: "Stopped (account needs you): the account Work needs you — accept Anthropic's updated terms",
      });
      expect(view(idle({ sessionStatus: 'fail' }))[0]?.stoppedSince).toBeNull();
      expect(view(idle({ todoDone: true }))[0]?.state).toBe('running');
      // Unknown todo (an older caller): never stopped.
      expect(view(idle({ todoDone: undefined }))[0]?.state).toBe('running');
    });

    it('green PRs while idle (waiting for your merge) → ready-to-merge; red checks while idle → stopped', () => {
      expect(view(idle({ waitingOn: 'merge' }), { mode: 'developer' })[0]?.state).toBe('ready-to-merge');
      expect(view(idle({ waitingOn: 'checks', checks: { state: 'red', summary: '1 failed: build', sha: 'abc' } }), { mode: 'developer' })[0]?.state).toBe('stopped');
      expect(view(idle({ waitingOn: 'checks', checks: { state: 'red', summary: '1 failed: build', sha: 'abc' } }))[0]?.state).toBe('stopped');
      // A second conflict stays blocked; a held item of a plan without a merge step waits for your confirmation.
      expect(view(idle({ waitingOn: 'conflict', conflicts: 2 }))[0]?.state).toBe('blocked');
      expect(view(idle({ hold: true, waitingOn: 'merge' }), { mode: 'none' })[0]?.state).toBe('to-confirm');
      // A plan without a merge step: idle with the todo open is stopped too.
      expect(view(idle(), { mode: 'none' })[0]?.state).toBe('stopped');
    });

    it('since: its idle time, else its start; the excerpt folds whitespace and is cut at 300 characters', () => {
      expect(stoppedSince(idle({ idleSince: null }), 'agents')).toBe('2026-10-13T11:00:00Z');
      expect(stoppedExcerpt('  The item is not finished.\n\nLeft: re-run a check.  ')).toBe('The item is not finished. Left: re-run a check.');
      expect(stoppedExcerpt('')).toBe(PLAN_STOPPED_NO_MESSAGE);
      const long = stoppedExcerpt('x'.repeat(500));
      expect(long).toHaveLength(300);
      expect(long.endsWith('…')).toBe(true);
    });
  });
});
