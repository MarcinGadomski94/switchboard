import { describe, expect, it } from 'vitest';
import type { SidebarLayout } from '../../src/core/sidebar-layout.ts';
import { folderSideOf, indicatorOf, resolveDrop, sameOver, sideOf } from '../../src/web/shell/sidebar-dnd.ts';

/** D54 oracle: what a drop in SESSIONS writes, and how the target shows it (src/web/shell/sidebar-dnd.ts). */

const layout: SidebarLayout = {
  pinned: ['p1', 'p2'],
  folders: [
    { id: 'fa', name: 'Alpha', collapsed: false, sessionIds: ['a1', 'a2'] },
    { id: 'fb', name: 'Beta', collapsed: false, sessionIds: [] },
  ],
};

const session = (id: string) => ({ kind: 'session', id }) as const;
const folder = (id: string) => ({ kind: 'folder', id }) as const;

describe('resolveDrop', () => {
  it('a session on a pinned row: pinned before / after it', () => {
    expect(resolveDrop(layout, session('x'), { zone: 'row', group: { kind: 'pinned' }, sessionId: 'p2', side: 'before' })).toEqual({ kind: 'place', input: { sessionId: 'x', place: 'pinned', index: 1 } });
    expect(resolveDrop(layout, session('p1'), { zone: 'row', group: { kind: 'pinned' }, sessionId: 'p2', side: 'after' })).toEqual({ kind: 'place', input: { sessionId: 'p1', place: 'pinned', index: 1 } });
  });

  it('a session on the Pinned label: pinned first', () => {
    expect(resolveDrop(layout, session('x'), { zone: 'pinned-head' })).toEqual({ kind: 'place', input: { sessionId: 'x', place: 'pinned', index: 0 } });
  });

  it('a session on a folder head goes into it, at its end; on a folder row, before / after that row', () => {
    expect(resolveDrop(layout, session('p1'), { zone: 'folder-head', folderId: 'fa', side: 'before' })).toEqual({ kind: 'place', input: { sessionId: 'p1', place: 'folder', folderId: 'fa', index: 2 } });
    expect(resolveDrop(layout, session('a1'), { zone: 'folder-head', folderId: 'fa', side: 'after' })).toEqual({ kind: 'place', input: { sessionId: 'a1', place: 'folder', folderId: 'fa', index: 1 } });
    expect(resolveDrop(layout, session('x'), { zone: 'row', group: { kind: 'folder', folderId: 'fa' }, sessionId: 'a1', side: 'after' })).toEqual({ kind: 'place', input: { sessionId: 'x', place: 'folder', folderId: 'fa', index: 1 } });
  });

  it('a placed session dropped on the "take out" zone leaves its place (unplaced); a loose one there does nothing', () => {
    expect(resolveDrop(layout, session('a2'), { zone: 'loose' })).toEqual({ kind: 'place', input: { sessionId: 'a2', place: 'loose' } });
    expect(resolveDrop(layout, session('n2'), { zone: 'loose' })).toBeNull();
  });

  it('D71: a session dropped before / after a loose row goes to that position of the whole loose list (unplaced first, then the loose order)', () => {
    const listed = ['n1', 'n2', 'n3', 'o1', 'o2'];
    const withLoose: SidebarLayout = { ...layout, loose: ['o1', 'gone', 'o2'] };
    // The whole loose list: n1, n2, n3 (unplaced, service order), then o1, gone (hidden), o2.
    expect(resolveDrop(withLoose, session('p1'), { zone: 'row', group: { kind: 'loose' }, sessionId: 'n1', side: 'before' }, listed)).toEqual({ kind: 'place', input: { sessionId: 'p1', place: 'loose', index: 0 } });
    expect(resolveDrop(withLoose, session('n1'), { zone: 'row', group: { kind: 'loose' }, sessionId: 'o2', side: 'after' }, listed)).toEqual({ kind: 'place', input: { sessionId: 'n1', place: 'loose', index: 5 } });
    expect(resolveDrop(withLoose, session('o2'), { zone: 'row', group: { kind: 'loose' }, sessionId: 'n2', side: 'before' }, listed)).toEqual({ kind: 'place', input: { sessionId: 'o2', place: 'loose', index: 1 } });
    // On itself: nothing.
    expect(resolveDrop(withLoose, session('n2'), { zone: 'row', group: { kind: 'loose' }, sessionId: 'n2', side: 'before' }, listed)).toBeNull();
    // A line before / after the loose row (a subfolder dropped there still goes to the top level, highlighted).
    expect(indicatorOf(withLoose, session('o2'), { zone: 'row', group: { kind: 'loose' }, sessionId: 'n2', side: 'before' }, listed)).toBe('before');
    expect(indicatorOf(withLoose, session('o2'), { zone: 'row', group: { kind: 'loose' }, sessionId: 'n2', side: 'after' }, listed)).toBe('after');
  });

  it('a folder moves among the folders (D58: and into them) only', () => {
    expect(resolveDrop(layout, folder('fb'), { zone: 'folder-head', folderId: 'fa', side: 'before' })).toEqual({ kind: 'move-folder', folderId: 'fb', index: 0, parentId: null });
    expect(resolveDrop(layout, folder('fa'), { zone: 'folder-head', folderId: 'fb', side: 'after' })).toEqual({ kind: 'move-folder', folderId: 'fa', index: 1, parentId: null });
    expect(resolveDrop(layout, folder('fa'), { zone: 'pinned-head' })).toBeNull();
    expect(resolveDrop(layout, folder('fa'), { zone: 'row', group: { kind: 'pinned' }, sessionId: 'p1', side: 'before' })).toBeNull();
  });

  it('an unknown folder does nothing', () => {
    expect(resolveDrop(layout, session('x'), { zone: 'folder-head', folderId: 'gone', side: 'before' })).toBeNull();
  });
});

describe('indicatorOf', () => {
  it('a line on rows and between folders; "into" for a folder head, the Pinned label and the loose zone; none when nothing happens', () => {
    expect(indicatorOf(layout, session('x'), { zone: 'row', group: { kind: 'pinned' }, sessionId: 'p1', side: 'after' })).toBe('after');
    expect(indicatorOf(layout, session('x'), { zone: 'folder-head', folderId: 'fa', side: 'before' })).toBe('into');
    expect(indicatorOf(layout, folder('fb'), { zone: 'folder-head', folderId: 'fa', side: 'before' })).toBe('before');
    expect(indicatorOf(layout, session('x'), { zone: 'pinned-head' })).toBe('into');
    expect(indicatorOf(layout, session('p1'), { zone: 'loose' })).toBe('into');
    expect(indicatorOf(layout, session('x'), { zone: 'loose' })).toBeNull();
  });
});

describe('helpers', () => {
  it('sideOf: the upper half is before', () => {
    expect(sideOf(104, { top: 100, height: 20 })).toBe('before');
    expect(sideOf(111, { top: 100, height: 20 })).toBe('after');
  });

  it('sameOver', () => {
    expect(sameOver({ zone: 'loose' }, { zone: 'loose' })).toBe(true);
    expect(sameOver({ zone: 'loose' }, null)).toBe(false);
    expect(sameOver({ zone: 'folder-head', folderId: 'a', side: 'before' }, { zone: 'folder-head', folderId: 'a', side: 'after' })).toBe(false);
  });
});

/** D58 oracle: nested targets (folders in folders). */
describe('subfolders (D58)', () => {
  // A [ A1 [ A1a ], A2 ], B
  const tree: SidebarLayout = {
    pinned: [],
    folders: [
      { id: 'A', name: 'A', collapsed: false, sessionIds: ['a1'], parentId: null },
      { id: 'A1', name: 'A1', collapsed: false, sessionIds: ['x1', 'x2'], parentId: 'A' },
      { id: 'A1a', name: 'A1a', collapsed: false, sessionIds: [], parentId: 'A1' },
      { id: 'A2', name: 'A2', collapsed: false, sessionIds: [], parentId: 'A' },
      { id: 'B', name: 'B', collapsed: false, sessionIds: [], parentId: null },
    ],
  };
  const head = (folderId: string, side: 'before' | 'after' | 'into') => ({ zone: 'folder-head', folderId, side }) as const;

  it('a folder dropped on the middle of a folder head goes into it, at the end of its subfolders', () => {
    expect(resolveDrop(tree, folder('B'), head('A', 'into'))).toEqual({ kind: 'move-folder', folderId: 'B', index: 2, parentId: 'A' });
    expect(resolveDrop(tree, folder('B'), head('A1a', 'into'))).toEqual({ kind: 'move-folder', folderId: 'B', index: 0, parentId: 'A1a' });
    expect(indicatorOf(tree, folder('B'), head('A', 'into'))).toBe('into');
  });

  it('before / after a subfolder: into that level at that place (also out of a deeper level)', () => {
    expect(resolveDrop(tree, folder('B'), head('A2', 'before'))).toEqual({ kind: 'move-folder', folderId: 'B', index: 1, parentId: 'A' });
    expect(resolveDrop(tree, folder('A1a'), head('A', 'after'))).toEqual({ kind: 'move-folder', folderId: 'A1a', index: 1, parentId: null });
    expect(resolveDrop(tree, folder('A2'), head('A1', 'before'))).toEqual({ kind: 'move-folder', folderId: 'A2', index: 0, parentId: 'A' });
    expect(indicatorOf(tree, folder('B'), head('A2', 'after'))).toBe('after');
  });

  it('no loops: not onto itself, not into / beside its own subfolders', () => {
    expect(resolveDrop(tree, folder('A'), head('A', 'into'))).toBeNull();
    expect(resolveDrop(tree, folder('A'), head('A1', 'into'))).toBeNull();
    expect(resolveDrop(tree, folder('A'), head('A1a', 'before'))).toBeNull();
    expect(indicatorOf(tree, folder('A'), head('A1', 'into'))).toBeNull();
  });

  it('too deep: refused', () => {
    const deep: SidebarLayout = {
      pinned: [],
      folders: [
        ...['d1', 'd2', 'd3', 'd4', 'd5'].map((id, i) => ({ id, name: id, collapsed: false, sessionIds: [], parentId: i === 0 ? null : `d${i}` })),
        ...tree.folders,
      ],
    };
    expect(resolveDrop(deep, folder('B'), head('d5', 'into'))).toBeNull();
    expect(resolveDrop(deep, folder('B'), head('d4', 'into'))).toEqual({ kind: 'move-folder', folderId: 'B', index: 1, parentId: 'd4' });
    // A spans 3 levels: fits beside d2 (level 2), not beside d4.
    expect(resolveDrop(deep, folder('A'), head('d3', 'into'))).toBeNull();
    expect(resolveDrop(deep, folder('A'), head('d2', 'after'))).not.toBeNull();
  });

  it('a subfolder dropped on the loose list goes out to the top level (at the end); a top-level one there does nothing', () => {
    expect(resolveDrop(tree, folder('A1'), { zone: 'loose' })).toEqual({ kind: 'move-folder', folderId: 'A1', index: 2, parentId: null });
    expect(resolveDrop(tree, folder('A1a'), { zone: 'row', group: { kind: 'loose' }, sessionId: 'n1', side: 'before' })).toEqual({ kind: 'move-folder', folderId: 'A1a', index: 2, parentId: null });
    expect(resolveDrop(tree, folder('B'), { zone: 'loose' })).toBeNull();
    expect(indicatorOf(tree, folder('A1'), { zone: 'loose' })).toBe('into');
  });

  it('a session goes into a nested folder whatever part of its head; rows in a subfolder place it there', () => {
    expect(resolveDrop(tree, session('a1'), head('A1a', 'before'))).toEqual({ kind: 'place', input: { sessionId: 'a1', place: 'folder', folderId: 'A1a', index: 0 } });
    expect(resolveDrop(tree, session('a1'), head('A1', 'into'))).toEqual({ kind: 'place', input: { sessionId: 'a1', place: 'folder', folderId: 'A1', index: 2 } });
    expect(resolveDrop(tree, session('a1'), { zone: 'row', group: { kind: 'folder', folderId: 'A1' }, sessionId: 'x2', side: 'before' })).toEqual({ kind: 'place', input: { sessionId: 'a1', place: 'folder', folderId: 'A1', index: 1 } });
    expect(indicatorOf(tree, session('a1'), head('A1', 'after'))).toBe('into');
  });

  it('folderSideOf: upper quarter before, lower quarter after, the middle into', () => {
    expect(folderSideOf(102, { top: 100, height: 28 })).toBe('before');
    expect(folderSideOf(114, { top: 100, height: 28 })).toBe('into');
    expect(folderSideOf(122, { top: 100, height: 28 })).toBe('after');
  });
});
