import { describe, expect, it } from 'vitest';
import type { SidebarLayout } from '../../src/core/sidebar-layout.ts';
import { indicatorOf, resolveDrop, sameOver, sideOf } from '../../src/web/shell/sidebar-dnd.ts';

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

  it('a placed session dropped on the loose list leaves its place; a loose one there does nothing (that list keeps the service order)', () => {
    expect(resolveDrop(layout, session('a2'), { zone: 'loose' })).toEqual({ kind: 'place', input: { sessionId: 'a2', place: 'loose' } });
    expect(resolveDrop(layout, session('p1'), { zone: 'row', group: { kind: 'loose' }, sessionId: 'n1', side: 'before' })).toEqual({ kind: 'place', input: { sessionId: 'p1', place: 'loose' } });
    expect(resolveDrop(layout, session('n2'), { zone: 'loose' })).toBeNull();
  });

  it('a folder moves among the folders only', () => {
    expect(resolveDrop(layout, folder('fb'), { zone: 'folder-head', folderId: 'fa', side: 'before' })).toEqual({ kind: 'move-folder', folderId: 'fb', index: 0 });
    expect(resolveDrop(layout, folder('fa'), { zone: 'folder-head', folderId: 'fb', side: 'after' })).toEqual({ kind: 'move-folder', folderId: 'fa', index: 1 });
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
