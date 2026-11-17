import { describe, expect, it } from 'vitest';
import type { DiffTargets } from '../../src/core/api.ts';
import { offeredDiffScope } from '../../src/core/api.ts';
import { addReviewTurn, readSessionReview } from '../../src/core/review.ts';
import { EMPTY_REVIEW, emptyHeadFallback, emptyState, loadScope, pickedScope, saveScope, scopeOptions, scopeTitle, shownScope } from '../../src/web/views/session/diff.ts';
import { DIFF_LAYOUT_KEY, hunkStarts, loadDiffLayout, saveDiffLayout, sideBySide } from '../../src/web/views/session/side-by-side.ts';

/** D174: the For review view's choice and the side-by-side rows (`docs/worktrees.md` → *For review (D174)*, *Side by side (D174)*). */

const inPlace: DiffTargets = { worktrees: [], inPlace: [{ solution: 'mobile', branch: 'main' }] };
const withReview: DiffTargets = { ...inPlace, review: { since: '2026-11-17T10:00:00.000Z' } };
const worktree = (commits: number): DiffTargets => ({ worktrees: [{ solution: 'web', branch: 'session/x', base: 'main', commits }], inPlace: [] });

describe('D174 · the For review view', () => {
  it('is offered first only with a pending review, and shown by default then', () => {
    expect(scopeOptions(withReview)).toEqual(['review', 'head', 'repo']);
    expect(scopeOptions(inPlace)).toEqual(['head', 'repo']);
    expect(shownScope(null, withReview)).toBe('review');
    expect(shownScope(null, inPlace)).toBe('head');
    // A remembered view that is not offered falls back to For review while a review is pending.
    expect(shownScope('branch', withReview)).toBe('review');
    expect(shownScope('repo', withReview)).toBe('repo');
    // The review ended: For review is no longer offered.
    expect(shownScope('review', inPlace)).toBe('head');
    expect(scopeTitle('review', withReview)).toBe('For review');
    expect(emptyState('review', withReview)).toEqual({ text: EMPTY_REVIEW, hint: null });
  });

  it('the server offers it the same way', () => {
    expect(offeredDiffScope('review', withReview)).toBe('review');
    expect(offeredDiffScope('review', inPlace)).toBe('head');
  });

  it('during a review the tab opens on For review unless another view was picked during that review', () => {
    expect(pickedScope('repo', null, null)).toBe('repo');
    expect(pickedScope(null, null, null)).toBeNull();
    expect(pickedScope('repo', 'T1', null)).toBe('review');
    expect(pickedScope('repo', 'T1', { since: 'T1', scope: 'head' })).toBe('head');
    // A pick made during an earlier review does not hold for a new one.
    expect(pickedScope('repo', 'T2', { since: 'T1', scope: 'head' })).toBe('review');
  });

  it('For review is never remembered in the browser', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) };
    saveScope(storage, 's1', 'review');
    expect(loadScope(storage, 's1')).toBeNull();
    saveScope(storage, 's1', 'repo');
    expect(loadScope(storage, 's1')).toBe('repo');
  });

  it('an empty Since last commit with nothing picked shows Whole branch when the worktree has commits', () => {
    expect(emptyHeadFallback('head', null, [], worktree(2))).toBe('branch');
    expect(emptyHeadFallback('head', null, [], worktree(0))).toBeNull();
    expect(emptyHeadFallback('head', 'head', [], worktree(2))).toBeNull();
    expect(emptyHeadFallback('head', null, [{}], worktree(2))).toBeNull();
    expect(emptyHeadFallback('head', null, null, worktree(2))).toBeNull();
    expect(emptyHeadFallback('branch', null, [], worktree(2))).toBeNull();
  });

  it('a new review keeps where it started; a growing one keeps its first start; old stored reviews read without one', () => {
    const first = addReviewTurn(null, ['a.ts'], '2026-11-17T10:05:00.000Z', { turn: 3, startedAt: '2026-11-17T10:00:00.000Z' });
    expect(first).toEqual({ since: '2026-11-17T10:05:00.000Z', turns: 1, fileCount: 1, files: ['a.ts'], turn: 3, startedAt: '2026-11-17T10:00:00.000Z' });
    const second = addReviewTurn(first, ['b.ts'], '2026-11-17T10:09:00.000Z', { turn: 4, startedAt: '2026-11-17T10:07:00.000Z' });
    expect(second).toMatchObject({ turns: 2, fileCount: 2, turn: 3, startedAt: '2026-11-17T10:00:00.000Z' });
    expect(readSessionReview({ pending: second, cursor: 9 }).pending).toEqual(second);
    expect(readSessionReview({ pending: { since: 'x', turns: 1, fileCount: 0, files: [] }, cursor: null }).pending).toEqual({ since: 'x', turns: 1, fileCount: 0, files: [] });
    expect(readSessionReview({ pending: { since: 'x', turns: 1, fileCount: 0, files: [], turn: 0 }, cursor: null }).pending?.turn).toBeUndefined();
  });
});

describe('D174 · side by side', () => {
  it('reads the hunk starts', () => {
    expect(hunkStarts('@@ -12,5 +14,7 @@ function x()')).toEqual({ old: 12, new: 14 });
    expect(hunkStarts('@@ -1 +1,2 @@')).toEqual({ old: 1, new: 1 });
    expect(hunkStarts('not a hunk')).toBeNull();
  });

  it('context on both sides; a removed block paired row by row with the added lines; the shorter side padded', () => {
    const rows = sideBySide(['@@ -10,4 +10,5 @@', ' keep', '-old one', '-old two', '+new one', '+new two', '+new three', ' tail', '\\ No newline at end of file']);
    expect(rows).toEqual([
      { kind: 'hunk', text: '@@ -10,4 +10,5 @@' },
      { kind: 'pair', left: { no: 10, text: 'keep', tone: 'ctx' }, right: { no: 10, text: 'keep', tone: 'ctx' } },
      { kind: 'pair', left: { no: 11, text: 'old one', tone: 'del' }, right: { no: 11, text: 'new one', tone: 'add' } },
      { kind: 'pair', left: { no: 12, text: 'old two', tone: 'del' }, right: { no: 12, text: 'new two', tone: 'add' } },
      { kind: 'pair', left: { no: null, text: '', tone: 'empty' }, right: { no: 13, text: 'new three', tone: 'add' } },
      { kind: 'pair', left: { no: 13, text: 'tail', tone: 'ctx' }, right: { no: 14, text: 'tail', tone: 'ctx' } },
    ]);
  });

  it('more removed than added pads the right; a second hunk restarts the numbers; a new file is all right-hand', () => {
    const rows = sideBySide(['@@ -1,3 +1 @@', '-a', '-b', '+c', '@@ -40 +38 @@', '-x']);
    expect(rows).toEqual([
      { kind: 'hunk', text: '@@ -1,3 +1 @@' },
      { kind: 'pair', left: { no: 1, text: 'a', tone: 'del' }, right: { no: 1, text: 'c', tone: 'add' } },
      { kind: 'pair', left: { no: 2, text: 'b', tone: 'del' }, right: { no: null, text: '', tone: 'empty' } },
      { kind: 'hunk', text: '@@ -40 +38 @@' },
      { kind: 'pair', left: { no: 40, text: 'x', tone: 'del' }, right: { no: null, text: '', tone: 'empty' } },
    ]);
    expect(sideBySide(['@@ -0,0 +1,2 @@', '+one', '+two']).filter((row) => row.kind === 'pair')).toEqual([
      { kind: 'pair', left: { no: null, text: '', tone: 'empty' }, right: { no: 1, text: 'one', tone: 'add' } },
      { kind: 'pair', left: { no: null, text: '', tone: 'empty' }, right: { no: 2, text: 'two', tone: 'add' } },
    ]);
    expect(sideBySide([])).toEqual([]);
  });

  it('the layout is remembered per browser (Unified by default)', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) };
    expect(loadDiffLayout(storage)).toBe('unified');
    saveDiffLayout(storage, 'split');
    expect(map.get(DIFF_LAYOUT_KEY)).toBe('split');
    expect(loadDiffLayout(storage)).toBe('split');
    expect(loadDiffLayout(null)).toBe('unified');
  });
});
