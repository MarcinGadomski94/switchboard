import { describe, expect, it } from 'vitest';
import type { BranchingPreflightRow } from '../../src/core/api.ts';
import {
  DEFAULT_BRANCHING,
  branchingBlocks,
  branchingFromPrefill,
  branchingWarnings,
  formEpicBranch,
  preflightCells,
  preflightKey,
  preflightRequest,
  prTargetCell,
  formParent,
  parentFromTaskShown,
  stackedCells,
  stackedParent,
  toBranching,
  withBranchingLines,
} from '../../src/web/modals/branching-form.ts';
import type { SummaryLine } from '../../src/web/modals/new-session.ts';

/** D40: the New-session form's Branching section logic (`src/web/modals/branching-form.ts`). */

const EPIC = 'feature/PROJ-3010-Platform-tracking-and-KPI-delivery-process-development';
const withEpic = { ...DEFAULT_BRANCHING, epicKey: 'PROJ-3010', epicSummary: 'Platform tracking and KPI delivery process development' };

function row(overrides: Partial<BranchingPreflightRow>): BranchingPreflightRow {
  return {
    solution: 'web-front',
    repoPath: '/w/web-front',
    error: null,
    base: 'dev',
    baseSource: 'epic',
    baseExists: true,
    epic: { branch: EPIC, exists: false, behind: null },
    task: { branch: 'PROJ-3011-kpi', exists: false, local: false },
    cutFrom: 'origin/dev',
    ...overrides,
  };
}

describe('Branching section (D40)', () => {
  it('derives the epic branch until it is typed; the request carries it and the overrides', () => {
    expect(formEpicBranch(withEpic)).toBe(EPIC);
    expect(formEpicBranch({ ...withEpic, epicBranch: 'feature/custom' })).toBe('feature/custom');
    const request = preflightRequest({ ...withEpic, choices: { mobile: { base: 'main' } } }, 'f1', ['web-front', 'mobile'], 'PROJ-3011-kpi');
    expect(request).toEqual({ folder: 'f1', solutions: ['web-front', 'mobile'], epicBranch: EPIC, base: 'dev', taskBranch: 'PROJ-3011-kpi', bases: { mobile: 'main' } });
    // No solutions (D38), or a field not valid yet: nothing to check.
    expect(preflightRequest(withEpic, 'f1', [], 'x')).toBeNull();
    expect(preflightRequest({ ...withEpic, epicKey: 'proj' }, 'f1', ['web-front'], 'x')).toBeNull();
    // The task branch does not start a new check by itself.
    expect(preflightKey(request)).toBe(preflightKey(request && { ...request, taskBranch: 'PROJ-9-other' }));
    expect(preflightRequest(DEFAULT_BRANCHING, null, ['web-front'], '')).toMatchObject({ epicBranch: null, taskBranch: null });
  });

  it('a missing base keeps Start disabled until the repo is dropped or gets another base', () => {
    const rows = [row({}), row({ solution: 'mobile', baseExists: false, cutFrom: null })];
    expect(branchingWarnings(withEpic, ['web-front', 'mobile'], rows)).toEqual(['⚠ mobile: origin/dev is missing: drop it or use another base']);
    expect(branchingBlocks({ ...withEpic, choices: { mobile: { drop: true } } }, ['web-front', 'mobile'], rows)).toBe(false);
    expect(branchingBlocks(withEpic, ['web-front', 'mobile'], null)).toBe(false);
    // The epic on origin: the base is not needed.
    expect(branchingBlocks(withEpic, ['mobile'], [row({ solution: 'mobile', baseExists: false, epic: { branch: EPIC, exists: true, behind: null }, cutFrom: `origin/${EPIC}` })])).toBe(false);
    expect(branchingWarnings({ ...withEpic, choices: { 'web-front': { drop: true } } }, ['web-front'], null)).toEqual(['⚠ every solution is dropped']);
    expect(branchingWarnings({ ...withEpic, epicKey: 'epic', base: 'a..b' }, [], null)).toEqual(['⚠ the epic key must be a ticket key, e.g. PROJ-3010', '⚠ the epic base is not a valid git branch name']);
  });

  it('posts the epic, base, overrides and drops of picked solutions only', () => {
    const form = { ...withEpic, choices: { mobile: { drop: true as const }, nugets: { base: 'main' }, gone: { drop: true as const } } };
    expect(toBranching(form, ['web-front', 'mobile', 'nugets'])).toEqual({
      epic: { key: 'PROJ-3010', summary: 'Platform tracking and KPI delivery process development', branch: EPIC },
      base: 'dev',
      bases: { nugets: 'main' },
      dropped: ['mobile'],
    });
    expect(toBranching(DEFAULT_BRANCHING, ['web-front'])).toEqual({ epic: null, base: 'dev' });
    expect(branchingFromPrefill({ branching: { epic: { key: 'proj-1', summary: 'S' }, base: 'develop' } })).toMatchObject({ epicKey: 'PROJ-1', epicSummary: 'S', base: 'develop', epicBranch: null });
  });

  it('adds the epic, base and dropped lines under the branch line, drops the dropped worktree folders, warns before the ✓', () => {
    const lines: SummaryLine[] = [
      { text: '# worktrees', tone: 'comment' },
      { text: 'branch    PROJ-3011-kpi', tone: 'value' },
      { text: '../web-front-wt-kpi', tone: 'path' },
      { text: '../mobile-wt-kpi', tone: 'path' },
      { text: ' ', tone: 'value' },
      { text: '✓ answers pre-filled → agent confirms, no re-ask', tone: 'ok' },
    ];
    const out = withBranchingLines(lines, { ...withEpic, choices: { mobile: { drop: true } } }, ['web-front', 'mobile', 'nugets'], (s) => `../${s}-wt-kpi`, [row({ solution: 'nugets', baseExists: false, cutFrom: null })]);
    expect(out.map((line) => line.text)).toEqual([
      '# worktrees',
      'branch    PROJ-3011-kpi',
      `epic      ${EPIC}`,
      'base      origin/dev',
      'dropped   mobile',
      '../web-front-wt-kpi',
      '⚠ nugets: origin/dev is missing: drop it or use another base',
      ' ',
      '✓ answers pre-filled → agent confirms, no re-ask',
    ]);
    // No epic, no choices: unchanged.
    expect(withBranchingLines(lines, DEFAULT_BRANCHING, ['web-front'], (s) => s, null)).toEqual(lines);
  });

  it('shows each row: base, epic with its behind count, task on origin / local / new, errors', () => {
    expect(preflightCells(row({ epic: { branch: EPIC, exists: true, behind: 3 }, task: { branch: 'x', exists: true, local: false } }))).toEqual({
      base: { text: '✓ origin/dev', tone: 'ok' },
      epic: { text: '✓ on origin · 3 behind', tone: 'ok' },
      task: { text: '✓ on origin (reused)', tone: 'ok' },
    });
    expect(preflightCells(row({ baseExists: false, task: { branch: 'x', exists: false, local: true } }))).toMatchObject({ base: { text: '⚠ no origin/dev', tone: 'warn' }, task: { text: '✓ local (reused)' } });
    expect(preflightCells(row({ error: 'no origin remote: x', baseExists: null }))).toEqual({ base: { text: 'no origin remote: x', tone: 'muted' }, epic: null, task: null });
    expect(preflightCells(row({ base: null, baseExists: false, epic: null, baseSource: 'default' })).base).toEqual({ text: '⚠ no origin default branch', tone: 'warn' });
  });
});

const PARENT = 'PROJ-3013-configure-hubspot-opt-in-cookie-banner-across-both-domains';

describe('Parent (D47)', () => {
  it('follows the task text until typed; typed (even empty) is never overwritten', () => {
    const task = 'Add the KPI events; create it from PROJ-3013.';
    expect(formParent(DEFAULT_BRANCHING, task)).toBe('PROJ-3013');
    expect(parentFromTaskShown(DEFAULT_BRANCHING, task)).toBe(true);
    expect(formParent({ ...DEFAULT_BRANCHING, parent: 'PROJ-2000' }, task)).toBe('PROJ-2000');
    expect(formParent({ ...DEFAULT_BRANCHING, parent: '' }, task)).toBe('');
    expect(parentFromTaskShown({ ...DEFAULT_BRANCHING, parent: '' }, task)).toBe(false);
    expect(formParent(DEFAULT_BRANCHING, 'Add the KPI events.')).toBe('');
  });

  it('the stacked parent: normalized; the epic branch itself or empty = not stacked', () => {
    expect(stackedParent({ ...withEpic, parent: 'proj-3013' })).toBe('PROJ-3013');
    expect(stackedParent({ ...withEpic, parent: `origin/${PARENT}` })).toBe(PARENT);
    expect(stackedParent({ ...withEpic, parent: EPIC })).toBeNull();
    expect(stackedParent({ ...withEpic, parent: '' })).toBeNull();
    expect(stackedParent({ ...DEFAULT_BRANCHING, parent: 'PROJ-3013' })).toBe('PROJ-3013');
  });

  it('goes into the request (and its key), the posted branching and the summary; problems block Start', () => {
    const form = { ...withEpic, parent: 'PROJ-3013' };
    const request = preflightRequest(form, 'f1', ['web-front'], 'PROJ-3014-kpi');
    expect(request).toMatchObject({ parent: 'PROJ-3013' });
    expect(preflightKey(request)).not.toBe(preflightKey(preflightRequest(withEpic, 'f1', ['web-front'], 'PROJ-3014-kpi')));
    expect(toBranching(form, ['web-front'])).toEqual({ epic: { key: 'PROJ-3010', summary: 'Platform tracking and KPI delivery process development', branch: EPIC }, base: 'dev', parent: 'PROJ-3013' });
    expect(toBranching(withEpic, ['web-front'])).not.toHaveProperty('parent');
    const lines = withBranchingLines([{ text: 'branch    PROJ-3014-kpi', tone: 'value' }, { text: ' ', tone: 'value' }, { text: '✓', tone: 'ok' }], form, ['web-front'], (x) => x, null, 'PROJ-3014-kpi');
    expect(lines.map((line) => line.text)).toContain('parent    PROJ-3013 (stacked)');
    // A bad name, the task's own key: warnings (Start disabled); the request waits.
    expect(branchingWarnings({ ...withEpic, parent: 'a..b' }, ['web-front'], null)).toEqual(['⚠ the parent must be a task key (e.g. PROJ-3013) or a valid git branch name']);
    expect(branchingBlocks({ ...withEpic, parent: 'PROJ-3014' }, ['web-front'], null, 'PROJ-3014-kpi')).toBe(true);
    expect(preflightRequest({ ...withEpic, parent: 'a..b' }, 'f1', ['web-front'], 'x')).toBeNull();
  });

  it('a key naming several branches in a repo blocks Start; a merged parent only warns in its cell', () => {
    const ambiguous = row({ parent: { typed: 'PROJ-3013', branch: null, matches: ['PROJ-3013-a', 'PROJ-3013-b'], error: 'PROJ-3013 matches 2 branches on origin (PROJ-3013-a, PROJ-3013-b): type the parent\'s full branch name', pr: null, noPr: false, prError: null }, cutFrom: null, prTarget: null });
    const form = { ...withEpic, parent: 'PROJ-3013' };
    expect(branchingWarnings(form, ['web-front'], [ambiguous])).toEqual([`⚠ web-front: ${ambiguous.parent?.error}`]);
    const merged = row({ cutFrom: `origin/${PARENT}`, prTarget: PARENT, parent: { typed: 'PROJ-3013', branch: PARENT, matches: [PARENT], error: null, pr: { number: 306, state: 'MERGED', url: null, baseRefName: EPIC }, noPr: false, prError: null } });
    expect(branchingBlocks(form, ['web-front'], [merged])).toBe(false);
    expect(stackedCells(merged)).toEqual({
      resolved: { text: `origin/${PARENT}`, tone: 'ok' },
      target: { text: PARENT, tone: 'muted' },
      status: { text: '⚠ PR #306 merged · parent merged — base on its target instead', tone: 'warn' },
    });
    expect(stackedCells(ambiguous)?.resolved).toEqual({ text: `⚠ ${ambiguous.parent?.error}`, tone: 'warn' });
  });

  it('stacked cells: parent not in repo (epic not created yet), open PR, no PR; none when not stacked', () => {
    const missing = row({ cutFrom: 'origin/dev', prTarget: EPIC, parent: { typed: 'PROJ-3013', branch: null, matches: [], error: null, pr: null, noPr: false, prError: null } });
    expect(stackedCells(missing)).toEqual({
      resolved: { text: 'origin/dev (epic not created yet; parent not in repo)', tone: 'muted' },
      target: { text: `${EPIC} (epic, created lazily)`, tone: 'muted' },
      status: { text: '— parent not in repo', tone: 'muted' },
    });
    const open = row({ cutFrom: `origin/${PARENT}`, prTarget: PARENT, parent: { typed: PARENT, branch: PARENT, matches: [PARENT], error: null, pr: { number: 1080, state: 'OPEN', url: null, baseRefName: EPIC }, noPr: false, prError: null } });
    expect(stackedCells(open)?.status).toEqual({ text: '✓ PR #1080 open', tone: 'ok' });
    expect(stackedCells(row({ cutFrom: `origin/${PARENT}`, prTarget: PARENT, parent: { typed: PARENT, branch: PARENT, matches: [PARENT], error: null, pr: null, noPr: true, prError: null } }))?.status).toEqual({ text: 'no PR', tone: 'muted' });
    expect(stackedCells(row({}))).toBeNull();
  });

  it('ruling D47-columns: the PR target cell of every row, stacked or not', () => {
    expect(prTargetCell(row({ prTarget: EPIC }))).toEqual({ text: `${EPIC} (epic, created lazily)`, tone: 'muted' });
    expect(prTargetCell(row({ prTarget: EPIC, epic: { branch: EPIC, exists: true, behind: 0 } }))).toEqual({ text: `${EPIC} (epic)`, tone: 'muted' });
    expect(prTargetCell(row({ epic: null, prTarget: 'master' }))).toEqual({ text: 'master', tone: 'muted' });
    expect(prTargetCell(row({ prTarget: null, cutFrom: null }))).toEqual({ text: '—', tone: 'muted' });
    expect(prTargetCell(row({ error: 'no origin remote: x' }))).toBeNull();
  });
});
