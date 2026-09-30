import { describe, expect, it } from 'vitest';
import {
  EMPTY_SIDEBAR_LAYOUT,
  type SidebarLayout,
  addFolder,
  arrangeSidebar,
  SIDEBAR_FOLDER_DEPTH_MAX,
  checkFolderName,
  checkFolderParent,
  childFolders,
  descendantIds,
  dropPosition,
  folderDepth,
  normalizeFolders,
  subtreeHeight,
  moveFolder,
  needsYou,
  parseFolderCreate,
  parseFolderMove,
  parseFolderPatch,
  parsePlaceInput,
  placeOf,
  placeSession,
  removeFolder,
  stepPosition,
  updateFolder,
} from '../../src/core/sidebar-layout.ts';

/** D54 oracle: the sidebar's pins and folders (src/core/sidebar-layout.ts, docs/sidebar.md). */

const layout: SidebarLayout = {
  pinned: ['p1', 'p2'],
  folders: [
    { id: 'fa', name: 'Alpha', collapsed: false, sessionIds: ['a1', 'a2', 'a3'] },
    { id: 'fb', name: 'Beta', collapsed: true, sessionIds: [] },
  ],
};

describe('placeSession', () => {
  it('pins a loose session at the end, or at the given final index', () => {
    expect(placeSession(layout, { sessionId: 'x', place: 'pinned' })?.pinned).toEqual(['p1', 'p2', 'x']);
    expect(placeSession(layout, { sessionId: 'x', place: 'pinned', index: 0 })?.pinned).toEqual(['x', 'p1', 'p2']);
    expect(placeSession(layout, { sessionId: 'x', place: 'pinned', index: 99 })?.pinned).toEqual(['p1', 'p2', 'x']);
  });

  it('a session sits in one place only: pinning a foldered session takes it out of its folder', () => {
    const next = placeSession(layout, { sessionId: 'a2', place: 'pinned', index: 1 });
    expect(next?.pinned).toEqual(['p1', 'a2', 'p2']);
    expect(next?.folders[0]?.sessionIds).toEqual(['a1', 'a3']);
    expect(placeOf(next as SidebarLayout, 'a2')).toBe('pinned');
  });

  it('re-orders inside a group (index = the final position)', () => {
    expect(placeSession(layout, { sessionId: 'a1', place: 'folder', folderId: 'fa', index: 2 })?.folders[0]?.sessionIds).toEqual(['a2', 'a3', 'a1']);
    expect(placeSession(layout, { sessionId: 'p2', place: 'pinned', index: 0 })?.pinned).toEqual(['p2', 'p1']);
  });

  it('moves between folders, and loose takes a session out (unpin / out of the folder)', () => {
    const moved = placeSession(layout, { sessionId: 'a1', place: 'folder', folderId: 'fb' });
    expect(moved?.folders.map((f) => f.sessionIds)).toEqual([['a2', 'a3'], ['a1']]);
    const unpinned = placeSession(layout, { sessionId: 'p1', place: 'loose' });
    expect(unpinned?.pinned).toEqual(['p2']);
    expect(placeOf(unpinned as SidebarLayout, 'p1')).toBeNull();
  });

  it('refuses an unknown folder, and never mutates its input', () => {
    const before = JSON.stringify(layout);
    expect(placeSession(layout, { sessionId: 'x', place: 'folder', folderId: 'nope' })).toBeNull();
    placeSession(layout, { sessionId: 'a1', place: 'pinned' });
    expect(JSON.stringify(layout)).toBe(before);
  });
});

describe('folders', () => {
  it('a new folder is expanded, empty, at the end', () => {
    const next = addFolder(EMPTY_SIDEBAR_LAYOUT, 'f1', 'Work');
    expect(next?.folders).toEqual([{ id: 'f1', name: 'Work', collapsed: false, sessionIds: [], parentId: null }]);
  });

  it('rename and collapse; unknown → null', () => {
    expect(updateFolder(layout, 'fa', { name: 'A' })?.folders[0]).toMatchObject({ name: 'A', collapsed: false });
    expect(updateFolder(layout, 'fa', { collapsed: true })?.folders[0]).toMatchObject({ name: 'Alpha', collapsed: true });
    expect(updateFolder(layout, 'nope', { collapsed: true })).toBeNull();
  });

  it('deleting a folder makes its sessions loose; pins stay', () => {
    const next = removeFolder(layout, 'fa') as SidebarLayout;
    expect(next.folders.map((f) => f.id)).toEqual(['fb']);
    expect(placeOf(next, 'a1')).toBeNull();
    expect(next.pinned).toEqual(['p1', 'p2']);
    expect(removeFolder(layout, 'nope')).toBeNull();
  });

  it('folders re-order', () => {
    expect(moveFolder(layout, 'fb', 0)?.folders.map((f) => f.id)).toEqual(['fb', 'fa']);
    expect(moveFolder(layout, 'fa', 5)?.folders.map((f) => f.id)).toEqual(['fb', 'fa']);
    expect(moveFolder(layout, 'nope', 0)).toBeNull();
  });
});

describe('dropPosition / stepPosition', () => {
  it('before / after an anchor, with the dragged item taken out first', () => {
    const ids = ['a', 'b', 'c', 'd'];
    expect(dropPosition(ids, 'a', 'c', 'before')).toBe(1);
    expect(dropPosition(ids, 'a', 'c', 'after')).toBe(2);
    expect(dropPosition(ids, 'd', 'a', 'before')).toBe(0);
    expect(dropPosition(ids, 'x', 'b', 'after')).toBe(2);
    expect(dropPosition(ids, 'b', 'b', 'after')).toBe(1);
    expect(dropPosition(ids, 'x', null, 'before')).toBe(4);
    expect(dropPosition(ids, 'x', 'gone', 'before')).toBe(4);
  });

  it('Move up / down step over ids the sidebar does not show (a closed session keeps its slot)', () => {
    const stored = ['a', 'closed', 'b', 'c'];
    const visible = ['a', 'b', 'c'];
    expect(stepPosition(stored, visible, 'b', -1)).toBe(0);
    expect(placeSession({ pinned: stored, folders: [] }, { sessionId: 'b', place: 'pinned', index: 0 })?.pinned).toEqual(['b', 'a', 'closed', 'c']);
    expect(stepPosition(stored, visible, 'b', 1)).toBe(3);
    expect(stepPosition(stored, visible, 'a', -1)).toBeNull();
    expect(stepPosition(stored, visible, 'c', 1)).toBeNull();
    expect(stepPosition(stored, visible, 'closed', 1)).toBeNull();
  });
});

describe('arrangeSidebar', () => {
  const s = (id: string, status = 'idle') => ({ id, status });
  const sessions = [s('n3'), s('a2', 'need'), s('p2'), s('n2'), s('a1'), s('p1'), s('n1')];

  it('Pinned, then folders in their order, then the loose ones in the list order (newest first)', () => {
    const arranged = arrangeSidebar(sessions, layout);
    expect(arranged.pinned.map((x) => x.id)).toEqual(['p1', 'p2']);
    expect(arranged.folders.map((f) => [f.folder.id, f.sessions.map((x) => x.id)])).toEqual([
      ['fa', ['a1', 'a2']],
      ['fb', []],
    ]);
    expect(arranged.loose.map((x) => x.id)).toEqual(['n3', 'n2', 'n1']);
  });

  it('ids the list does not hold (closed, a peer session that ended) are skipped, not dropped', () => {
    const arranged = arrangeSidebar([s('a3'), s('x')], layout);
    expect(arranged.pinned).toEqual([]);
    expect(arranged.folders[0]?.sessions.map((x) => x.id)).toEqual(['a3']);
    expect(arranged.loose.map((x) => x.id)).toEqual(['x']);
  });

  it('with an empty layout it is the list itself', () => {
    expect(arrangeSidebar(sessions, EMPTY_SIDEBAR_LAYOUT)).toEqual({ pinned: [], folders: [], loose: sessions });
  });

  it('a stale layout listing a session twice shows it once, in its first place', () => {
    const arranged = arrangeSidebar([s('p1')], { pinned: ['p1'], folders: [{ id: 'f', name: 'F', collapsed: false, sessionIds: ['p1'] }] });
    expect(arranged.pinned.map((x) => x.id)).toEqual(['p1']);
    expect(arranged.folders[0]?.sessions).toEqual([]);
  });

  it('needsYou: a session waiting for the developer', () => {
    expect(needsYou([s('a'), s('b', 'need')])).toBe(true);
    expect(needsYou([s('a', 'run')])).toBe(false);
  });
});

describe('validation', () => {
  it('folder names: trimmed, 1–60 characters', () => {
    expect(checkFolderName('  Work ')).toEqual({ ok: true, value: 'Work' });
    expect(checkFolderName('   ').ok).toBe(false);
    expect(checkFolderName('x'.repeat(61)).ok).toBe(false);
    expect(checkFolderName(3).ok).toBe(false);
    expect(parseFolderCreate({ name: 'A' })).toEqual({ ok: true, value: { name: 'A' } });
    expect(parseFolderCreate(null).ok).toBe(false);
  });

  it('folder patch: name and / or collapsed, at least one', () => {
    expect(parseFolderPatch({ collapsed: true })).toEqual({ ok: true, value: { collapsed: true } });
    expect(parseFolderPatch({ name: ' B ', collapsed: false })).toEqual({ ok: true, value: { name: 'B', collapsed: false } });
    expect(parseFolderPatch({}).ok).toBe(false);
    expect(parseFolderPatch({ collapsed: 'yes' }).ok).toBe(false);
  });

  it('folder move: a whole index ≥ 0', () => {
    expect(parseFolderMove({ index: 2 })).toEqual({ ok: true, value: { index: 2 } });
    expect(parseFolderMove({ index: -1 }).ok).toBe(false);
    expect(parseFolderMove({ index: 1.5 }).ok).toBe(false);
  });

  it('place: session id, place, folderId for a folder, optional index (dropped for loose)', () => {
    expect(parsePlaceInput({ sessionId: 's', place: 'pinned', index: 1 })).toEqual({ ok: true, value: { sessionId: 's', place: 'pinned', index: 1 } });
    expect(parsePlaceInput({ sessionId: 's', place: 'folder', folderId: 'f' })).toEqual({ ok: true, value: { sessionId: 's', place: 'folder', folderId: 'f' } });
    expect(parsePlaceInput({ sessionId: 's', place: 'loose', index: 3 })).toEqual({ ok: true, value: { sessionId: 's', place: 'loose' } });
    expect(parsePlaceInput({ sessionId: 's', place: 'folder' }).ok).toBe(false);
    expect(parsePlaceInput({ sessionId: '', place: 'pinned' }).ok).toBe(false);
    expect(parsePlaceInput({ sessionId: 's', place: 'top' }).ok).toBe(false);
    expect(parsePlaceInput({ sessionId: 'r~abcdefghijkl~s1', place: 'pinned' }).ok).toBe(true);
  });
});

/** D58 oracle: subfolders (folders in folders, tree order, no loops, the depth limit, delete moves things up). */
describe('subfolders (D58)', () => {
  // top: A (a1) [ A1 (x1) [ A1a (y1) ], A2 ], B
  const tree: SidebarLayout = {
    pinned: ['p1'],
    folders: [
      { id: 'A', name: 'A', collapsed: false, sessionIds: ['a1'], parentId: null },
      { id: 'A1', name: 'A1', collapsed: false, sessionIds: ['x1'], parentId: 'A' },
      { id: 'A1a', name: 'A1a', collapsed: false, sessionIds: ['y1'], parentId: 'A1' },
      { id: 'A2', name: 'A2', collapsed: false, sessionIds: [], parentId: 'A' },
      { id: 'B', name: 'B', collapsed: false, sessionIds: [], parentId: null },
    ],
  };
  const ids = (l: SidebarLayout | null) => l?.folders.map((f) => `${f.parentId ?? '-'}/${f.id}`);

  it('tree helpers: children, depth, descendants, height', () => {
    expect(childFolders(tree, null).map((f) => f.id)).toEqual(['A', 'B']);
    expect(childFolders(tree, 'A').map((f) => f.id)).toEqual(['A1', 'A2']);
    expect(folderDepth(tree, 'A')).toBe(1);
    expect(folderDepth(tree, 'A1a')).toBe(3);
    expect(folderDepth(tree, null)).toBe(0);
    expect(descendantIds(tree, 'A').sort()).toEqual(['A1', 'A1a', 'A2']);
    expect(subtreeHeight(tree, 'A')).toBe(3);
    expect(subtreeHeight(tree, 'B')).toBe(1);
  });

  it('normalizeFolders: tree order, siblings in list order; D54-shaped folders are top level; a missing parent or a loop lands at the top level', () => {
    const shuffled = [tree.folders[3], tree.folders[2], tree.folders[4], tree.folders[0], tree.folders[1]] as SidebarLayout['folders'];
    // Siblings keep their list order (B was listed before A; A2 before A1).
    expect(normalizeFolders(shuffled).map((f) => f.id)).toEqual(['B', 'A', 'A2', 'A1', 'A1a']);
    expect(normalizeFolders(tree.folders).map((f) => f.id)).toEqual(['A', 'A1', 'A1a', 'A2', 'B']);
    expect(normalizeFolders([{ id: 'x', name: 'X', collapsed: false, sessionIds: [] }])).toEqual([{ id: 'x', name: 'X', collapsed: false, sessionIds: [], parentId: null }]);
    expect(normalizeFolders([{ id: 'o', name: 'O', collapsed: false, sessionIds: [], parentId: 'gone' }])[0]?.parentId).toBeNull();
    const loop = normalizeFolders([
      { id: 'l1', name: 'L1', collapsed: false, sessionIds: [], parentId: 'l2' },
      { id: 'l2', name: 'L2', collapsed: false, sessionIds: [], parentId: 'l1' },
    ]);
    expect(loop.map((f) => `${f.parentId ?? '-'}/${f.id}`)).toEqual(['-/l1', 'l1/l2']);
  });

  it('a subfolder is created at the end of its parent\'s subfolders; an unknown parent is refused', () => {
    expect(ids(addFolder(tree, 'A3', 'A3', 'A'))).toEqual(['-/A', 'A/A1', 'A1/A1a', 'A/A2', 'A/A3', '-/B']);
    expect(ids(addFolder(tree, 'C', 'C'))).toEqual(['-/A', 'A/A1', 'A1/A1a', 'A/A2', '-/B', '-/C']);
    expect(addFolder(tree, 'z', 'Z', 'gone')).toBeNull();
  });

  it('move: into another folder, among its siblings, out to the top level; absent parentId keeps the level (D54)', () => {
    expect(ids(moveFolder(tree, 'B', 0, 'A1'))).toEqual(['-/A', 'A/A1', 'A1/B', 'A1/A1a', 'A/A2']);
    expect(ids(moveFolder(tree, 'A2', 0))).toEqual(['-/A', 'A/A2', 'A/A1', 'A1/A1a', '-/B']);
    expect(ids(moveFolder(tree, 'A1', 1, null))).toEqual(['-/A', 'A/A2', '-/A1', 'A1/A1a', '-/B']);
    // Its sessions and subfolders go with it.
    const moved = moveFolder(tree, 'A1', 0, 'B') as SidebarLayout;
    expect(moved.folders.find((f) => f.id === 'A1')?.sessionIds).toEqual(['x1']);
    expect(moved.folders.find((f) => f.id === 'A1a')?.parentId).toBe('A1');
  });

  it('no loops: a folder never goes into itself or one of its subfolders', () => {
    expect(moveFolder(tree, 'A', 0, 'A')).toBeNull();
    expect(moveFolder(tree, 'A', 0, 'A1a')).toBeNull();
    expect(checkFolderParent(tree, 'A', 'A1')).toEqual({ kind: 'invalid', message: 'a folder cannot go into itself or one of its subfolders' });
    expect(checkFolderParent(tree, 'A', 'gone')).toEqual({ kind: 'not-found', id: 'gone' });
    expect(checkFolderParent(tree, 'gone', null)).toEqual({ kind: 'not-found', id: 'gone' });
    expect(checkFolderParent(tree, 'A1', 'B')).toBeNull();
  });

  it(`depth: at most ${SIDEBAR_FOLDER_DEPTH_MAX} levels, counting the moved folder's own subfolders`, () => {
    let deep: SidebarLayout = { pinned: [], folders: [] };
    let parent: string | null = null;
    for (let i = 1; i <= SIDEBAR_FOLDER_DEPTH_MAX; i++) {
      deep = addFolder(deep, `d${i}`, `D${i}`, parent) as SidebarLayout;
      parent = `d${i}`;
    }
    expect(folderDepth(deep, `d${SIDEBAR_FOLDER_DEPTH_MAX}`)).toBe(SIDEBAR_FOLDER_DEPTH_MAX);
    expect(addFolder(deep, 'x', 'X', parent)).toBeNull();
    expect(checkFolderParent(deep, null, parent)?.kind).toBe('invalid');
    // A (height 3) fits under d2 (depth 2 + 3 = 5) but not under d3.
    const both: SidebarLayout = { pinned: [], folders: [...deep.folders, ...tree.folders] };
    expect(checkFolderParent(both, 'A', 'd2')).toBeNull();
    expect(checkFolderParent(both, 'A', 'd3')).toEqual({ kind: 'invalid', message: `folders nest at most ${SIDEBAR_FOLDER_DEPTH_MAX} levels deep` });
    expect(moveFolder(both, 'A', 0, 'd3')).toBeNull();
  });

  it('delete: its subfolders move up into its place, its sessions go to its parent (or loose at the top level); nothing is lost', () => {
    const inner = removeFolder(tree, 'A1') as SidebarLayout;
    expect(ids(inner)).toEqual(['-/A', 'A/A1a', 'A/A2', '-/B']);
    expect(inner.folders.find((f) => f.id === 'A')?.sessionIds).toEqual(['a1', 'x1']);
    expect(inner.folders.find((f) => f.id === 'A1a')?.sessionIds).toEqual(['y1']);
    const top = removeFolder(tree, 'A') as SidebarLayout;
    expect(ids(top)).toEqual(['-/A1', 'A1/A1a', '-/A2', '-/B']);
    expect(placeOf(top, 'a1')).toBeNull();
    expect(placeOf(top, 'x1')).toEqual({ folderId: 'A1' });
    expect(top.pinned).toEqual(['p1']);
  });

  it('arrangeSidebar: tree order with levels, hidden under a collapsed folder, totals and the amber dot at any depth', () => {
    const collapsed: SidebarLayout = { ...tree, folders: tree.folders.map((f) => (f.id === 'A1' ? { ...f, collapsed: true } : f)) };
    const s = (id: string, status = 'idle') => ({ id, status });
    const arranged = arrangeSidebar([s('a1'), s('x1'), s('y1', 'need'), s('n1')], collapsed);
    expect(arranged.folders.map((f) => [f.folder.id, f.level, f.hidden, f.total.map((x) => x.id)])).toEqual([
      ['A', 0, false, ['a1', 'x1', 'y1']],
      ['A1', 1, false, ['x1', 'y1']],
      ['A1a', 2, true, ['y1']],
      ['A2', 1, false, []],
      ['B', 0, false, []],
    ]);
    expect(needsYou(arranged.folders[1]?.total ?? [])).toBe(true);
    expect(arranged.loose.map((x) => x.id)).toEqual(['n1']);
  });

  it('parse: parentId is optional, null (the top level) or a folder id', () => {
    expect(parseFolderCreate({ name: 'A', parentId: 'f' })).toEqual({ ok: true, value: { name: 'A', parentId: 'f' } });
    expect(parseFolderCreate({ name: 'A', parentId: null })).toEqual({ ok: true, value: { name: 'A', parentId: null } });
    expect(parseFolderCreate({ name: 'A', parentId: 3 }).ok).toBe(false);
    expect(parseFolderCreate({ name: '', parentId: '' }).ok).toBe(false);
    expect(parseFolderMove({ index: 0, parentId: 'f' })).toEqual({ ok: true, value: { index: 0, parentId: 'f' } });
    expect(parseFolderMove({ index: 0, parentId: null })).toEqual({ ok: true, value: { index: 0, parentId: null } });
    expect(parseFolderMove({ index: 0, parentId: '' }).ok).toBe(false);
  });
});
