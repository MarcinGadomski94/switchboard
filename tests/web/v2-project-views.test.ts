import { describe, expect, it } from 'vitest';
import type { PlanEdge, PlanItem } from '../../src/core/plans.ts';
import { graphTone, projectGraphLayout, remainingCriticalPath } from '../../src/web/v2/projects/graph-layout.ts';
import { stepLook } from '../../src/web/v2/projects/project-model.ts';
import {
  PROGRESS_SEGMENTS,
  STEP_SECTIONS,
  TIMELINE,
  barSpan,
  columnOrder,
  criticalMarks,
  estimateBar,
  laneHues,
  laneOrder,
  readStepsGrouping,
  repoChips,
  repoLanes,
  sectionOf,
  stepMeta,
  stepSections,
  timelineArrows,
  timelineLanes,
  toneCounts,
} from '../../src/web/v2/projects/views-model.ts';

/**
 * Fixes after 2.0 → *Steps, Board and Timeline in the Graph's look*: the views' pure rules
 * (`src/web/v2/projects/views-model.ts`): the Steps sections and their order, the grouping, the
 * board column order, the lanes and chip hues as the Graph colours them, the meta line, the
 * critical path reused from the Graph, the timeline's bars, lanes and arrows.
 */

const NOW = Date.parse('2026-10-27T12:00:00Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const REPOS = ['acme-api', 'acme-web', 'acme-sdk'];

function item(id: string, position: number, solutions: readonly string[], patch: Partial<PlanItem> = {}): PlanItem {
  return {
    id,
    todoId: `t-${id}`,
    key: `ACME-${position}`,
    title: `Step ${id}`,
    hold: false,
    solutions,
    state: 'waiting',
    reason: null,
    note: null,
    storedState: 'pending',
    waitingOn: null,
    dependsOn: [],
    runSessionId: null,
    branch: null,
    prUrl: null,
    checks: null,
    developerMerges: false,
    developerConfirms: false,
    estimateMinutes: 45,
    actualMinutes: null,
    onCriticalPath: false,
    position,
    startedAt: null,
    waitingSince: null,
    mergedAt: null,
    doneAt: null,
    spans: [],
    ...patch,
  };
}

const e = (from: string, to: string): PlanEdge => ({ from, to });

function sample(): { items: PlanItem[]; edges: PlanEdge[] } {
  const [api, web, sdk] = REPOS.map((repo) => [repo]) as [string[], string[], string[]];
  const edges = [e('a1', 'a2'), e('a1', 'a3'), e('a2', 'w2'), e('w1', 'w2'), e('s1', 's2'), e('w2', 'x1'), e('a3', 'x1')];
  const items = [
    item('a1', 1, api, { state: 'done', storedState: 'done', actualMinutes: 38 }),
    item('w1', 2, web, { state: 'needs-you', storedState: 'running', reason: 'Which port?' }),
    item('s1', 3, sdk, { state: 'ready' }),
    item('a2', 4, api, { state: 'running', storedState: 'running', startedAt: ago(25), estimateMinutes: 60 }),
    item('a3', 5, api, { state: 'stopped', storedState: 'running', stoppedBy: 'error', reason: 'The agent stopped with an error' }),
    item('s2', 6, sdk),
    item('w2', 7, web),
    item('x1', 8, [REPOS[0] as string, REPOS[1] as string]),
    item('x2', 9, [], { state: 'ready-to-merge', storedState: 'done' }),
  ].map((entry) => ({ ...entry, dependsOn: edges.filter((edge) => edge.to === entry.id).map((edge) => edge.from) }));
  return { items, edges };
}

const toneOf = (entry: PlanItem) => graphTone(entry);

describe('Steps: sections by state', () => {
  it('puts everything that waits for the developer under Needs you', () => {
    expect(sectionOf('needs')).toBe('needs');
    expect(sectionOf('approval')).toBe('needs');
    expect(sectionOf('failed')).toBe('needs');
    expect(sectionOf('working')).toBe('working');
    expect(sectionOf('ready')).toBe('ready');
    expect(sectionOf('waiting')).toBe('waiting');
    expect(sectionOf('done')).toBe('done');
  });

  it('lists the non-empty sections in order, each in the plan’s order', () => {
    const { items } = sample();
    const sections = stepSections([...items].reverse(), toneOf);
    expect(sections.map((group) => group.section)).toEqual(['needs', 'working', 'ready', 'waiting', 'done']);
    expect(sections.map((group) => group.items.map((entry) => entry.id))).toEqual([['w1', 'a3', 'x2'], ['a2'], ['s1'], ['s2', 'w2', 'x1'], ['a1']]);
    expect(STEP_SECTIONS[STEP_SECTIONS.length - 1]).toBe('done');
    expect(stepSections(items.filter((entry) => entry.state === 'done'), toneOf).map((group) => group.section)).toEqual(['done']);
  });

  it('remembers the grouping, by state unless repository was chosen', () => {
    expect(readStepsGrouping('repo')).toBe('repo');
    expect(readStepsGrouping('state')).toBe('state');
    expect(readStepsGrouping(null)).toBe('state');
    expect(readStepsGrouping('lanes')).toBe('state');
  });
});

describe('the header and the board', () => {
  it('counts the steps by tone, in the Graph header’s order', () => {
    const counts = toneCounts(sample().items.map(toneOf));
    expect(counts).toEqual({ done: 1, working: 1, needs: 1, approval: 1, failed: 1, ready: 1, waiting: 3 });
    expect(PROGRESS_SEGMENTS).toEqual(['done', 'working', 'needs', 'approval', 'failed', 'ready', 'waiting']);
  });

  it('puts working cards first in a column, then ready, then waiting', () => {
    const { items } = sample();
    const working = items.filter((entry) => ['s1', 'a2', 's2', 'w2'].includes(entry.id));
    expect(columnOrder(working, toneOf).map((entry) => entry.id)).toEqual(['a2', 's1', 's2', 'w2']);
  });
});

describe('lanes and chips, as the Graph colours them', () => {
  it('orders the lanes like the Graph: the plan’s repositories, the rest by name, the neutral lane last', () => {
    const items = [item('a', 1, ['zeta']), item('b', 2, ['acme-web']), item('c', 3, []), item('d', 4, ['alpha'])];
    expect(laneOrder(items, ['acme-web'])).toEqual(['acme-web', 'alpha', 'zeta', '']);
  });

  it('gives each repository the hue of its Graph lane', () => {
    const { items, edges } = sample();
    const layout = projectGraphLayout(items, edges, REPOS);
    const hue = laneHues(items, REPOS);
    for (const lane of layout.lanes) expect(hue(lane.key)).toBe(lane.hue);
    // One lane only (no bands in the Graph): the repository's place among the plan's repositories.
    const single = [item('a', 1, ['acme-sdk']), item('b', 2, ['acme-sdk'])];
    expect(laneHues(single, REPOS)('acme-sdk')).toBe(2);
  });

  it('makes chips with short names, "N repos" for several, none without a repository', () => {
    const { items } = sample();
    const chip = repoChips(items, REPOS);
    expect(chip(items[0] as PlanItem)).toEqual({ text: 'api', hue: 0 });
    expect(chip(items[1] as PlanItem)).toEqual({ text: 'web', hue: 1 });
    expect(chip(items[7] as PlanItem)).toEqual({ text: '2 repos', hue: -1 });
    expect(chip(items[8] as PlanItem)).toBeNull();
  });

  it('groups the steps by lane with each lane’s progress', () => {
    const lanes = repoLanes(sample().items, REPOS);
    expect(lanes.map((lane) => [lane.label, lane.items.map((entry) => entry.id), lane.done, lane.hue])).toEqual([
      ['acme-api', ['a1', 'a2', 'a3'], 1, 0],
      ['acme-web', ['w1', 'w2'], 0, 1],
      ['acme-sdk', ['s1', 's2'], 0, 2],
      ['Several repositories', ['x1', 'x2'], 0, -1],
    ]);
  });
});

describe('a step’s meta line and estimate bar', () => {
  it('says what the Graph card says', () => {
    const { items } = sample();
    const meta = (id: string): string => {
      const entry = items.find((candidate) => candidate.id === id) as PlanItem;
      return stepMeta(entry, stepLook(entry, items), graphTone(entry), NOW);
    };
    expect(meta('a2')).toBe('Working · 25m');
    expect(meta('w2')).toBe('Waiting on 4, 2');
    expect(meta('a3')).toBe('Stopped — open to restart');
    expect(meta('a1')).toBe('Done · 38m');
    expect(meta('w1')).toBe('Needs you');
    expect(meta('x2')).toBe('Ready for approval');
  });

  it('shows the estimate bar only on a working step with an estimate', () => {
    const { items } = sample();
    const running = items[3] as PlanItem;
    expect(estimateBar(running, 'working', NOW)).toBeCloseTo(25 / 60, 5);
    expect(estimateBar({ ...running, estimateMinutes: null }, 'working', NOW)).toBeNull();
    expect(estimateBar(items[2] as PlanItem, 'ready', NOW)).toBeNull();
  });

  it('reuses the Graph’s critical path, and nothing while it is off', () => {
    const { items, edges } = sample();
    const path = remainingCriticalPath(items, edges, NOW);
    const marks = criticalMarks(true, items, edges, NOW);
    expect([...marks.ids]).toEqual(path.ids);
    expect([...marks.edges]).toEqual([...path.edges]);
    expect(marks.ids.size).toBeGreaterThan(0);
    const off = criticalMarks(false, items, edges, NOW);
    expect(off.ids.size + off.edges.size).toBe(0);
  });
});

describe('the timeline', () => {
  it('starts a bar after the wait for its dependencies', () => {
    expect(barSpan([])).toBeNull();
    expect(
      barSpan([
        { kind: 'dependency', from: 0, to: 10 },
        { kind: 'working', from: 10, to: 30 },
        { kind: 'projected', from: 30, to: 50 },
      ]),
    ).toEqual({ from: 10, to: 50, waitFrom: 0 });
    // Only waiting so far: the wait is the bar.
    expect(barSpan([{ kind: 'dependency', from: 5, to: 9 }])).toEqual({ from: 5, to: 9, waitFrom: null });
  });

  it('regroups the rows into the Graph’s lanes with each row’s middle', () => {
    const { items } = sample();
    const rows = items.map((entry) => ({ itemId: entry.id, repo: entry.solutions[0] ?? 'acme-api', segments: [{ kind: 'projected' as const, from: 0, to: 10 }] }));
    const { lanes, rowY, height } = timelineLanes({ groups: [{ repo: 'all', rows }] }, items, REPOS);
    expect(lanes.map((lane) => [lane.label, lane.rows.map((row) => row.itemId), lane.top])).toEqual([
      ['acme-api', ['a1', 'a2', 'a3'], 0],
      ['acme-web', ['w1', 'w2'], TIMELINE.laneHead + 3 * TIMELINE.row + TIMELINE.laneGap],
      ['acme-sdk', ['s1', 's2'], 2 * TIMELINE.laneHead + 5 * TIMELINE.row + 2 * TIMELINE.laneGap],
      ['Several repositories', ['x1', 'x2'], 3 * TIMELINE.laneHead + 7 * TIMELINE.row + 3 * TIMELINE.laneGap],
    ]);
    expect(rowY.get('a1')).toBe(TIMELINE.laneHead + TIMELINE.row / 2);
    expect(rowY.get('w2')).toBe((lanes[1]?.top ?? 0) + TIMELINE.laneHead + TIMELINE.row + TIMELINE.row / 2);
    expect(height).toBe(4 * TIMELINE.laneHead + 9 * TIMELINE.row + 3 * TIMELINE.laneGap);
  });

  it('draws an arrow from the end of a step’s bar to the start of the bar waiting on it', () => {
    const spans = new Map([
      ['a', { from: 0, to: 50 }],
      ['b', { from: 60, to: 100 }],
    ]);
    const rowY = new Map([
      ['a', 20],
      ['b', 60],
    ]);
    const arrows = timelineArrows([e('a', 'b'), e('a', 'missing'), e('a', 'a')], spans, rowY, { start: 0, end: 100 }, 200);
    expect(arrows).toHaveLength(1);
    expect(arrows[0]).toMatchObject({ key: 'a>b', x1: 100, x2: 116 });
    expect(arrows[0]?.path.startsWith('M 100 20 C')).toBe(true);
    expect(arrows[0]?.path.endsWith('116 60')).toBe(true);
  });
});
