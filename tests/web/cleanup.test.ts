import { describe, expect, it } from 'vitest';
import type { CleanupItem } from '../../src/core/cleanup.ts';
import { SETTINGS_SECTIONS, resolveSection } from '../../src/web/views/settings/model.ts';
import { ageLine, groupState, groupsOf, runSummary, selectionLine, sizeText, toggled, toggledGroup } from '../../src/web/views/settings/cleanup.ts';

function item(id: string, group: CleanupItem['group'], sizeBytes: number | null = null): CleanupItem {
  return { id, group, title: id, subtitle: '', reasons: [], sizeBytes, sizeCapped: false, lastChangeAt: null, removes: [id], keeps: [], warnings: [], confirm: null, selected: true, fingerprint: id };
}

describe('D84 · Settings → Clean-up (web)', () => {
  it('is the last Settings section', () => {
    expect(SETTINGS_SECTIONS.at(-1)).toEqual({ key: 'cleanup', label: 'Clean-up' });
    expect(resolveSection('cleanup')).toBe('cleanup');
  });

  it('groups in page order with counts and sizes; empty ones say nothing', () => {
    const views = groupsOf([item('a', 'worktrees', 2048), item('b', 'worktrees', 1024), item('c', 'localBranches')]);
    expect(views.map((view) => [view.group, view.summary])).toEqual([
      ['worktrees', '2 items · 3 KB'],
      ['localBranches', '1 item'],
      ['remoteBranches', 'nothing'],
      ['sessions', 'nothing'],
      ['data', 'nothing'],
    ]);
  });

  it('size, age and selection lines', () => {
    expect(sizeText({ sizeBytes: 5 * 1024 * 1024, sizeCapped: true })).toBe('≥ 5 MB');
    expect(sizeText({ sizeBytes: null, sizeCapped: false })).toBe('');
    expect(ageLine({ lastChangeAt: '2026-10-01T00:00:00Z' }, Date.parse('2026-10-08T00:00:00Z'))).toBe('last change 7 days ago');
    const items = [item('a', 'worktrees', 1024), item('b', 'localBranches')];
    expect(selectionLine(items, new Set())).toBe('Nothing selected');
    expect(selectionLine(items, new Set(['a', 'b']))).toBe('2 selected · 1 KB');
  });

  it('the group checkbox ticks all, unticks all, and never ticks remote branches in bulk', () => {
    const local = [item('a', 'localBranches'), item('b', 'localBranches')];
    expect(groupState(local, new Set(['a']))).toBe('some');
    expect([...toggledGroup(local, new Set(['a']))].sort()).toEqual(['a', 'b']);
    expect([...toggledGroup(local, new Set(['a', 'b']))]).toEqual([]);
    const remote = [item('r1', 'remoteBranches'), item('r2', 'remoteBranches')];
    expect([...toggledGroup(remote, new Set())]).toEqual([]);
    expect([...toggled(new Set(['r1']), 'r2')].sort()).toEqual(['r1', 'r2']);
  });

  it('the run summary while running and at the end', () => {
    const items = [
      { id: 'a', group: 'worktrees' as const, title: 'a', status: 'done' as const, error: null, sizeBytes: 2048 },
      { id: 'b', group: 'localBranches' as const, title: 'b', status: 'running' as const, error: null, sizeBytes: null },
    ];
    expect(runSummary({ items, finishedAt: null, summary: { done: 1, failed: 0, freedBytes: 2048 } })).toBe('Cleaning up… 1 of 2');
    expect(runSummary({ items, finishedAt: 'x', summary: { done: 1, failed: 1, freedBytes: 2048 } })).toBe('Removed 1 · freed 2 KB · 1 failed (nothing else was affected)');
  });
});
