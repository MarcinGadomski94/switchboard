import { describe, expect, it } from 'vitest';
import {
  EMPTY_SIDEBAR_LAYOUT,
  type SidebarLayout,
  addFolder,
  arrangeSidebar,
  checkFolderName,
  dropPosition,
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
    expect(next.folders).toEqual([{ id: 'f1', name: 'Work', collapsed: false, sessionIds: [] }]);
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
