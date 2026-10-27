import { describe, expect, it } from 'vitest';
import type { Agent, WorkflowRun } from '../../src/core/api.ts';
import {
  HELPERS_PAGE,
  RECENT_HELPER_MS,
  activeHelperCount,
  foldHelpers,
  foldLanes,
  helperBucket,
  helperRows,
  nextFoldAt,
  runActivityAt,
  runBucket,
} from '../../src/web/v2/agent/helpers-model.ts';
import { AGENT_WORDS } from '../../src/web/v2/glossary.ts';

/** 2026-10-27 · the helpers fold: active + ended within 10 minutes show, older ones fold. */

const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

function agent(id: string, status: Agent['status'], extra: Partial<Agent> = {}): Agent {
  return { id, kind: 'subagent', name: id, description: null, solutionPath: null, branch: null, status, statusText: null, toolUseId: null, workflow: null, startedAt: ago(60), updatedAt: ago(60), endedAt: null, ...extra };
}

function wfAgent(id: string, runId: string, status: Agent['status'], endedAt: string | null, startedAt = ago(60)): Agent {
  return agent(id, status, {
    kind: 'workflow',
    startedAt,
    updatedAt: null,
    endedAt,
    workflow: { runId, index: 1, agentId: id, phase: null, model: null, startedAt, endedAt, action: null, cwd: null, version: 0 },
  });
}

function run(runId: string, status: WorkflowRun['status'], endedAt: string | null, startedAt = ago(60)): WorkflowRun {
  return { runId, taskId: null, name: runId, summary: null, status, phase: null, phases: [], agentCount: 1, doneCount: 0, failedCount: 0, startedAt, endedAt };
}

const main = agent('main', 'run', { kind: 'main' });

describe('classification by state and time', () => {
  it('working, waiting, starting and paused are active; done, failed and stopped are not', () => {
    for (const status of ['run', 'need', 'paused'] as const) expect(helperBucket(agent('a', status), NOW)).toBe('active');
    for (const status of ['done', 'fail', 'idle'] as const) expect(helperBucket(agent('a', status, { endedAt: ago(1) }), NOW)).toBe('recent');
  });

  it('ended within 10 minutes is recent (the boundary itself too), later earlier', () => {
    expect(helperBucket(agent('a', 'done', { endedAt: ago(10) }), NOW)).toBe('recent');
    expect(helperBucket(agent('a', 'done', { endedAt: new Date(NOW - RECENT_HELPER_MS - 1).toISOString() }), NOW)).toBe('earlier');
    expect(helperBucket(agent('a', 'fail', { endedAt: ago(30) }), NOW)).toBe('earlier');
    // No end time: its last change; nothing at all: earlier (an older payload).
    expect(helperBucket(agent('a', 'idle', { endedAt: null, updatedAt: ago(2) }), NOW)).toBe('recent');
    expect(helperBucket(agent('a', 'idle', { endedAt: null, updatedAt: null }), NOW)).toBe('earlier');
  });

  it('a helper that is active again un-folds', () => {
    const old = agent('a', 'done', { endedAt: ago(40) });
    expect(helperBucket(old, NOW)).toBe('earlier');
    expect(helperBucket({ ...old, status: 'run', updatedAt: ago(0) }, NOW)).toBe('active');
  });

  it('the boundary moves with the clock', () => {
    const a = agent('a', 'done', { endedAt: ago(9) });
    expect(helperBucket(a, NOW)).toBe('recent');
    expect(helperBucket(a, NOW + 2 * 60_000)).toBe('earlier');
  });
});

describe('ordering and folding', () => {
  const agents = [
    main,
    agent('old1', 'done', { endedAt: ago(50) }),
    agent('run-old', 'run', { updatedAt: ago(20) }),
    agent('recent-old', 'fail', { endedAt: ago(8) }),
    agent('old2', 'idle', { endedAt: ago(15) }),
    agent('run-new', 'need', { updatedAt: ago(1) }),
    agent('recent-new', 'done', { endedAt: ago(2) }),
  ];

  it('active newest activity first, then recent, then the folded ones newest first; the main agent is no helper', () => {
    const fold = foldHelpers(agents, NOW);
    expect(fold.active.map((a) => a.id)).toEqual(['run-new', 'run-old']);
    expect(fold.recent.map((a) => a.id)).toEqual(['recent-new', 'recent-old']);
    expect(fold.earlier.map((a) => a.id)).toEqual(['old2', 'old1']);
  });

  it('folded rows show only while expanded, 50 at a time', () => {
    const fold = foldHelpers(agents, NOW);
    expect(helperRows(fold, false)).toEqual({ shown: [...fold.active, ...fold.recent], earlier: 2, more: 0 });
    expect(helperRows(fold, true).shown.map((a) => a.id)).toEqual(['run-new', 'run-old', 'recent-new', 'recent-old', 'old2', 'old1']);
    const many = foldHelpers(Array.from({ length: 130 }, (_, i) => agent(`h${i}`, 'done', { endedAt: ago(20 + i) })), NOW);
    expect(many.earlier).toHaveLength(130);
    expect(helperRows(many, false)).toMatchObject({ earlier: 130, more: 0 });
    expect(helperRows(many, false).shown).toHaveLength(0);
    const first = helperRows(many, true);
    expect(first.shown).toHaveLength(HELPERS_PAGE);
    expect(first.shown[0]?.id).toBe('h0');
    expect(first.more).toBe(80);
    expect(helperRows(many, true, 100).more).toBe(30);
    expect(helperRows(many, true, 150)).toMatchObject({ more: 0 });
  });

  it('counts only active helpers', () => {
    expect(activeHelperCount(agents)).toBe(2);
    expect(activeHelperCount([main])).toBe(0);
  });

  it('the clock needs to tick only while a recent helper can fold', () => {
    expect(nextFoldAt(agents, NOW)).toBe(Date.parse(ago(8)) + RECENT_HELPER_MS);
    expect(nextFoldAt([main, agent('a', 'run'), agent('b', 'done', { endedAt: ago(30) })], NOW)).toBeNull();
  });
});

describe('Workflow runs', () => {
  it('a run\'s agents follow the run once it ended: by its end', () => {
    const runs = [run('wf_old', 'done', ago(30)), run('wf_new', 'fail', ago(3)), run('wf_live', 'run', null)];
    const agents = [
      main,
      wfAgent('o1', 'wf_old', 'done', ago(31)),
      wfAgent('o2', 'wf_old', 'done', ago(30)),
      wfAgent('n1', 'wf_new', 'fail', ago(3)),
      // An agent the run left running when it stopped is not active any more.
      wfAgent('n2', 'wf_new', 'run', null),
      wfAgent('l1', 'wf_live', 'done', ago(40)),
      wfAgent('l2', 'wf_live', 'run', null, ago(1)),
    ];
    const fold = foldHelpers(agents, NOW, runs);
    expect(fold.active.map((a) => a.id)).toEqual(['l2']);
    expect(fold.recent.map((a) => a.id).sort()).toEqual(['n1', 'n2']);
    expect(fold.earlier.map((a) => a.id)).toEqual(['o2', 'o1', 'l1']);
    expect(activeHelperCount(agents, runs)).toBe(1);
  });

  it('a run folds as one: active while it runs, recent within 10 minutes of its end, else earlier', () => {
    const agents = [wfAgent('a', 'wf_1', 'done', ago(12))];
    expect(runBucket(run('wf_1', 'run', null), agents, NOW)).toBe('active');
    expect(runBucket(run('wf_1', 'done', ago(9)), agents, NOW)).toBe('recent');
    expect(runBucket(run('wf_1', 'idle', ago(11)), agents, NOW)).toBe('earlier');
    // No end on the run: its agents' newest end.
    expect(runBucket(run('wf_1', 'fail', null), agents, NOW)).toBe('earlier');
    expect(runBucket(run('wf_1', 'fail', null), [wfAgent('a', 'wf_1', 'fail', ago(4))], NOW)).toBe('recent');
    expect(runActivityAt(run('wf_1', 'done', ago(9)), agents)).toBe(Date.parse(ago(9)));
    expect(runActivityAt(run('wf_1', 'run', null, ago(30)), [wfAgent('a', 'wf_1', 'run', null, ago(2))])).toBe(Date.parse(ago(2)));
  });
});

describe('Timeline lanes', () => {
  it('lanes of folded helpers go to the summary lane, in the timeline\'s order; the main lane stays', () => {
    const agents = [main, agent('a', 'done', { endedAt: ago(40) }), agent('b', 'run'), agent('c', 'fail', { endedAt: ago(20) }), agent('d', 'done', { endedAt: ago(1) })];
    const lanes = [{ id: 'main' }, { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'gone' }];
    const fold = foldLanes(lanes, agents, NOW);
    expect(fold.shown.map((l) => l.id)).toEqual(['main', 'b', 'd', 'gone']);
    expect(fold.earlier.map((l) => l.id)).toEqual(['a', 'c']);
    expect(foldLanes([{ id: null }], [], NOW).shown).toHaveLength(1);
  });
});

describe('words', () => {
  it('pluralises the glossary word', () => {
    expect(AGENT_WORDS.showEarlierHelpers(1)).toBe('Show 1 helper finished earlier');
    expect(AGENT_WORDS.showEarlierHelpers(12)).toBe('Show 12 helpers finished earlier');
    expect(AGENT_WORDS.earlierLanes(1)).toBe('1 earlier helper');
    expect(AGENT_WORDS.earlierLanes(3)).toBe('3 earlier helpers');
    expect(AGENT_WORDS.helpersTabActive(2)).toBe('Helpers · 2 active');
    expect(AGENT_WORDS.showMoreHelpers(50, 80)).toBe('Show 50 more (80 left)');
  });
});
