import { describe, expect, it } from 'vitest';
import {
  type FolderArchiveCandidate,
  type FolderArchiveHolds,
  folderArchiveConfirm,
  folderArchiveHold,
  folderArchiveResultText,
  folderSessionIds,
  folderSubtree,
  removeFolderTree,
  splitFolderArchive,
} from '../../src/core/sidebar-folder-archive.ts';
import type { SidebarLayout } from '../../src/core/sidebar-layout.ts';

/** D141 · the rules of deleting a sidebar folder and archiving its agents. */

const layout: SidebarLayout = {
  pinned: ['p'],
  loose: ['l'],
  folders: [
    { id: 'outer', name: 'Outer', collapsed: false, sessionIds: ['o1'], parentId: null },
    { id: 'work', name: 'Work', collapsed: false, sessionIds: ['w1', 'w2'], parentId: 'outer' },
    { id: 'reviews', name: 'Reviews', collapsed: true, sessionIds: ['r1'], parentId: 'work' },
    { id: 'deep', name: 'Deep', collapsed: false, sessionIds: ['d1', 'w1'], parentId: 'reviews' },
    { id: 'side', name: 'Side', collapsed: false, sessionIds: ['s1'], parentId: 'work' },
    { id: 'later', name: 'Later', collapsed: false, sessionIds: ['x1'], parentId: null },
  ],
};

const none: FolderArchiveHolds = { pinned: new Set(), crew: new Set(), plans: new Map() };
const here = (sessionId: string): FolderArchiveCandidate => ({ sessionId, name: sessionId, machine: null });

describe('counting (recursive)', () => {
  it('the subtree is the folder and its subfolders at any depth, in tree order', () => {
    expect(folderSubtree(layout, 'work').map((f) => f.id)).toEqual(['work', 'reviews', 'deep', 'side']);
    expect(folderSubtree(layout, 'deep').map((f) => f.id)).toEqual(['deep']);
    expect(folderSubtree(layout, 'nope')).toEqual([]);
  });

  it('its sessions: the folder\'s own first, then each subfolder\'s, each once', () => {
    expect(folderSessionIds(layout, 'work')).toEqual(['w1', 'w2', 'r1', 'd1', 's1']);
    expect(folderSessionIds(layout, 'outer')).toEqual(['o1', 'w1', 'w2', 'r1', 'd1', 's1']);
    expect(folderSessionIds(layout, 'later')).toEqual(['x1']);
    expect(folderSessionIds(layout, 'nope')).toEqual([]);
  });
});

describe('removeFolderTree', () => {
  it('deletes the folder and its subfolders; their sessions go to the end of its parent', () => {
    const next = removeFolderTree(layout, 'work');
    expect(next?.folders.map((f) => f.id)).toEqual(['outer', 'later']);
    expect(next?.folders[0]?.sessionIds).toEqual(['o1', 'w1', 'w2', 'r1', 'd1', 's1']);
    expect(next?.pinned).toEqual(['p']);
    expect(next?.loose).toEqual(['l']);
  });

  it('a top-level folder\'s sessions leave the folders (unplaced); unknown folder → null', () => {
    const next = removeFolderTree(layout, 'outer');
    expect(next?.folders.map((f) => f.id)).toEqual(['later']);
    expect(next?.folders.flatMap((f) => f.sessionIds)).toEqual(['x1']);
    expect(removeFolderTree(layout, 'nope')).toBeNull();
  });
});

describe('held-back rules', () => {
  it('pinned, crew, plan, plan-step, then a paired computer that is offline; else archived', () => {
    const holds: FolderArchiveHolds = { pinned: new Set(['a']), crew: new Set(['a', 'b']), plans: new Map([['c', 'plan'], ['d', 'plan-step'], ['b', 'plan']]) };
    expect(folderArchiveHold(here('a'), holds)).toBe('pinned');
    expect(folderArchiveHold(here('b'), holds)).toBe('crew');
    expect(folderArchiveHold(here('c'), holds)).toBe('plan');
    expect(folderArchiveHold(here('d'), holds)).toBe('plan-step');
    expect(folderArchiveHold({ sessionId: 'e', name: 'e', machine: { name: 'Laptop', online: false } }, holds)).toBe('offline');
    expect(folderArchiveHold({ sessionId: 'f', name: 'f', machine: { name: 'Laptop', online: true } }, holds)).toBeNull();
    expect(folderArchiveHold(here('g'), holds)).toBeNull();
  });

  it('splits in order and names the computer of a kept agent', () => {
    const split = splitFolderArchive([here('a'), { sessionId: 'r', name: 'Remote one', machine: { name: 'Laptop', online: false } }, here('b')], { ...none, pinned: new Set(['b']) });
    expect(split.archive.map((c) => c.sessionId)).toEqual(['a']);
    expect(split.kept).toEqual([
      { sessionId: 'r', name: 'Remote one', machine: 'Laptop', reason: 'offline' },
      { sessionId: 'b', name: 'b', machine: null, reason: 'pinned' },
    ]);
  });
});

describe('words', () => {
  const agents = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'].map((name, i) => ({ name, working: i < 2 }));

  it('the confirmation: title with N, the checkbox, the working line, five names and "+ N more"', () => {
    expect(folderArchiveConfirm('Acme', agents, true, 'v2')).toEqual({
      title: 'Delete “Acme” and archive its 7 agents?',
      checkbox: 'Also archive the agents in it',
      working: '2 are working and will be stopped.',
      names: ['One', 'Two', 'Three', 'Four', 'Five'],
      more: '+ 2 more',
    });
    const one = folderArchiveConfirm('Acme', [{ name: 'Solo', working: true }], true, 'classic');
    expect(one).toMatchObject({ title: 'Delete “Acme” and archive its session?', checkbox: 'Also archive the sessions in it', working: '1 is working and will be stopped.', more: null });
    // Unticked: the plain delete (agents move out; nothing is stopped).
    expect(folderArchiveConfirm('Acme', agents, false, 'v2')).toMatchObject({ title: 'Delete “Acme”?', working: null });
  });

  it('the result: archived · kept with each distinct reason once', () => {
    expect(folderArchiveResultText('Acme', { archived: [{ sessionId: 'a', name: 'a', machine: null }], kept: [] }, 'v2')).toBe('Deleted “Acme”. 1 archived.');
    const kept = [
      { sessionId: 'b', name: 'b', machine: null, reason: 'pinned' as const },
      { sessionId: 'c', name: 'c', machine: null, reason: 'pinned' as const },
      { sessionId: 'd', name: 'd', machine: 'Laptop', reason: 'offline' as const },
    ];
    const archived = ['1', '2', '3'].map((sessionId) => ({ sessionId, name: sessionId, machine: null }));
    expect(folderArchiveResultText('Acme', { archived, kept }, 'v2')).toBe('Deleted “Acme”. 3 archived · 3 kept: pinned, Laptop is offline.');
    expect(folderArchiveResultText('Acme', { archived: [], kept: [{ sessionId: 'e', name: 'e', machine: null, reason: 'crew' }] }, 'classic')).toBe('Deleted “Acme”. 0 archived · 1 kept: a Team member.');
  });
});
