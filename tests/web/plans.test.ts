import { describe, expect, it } from 'vitest';
import { PLAN_PICK_REPOS_REASON, type Plan, type PlanItem } from '../../src/core/plans.ts';
import { DEFAULT_PLACE, parsePlace, sidebarChoiceKey } from '../../src/web/plans/jira/place.ts';
import {
  GRAPH,
  STATE_LOOK,
  criticalEdgeKeys,
  doneText,
  durationShort,
  editHint,
  finishText,
  graphLayout,
  inlineAction,
  itemsWaitingForRepos,
  limitsChip,
  mergeModeChip,
  planStateText,
  progressText,
  refuseEdge,
  repoLine,
  runningCount,
  shortLabel,
  statusLine,
  targetChip,
  timeLeftText,
  timeline,
  timelineSummary,
  waitingText,
} from '../../src/web/plans/model.ts';

const T0 = Date.parse('2026-10-13T08:00:00.000Z');
const iso = (hours: number): string => new Date(T0 + hours * 3_600_000).toISOString();

function item(id: string, patch: Partial<PlanItem> = {}): PlanItem {
  return {
    id,
    todoId: `t-${id}`,
    key: `PROJ-${id}`,
    title: `Ticket ${id}`,
    hold: false,
    solutions: [],
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
    estimateMinutes: 60,
    actualMinutes: null,
    onCriticalPath: false,
    position: Number(id),
    startedAt: null,
    waitingSince: null,
    mergedAt: null,
    doneAt: null,
    spans: [],
    ...patch,
  };
}

function plan(items: readonly PlanItem[], edges: readonly { from: string; to: string }[], patch: Partial<Plan> = {}): Plan {
  return {
    id: 'p1',
    title: 'PROJ-100 Acme checkout',
    sourceSessionId: 's1',
    targetBranch: 'feature/PROJ-100-acme-epic',
    allowProtectedTarget: false,
    repos: ['acme'],
    baseBranch: 'dev',
    mergeMode: null,
    maxConcurrency: 3,
    usageThreshold: 85,
    answers: null,
    state: 'draft',
    external: null,
    held: null,
    pausedReason: null,
    items: items.map((entry) => ({ ...entry, dependsOn: edges.filter((edge) => edge.to === entry.id).map((edge) => edge.from) })),
    edges,
    criticalPath: { itemIds: [], minutes: 0 },
    progress: { done: items.filter((entry) => entry.state === 'done').length, total: items.length, percent: 0 },
    estimatedMinutesLeft: 180,
    createdAt: iso(0),
    updatedAt: iso(0),
    startedAt: null,
    finishedAt: null,
    machine: null,
    ...patch,
  };
}

describe('the state look', () => {
  it('maps each state to its icon and colour (the approved design)', () => {
    expect(STATE_LOOK.waiting).toEqual({ icon: '○', color: 'var(--status-idle)', word: 'waiting' });
    expect(STATE_LOOK.ready.icon).toBe('◌');
    expect(STATE_LOOK.ready.color).toBe('var(--muted-1)');
    expect(STATE_LOOK.running).toMatchObject({ icon: '●', color: 'var(--status-run)' });
    expect(STATE_LOOK.question).toMatchObject({ icon: '?', color: 'var(--status-need)' });
    expect(STATE_LOOK['ready-to-merge']).toMatchObject({ icon: '◐', color: 'oklch(0.75 0.12 310)' });
    expect(STATE_LOOK.done).toMatchObject({ icon: '✔', color: 'var(--status-done)' });
    expect(STATE_LOOK.blocked).toMatchObject({ icon: '✖', color: 'var(--status-fail)' });
  });

  it('writes the status line', () => {
    const a = item('3157', { state: 'running' });
    const b = item('3160', { state: 'done' });
    const c = item('3165', { state: 'waiting' });
    const p = plan([a, b, c], [
      { from: '3157', to: '3165' },
      { from: '3160', to: '3165' },
    ]);
    const [pa, pb, pc] = p.items as [PlanItem, PlanItem, PlanItem];
    expect(statusLine(pc, p.items)).toBe('waiting on 3157');
    expect(statusLine(pa, p.items)).toBe('running');
    expect(statusLine(pb, p.items)).toBe('done · merged');
    expect(statusLine({ ...pa, state: 'question' }, p.items)).toBe('needs your answer');
    expect(statusLine({ ...pa, state: 'ready-to-merge' }, p.items)).toBe('waiting for your merge');
    expect(statusLine({ ...pa, state: 'blocked' }, p.items)).toBe('blocked');
    expect(waitingText(pc, p.items)).toBe('Starts by itself when 3157 is done.');
    expect(waitingText({ ...pc }, p.items.map((entry) => (entry.id === '3160' ? { ...entry, state: 'running' as const } : entry)))).toBe('Starts by itself when 3157 and 3160 are done.');
  });

  it('shortens keys only when every key shares one prefix', () => {
    expect(shortLabel(item('1'), [item('1'), item('2')])).toBe('1');
    expect(shortLabel(item('1'), [item('1'), { key: 'ACME-9' }])).toBe('PROJ-1');
    expect(shortLabel({ key: null, title: 'A rather long title for a todo item' }, [])).toBe('A rather long title for…');
  });
});

describe('header texts', () => {
  it('formats the chips and progress', () => {
    const p = plan([item('1', { state: 'done', hold: true }), item('2', { hold: true })], [], { mergeMode: 'agents-with-holds', progress: { done: 1, total: 2, percent: 50 } });
    expect(progressText(p)).toBe('1/2 done');
    expect(timeLeftText(p)).toBe('~3h left');
    expect(timeLeftText({ estimatedMinutesLeft: null })).toBeNull();
    expect(mergeModeChip(p)).toBe('Merge: agents · hold ⚑ 1, 2');
    expect(mergeModeChip({ ...p, mergeMode: 'developer' })).toBe('Merge: I merge each one');
    expect(mergeModeChip({ ...p, mergeMode: null })).toBe('Merge mode: not chosen yet');
    expect(mergeModeChip({ ...p, mergeMode: 'agents' })).toBe('Merge: agents');
    expect(limitsChip(p)).toBe('3 at once · 85 %');
    expect(targetChip(p)).toBe('⎇ feature/PROJ-100-acme-epic → dev');
    // D99 follow-up 2026-10-15: no merge step, an acknowledged protected target, the target as the base.
    expect(targetChip({ ...p, targetBranch: null, mergeMode: null })).toBe('No merge step');
    expect(targetChip({ ...p, mergeMode: 'none' })).toBe('No merge step');
    expect(targetChip({ ...p, targetBranch: 'dev', mergeMode: 'agents', allowProtectedTarget: true })).toBe('⎇ dev (agents merge — acknowledged)');
    expect(targetChip({ ...p, targetBranch: 'dev', mergeMode: 'developer' })).toBe('⎇ dev');
    expect(mergeModeChip({ ...p, targetBranch: null, mergeMode: null })).toBe('No merge step');
    expect(mergeModeChip({ ...p, mergeMode: 'none' })).toBe('No merge step · confirm ⚑ 1, 2');
    expect(repoLine(item('1', { estimateMinutes: 45 }), p)).toBe('acme · ~45m');
    expect(repoLine(item('1', { estimateMinutes: null }), { repos: ['a', 'b'] })).toBe('all repos · ~?');
    expect(durationShort(150)).toBe('2.5h');
    expect(durationShort(60 * 30)).toBe('30h');
    expect(durationShort(60 * 50)).toBe('2d 2h');
    expect(runningCount([{ state: 'running' }, { state: 'paused' }, { state: 'running' }])).toBe(2);
    expect(planStateText({ state: 'paused', held: 'the plan is paused', pausedReason: 'Plans was switched off' })).toBe('paused · Plans was switched off');
    expect(planStateText({ state: 'paused', held: 'the plan is paused', pausedReason: null })).toBe('paused');
    expect(planStateText({ state: 'running', held: 'acme is at 91% of its 5-hour limit', pausedReason: null })).toBe('running · held: acme is at 91% of its 5-hour limit');
  });

  it('writes the detail lines', () => {
    expect(doneText({ checks: { state: 'green', summary: null, sha: null }, note: null }, { targetBranch: 'epic/x' })).toBe('Merged into epic/x · checks ✔');
    expect(doneText({ checks: { state: 'red', summary: 'failed: ci', sha: null }, note: null }, { targetBranch: 'epic/x' })).toBe('Merged into epic/x · checks ✖');
    expect(inlineAction({ state: 'question' })).toBe('answer');
    expect(inlineAction({ state: 'ready-to-merge' })).toBe('merge');
    expect(inlineAction({ state: 'running' })).toBeNull();
  });
});

describe('graph layout', () => {
  it('puts each item one layer right of its furthest dependency', () => {
    // 1 → 2 → 4, 1 → 3, 3 → 4, 5 alone.
    const items = ['1', '2', '3', '4', '5'].map((id) => item(id));
    const edges = [
      { from: '1', to: '2' },
      { from: '2', to: '4' },
      { from: '1', to: '3' },
      { from: '3', to: '4' },
    ];
    const layout = graphLayout(items, edges);
    const layer = Object.fromEntries(layout.nodes.map((node) => [node.id, node.layer]));
    expect(layer).toEqual({ '1': 0, '5': 0, '2': 1, '3': 1, '4': 2 });
    expect(layout.final.layer).toBe(3);
    expect(layout.sinks).toEqual(['4', '5']);
    const one = layout.nodes.find((node) => node.id === '1');
    const four = layout.nodes.find((node) => node.id === '4');
    expect(one?.x).toBe(GRAPH.pad);
    expect(four?.x).toBe(GRAPH.pad + 2 * (GRAPH.cardWidth + GRAPH.gapX));
    expect(layout.width).toBe(GRAPH.pad * 2 + 4 * GRAPH.cardWidth + 3 * GRAPH.gapX);
    expect(layout.height).toBe(GRAPH.pad * 2 + 2 * GRAPH.cardHeight + GRAPH.gapY);
  });

  it('uses the longest path, not the shortest', () => {
    const items = ['1', '2', '3'].map((id) => item(id));
    const layout = graphLayout(items, [
      { from: '1', to: '2' },
      { from: '2', to: '3' },
      { from: '1', to: '3' },
    ]);
    expect(layout.nodes.find((node) => node.id === '3')?.layer).toBe(2);
  });

  it('orders a layer by the rows of its dependencies', () => {
    const items = ['1', '2', '3', '4'].map((id) => item(id));
    // 4 depends on 1 (row 0), 3 depends on 2 (row 1): 4 above 3.
    const layout = graphLayout(items, [
      { from: '2', to: '3' },
      { from: '1', to: '4' },
    ]);
    const row = Object.fromEntries(layout.nodes.map((node) => [node.id, node.row]));
    expect(row['4']).toBe(0);
    expect(row['3']).toBe(1);
  });

  it('lists the critical path edges', () => {
    expect([...criticalEdgeKeys({ criticalPath: { itemIds: ['1', '2', '4'], minutes: 90 } })]).toEqual(['1>2', '2>4']);
  });
});

describe('dependency editing', () => {
  const p = plan([item('1'), item('2'), item('3')], [
    { from: '1', to: '2' },
    { from: '2', to: '3' },
  ]);

  it('refuses a cycle with the design text', () => {
    // "3 after... 1 after 3": from 3 to 1 closes 1 → 2 → 3 → 1.
    expect(refuseEdge(p, '3', '1')).toBe('Refused: 3 already waits on 1 — that would be a loop');
    expect(refuseEdge(p, '1', '3')).toBeNull();
    expect(refuseEdge(p, '1', '2')).toBe('Refused: 2 already waits on 1');
    expect(refuseEdge(p, '1', '1')).toBe('Refused: a ticket cannot wait on itself');
  });

  it('writes the hint', () => {
    expect(editHint(null, p.items)).toContain('Click the ticket that must finish first.');
    expect(editHint(p.items[0] as PlanItem, p.items)).toContain('Now click the ticket that depends on 1…');
  });
});

describe('timeline', () => {
  it('builds the segments from the timestamps and projects the rest', () => {
    const now = T0 + 5 * 3_600_000;
    const a = item('1', { state: 'done', storedState: 'done', startedAt: iso(0), mergedAt: iso(2), doneAt: iso(2), solutions: ['acme'] });
    const b = item('2', { state: 'ready-to-merge', storedState: 'running', startedAt: iso(2), waitingOn: 'merge', waitingSince: iso(3), solutions: ['acme'], estimateMinutes: 120 });
    const c = item('3', { state: 'waiting', solutions: ['billing'], estimateMinutes: 60 });
    const p = plan([a, b, c], [
      { from: '1', to: '2' },
      { from: '2', to: '3' },
    ], { state: 'running', startedAt: iso(0), repos: ['acme', 'billing'] });
    const view = timeline(p, now);
    expect(view.groups.map((group) => group.repo)).toEqual(['acme', 'billing']);
    const rowOf = (id: string) => view.groups.flatMap((group) => group.rows).find((row) => row.itemId === id);
    expect(rowOf('1')?.segments).toEqual([{ kind: 'working', from: T0, to: T0 + 2 * 3_600_000 }]);
    const second = rowOf('2')?.segments ?? [];
    expect(second.map((segment) => segment.kind)).toEqual(['dependency', 'working', 'you', 'projected']);
    expect(second[2]).toMatchObject({ from: T0 + 3 * 3_600_000, to: now, on: 'merge' });
    const third = rowOf('3')?.segments ?? [];
    expect(third.map((segment) => segment.kind)).toEqual(['dependency', 'projected']);
    // 2's estimate (2 h) ran out: at least a minute is left; 3 is projected after it for its hour.
    expect(third[1]?.from).toBe(second[3]?.to);
    expect(view.youHours).toBe(2);
    expect(view.totalHours).toBe(5);
    expect(view.longest).toMatchObject({ itemId: '2', on: 'merge', hours: 2 });
    expect(view.projectedFinish).toBe((third[1]?.from ?? 0) + 3_600_000);
    expect(timelineSummary(view, p)).toMatch(/^Waiting on you: 2 h of 5 · longest: 2 merge \(2 h\) · Projected finish: /);
  });

  it('shows a ready item held for usage in red', () => {
    const now = T0 + 3_600_000;
    const p = plan([item('1', { state: 'ready' })], [], { state: 'running', startedAt: iso(0), held: 'acme is at 90 % of its 5-hour limit' });
    const segments = timeline(p, now).groups[0]?.rows[0]?.segments ?? [];
    expect(segments.map((segment) => segment.kind)).toEqual(['usage', 'projected']);
  });

  it('names the finish day', () => {
    const now = new Date(2026, 9, 13, 18, 0).getTime();
    expect(finishText(new Date(2026, 9, 13, 20, 5).getTime(), now)).toBe('today 20:05');
    expect(finishText(new Date(2026, 9, 14, 7, 30).getTime(), now)).toBe('tomorrow 07:30');
    expect(finishText(new Date(2026, 9, 16, 9, 0).getTime(), now)).toMatch(/16 Oct 09:00$/);
  });
});

describe('timeline of a blocked item', () => {
  it('shows its work up to now and projects nothing', () => {
    const now = T0 + 2 * 3_600_000;
    const p = plan([item('1', { state: 'blocked', storedState: 'failed', startedAt: iso(0), reason: 'was discarded' })], [], { state: 'running', startedAt: iso(0) });
    const segments = timeline(p, now).groups[0]?.rows[0]?.segments ?? [];
    expect(segments.map((segment) => segment.kind)).toEqual(['working']);
    expect(timeline(p, now).projectedFinish).toBeNull();
  });
});

describe('timeline from the history (PlanItem.spans)', () => {
  it('maps every span kind to its segment, draws an open span to now and sums every wait on you', () => {
    const now = T0 + 10 * 3_600_000;
    const a = item('1', {
      state: 'done',
      storedState: 'done',
      developerMerges: true,
      startedAt: iso(0),
      mergedAt: iso(6),
      doneAt: iso(6),
      spans: [
        { kind: 'running', startedAt: iso(0), endedAt: iso(1) },
        { kind: 'waiting-you', startedAt: iso(1), endedAt: iso(2) },
        { kind: 'running', startedAt: iso(2), endedAt: iso(3) },
        { kind: 'waiting-you', startedAt: iso(3), endedAt: iso(6) },
      ],
    });
    const b = item('2', {
      state: 'question',
      storedState: 'running',
      startedAt: iso(6),
      spans: [
        { kind: 'waiting-dependency', startedAt: iso(0), endedAt: iso(5) },
        { kind: 'paused-usage', startedAt: iso(5), endedAt: iso(5.5) },
        { kind: 'paused-plan', startedAt: iso(5.5), endedAt: iso(6) },
        { kind: 'running', startedAt: iso(6), endedAt: iso(8) },
        { kind: 'waiting-you', startedAt: iso(8), endedAt: null },
      ],
    });
    const p = plan([a, b], [{ from: '1', to: '2' }], { state: 'running', startedAt: iso(0) });
    const view = timeline(p, now);
    const rows = view.groups.flatMap((group) => group.rows);
    expect(rows[0]?.segments.map((segment) => segment.kind)).toEqual(['working', 'you', 'working', 'you']);
    expect(rows[1]?.segments.map((segment) => segment.kind)).toEqual(['dependency', 'usage', 'paused', 'working', 'you', 'projected']);
    expect(rows[1]?.segments[2]?.note).toBe('plan paused');
    expect(rows[1]?.segments[4]).toMatchObject({ from: T0 + 8 * 3_600_000, to: now, on: 'question' });
    // 1 + 3 + 2 hours waiting on you; the longest single wait is 1's merge (3 h).
    expect(view.youHours).toBe(6);
    expect(view.totalHours).toBe(10);
    expect(view.longest).toMatchObject({ itemId: '1', on: 'merge', hours: 3 });
    expect(timelineSummary(view, p)).toMatch(/^Waiting on you: 6 h of 10 · longest: 1 merge \(3 h\) · Projected finish: /);
  });

  it('names an open paused-plan span after the plan\'s reason', () => {
    const p = plan([item('1', { state: 'waiting', spans: [{ kind: 'paused-plan', startedAt: iso(0), endedAt: null }] })], [], { state: 'paused', startedAt: iso(0), pausedReason: 'Plans was switched off' });
    const segment = timeline(p, T0 + 3_600_000).groups[0]?.rows[0]?.segments[0];
    expect(segment).toMatchObject({ kind: 'paused', note: 'Plans was switched off' });
  });
});

describe('D115 · items waiting for the plan\'s agent to pick repositories', () => {
  it('shows the wait on the card, in the detail and in the repo line; lists the waiting items', () => {
    const waiting = item('1', { state: 'waiting', reason: PLAN_PICK_REPOS_REASON });
    const picked = item('2', { state: 'ready', solutions: ['web-front'] });
    const p = plan([waiting, picked], [], { repos: ['web-front'], reposPerItem: true });
    expect(statusLine(waiting, p.items)).toBe('waiting for repositories');
    expect(waitingText(waiting, p.items)).toContain(PLAN_PICK_REPOS_REASON);
    expect(repoLine(waiting, p)).toBe('no repos yet · ~1h');
    expect(repoLine(picked, p)).toBe('web-front · ~1h');
    expect(itemsWaitingForRepos(p).map((entry) => entry.id)).toEqual(['1']);
    // A plan with repos of its own (or an older machine's, without the field) has none waiting.
    expect(itemsWaitingForRepos(plan([waiting], []))).toEqual([]);
  });
});

describe('D112 · the last Jira import\'s place', () => {
  it('reads what was kept and falls back field by field', () => {
    expect(parsePlace(null)).toEqual(DEFAULT_PLACE);
    expect(parsePlace('not json')).toEqual(DEFAULT_PLACE);
    expect(parsePlace('[]')).toEqual(DEFAULT_PLACE);
    const kept = { machine: 'm2', folder: 'f1', provider: 'codex', model: { model: 'gpt-x', effort: 'high' }, profileId: 'p1', repos: ['mobile', 'mobile', 'web-front'], baseBranch: 'main' };
    expect(parsePlace(JSON.stringify(kept))).toEqual({ ...kept, repos: ['mobile', 'web-front'], sidebarFolders: {} });
    expect(parsePlace(JSON.stringify({ provider: 'nope', model: 'x', repos: 'mobile', baseBranch: '' }))).toEqual(DEFAULT_PLACE);
  });

  it('D119: keeps the last sidebar folder per working folder (a folder id or null = the root)', () => {
    const kept = { sidebarFolders: { [sidebarChoiceKey(null, 'f1')]: 'sf1', [sidebarChoiceKey('m2', 'f1')]: null, bad: 7, empty: '' } };
    expect(parsePlace(JSON.stringify(kept)).sidebarFolders).toEqual({ '|f1': 'sf1', 'm2|f1': null });
    expect(parsePlace(JSON.stringify({ sidebarFolders: [] })).sidebarFolders).toEqual({});
  });
});
