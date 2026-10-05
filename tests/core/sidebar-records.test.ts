import { describe, expect, it } from 'vitest';
import { HybridClock } from '../../src/core/hlc.ts';
import { type SidebarLayout, addFolder, moveFolder, placeSession, removeFolder, updateFolder } from '../../src/core/sidebar-layout.ts';
import { EMPTY_RECORDS, type RecordChanges, type SidebarRecords, combineSameNamed, layoutFromRecords, mergeRecords, recordsAfter } from '../../src/core/sidebar-records.ts';
import { fromWire, sessionIdOf, sessionKey, toWire } from '../../src/core/sidebar-sync.ts';

/**
 * D71 oracle: the layout as records (src/core/sidebar-records.ts): minimal
 * writes, merge (last write wins per item), tombstones, catch-up, the first
 * enable's union; and the wire's machine-independent keys (sidebar-sync.ts).
 */

/** One machine's layout store, in memory: changes through the D54 / D58 rules, merges from peers. */
class Replica {
  records: SidebarRecords = EMPTY_RECORDS;
  readonly clock: HybridClock;
  constructor(node: string, now: () => number) {
    this.clock = new HybridClock(node, now);
  }
  get layout(): SidebarLayout {
    return layoutFromRecords(this.records);
  }
  change(rule: (layout: SidebarLayout) => SidebarLayout | null): RecordChanges {
    const next = rule(this.layout);
    if (!next) throw new Error('refused');
    const after = recordsAfter(this.records, next, () => this.clock.next());
    this.records = after.records;
    return after.changes;
  }
  merge(changes: RecordChanges): RecordChanges {
    for (const f of changes.folders) {
      this.clock.observe(f.nameClock);
      this.clock.observe(f.placeClock);
    }
    for (const p of changes.places) this.clock.observe(p.clock);
    const merged = mergeRecords(this.records, changes);
    this.records = merged.records;
    return merged.changes;
  }
  all(): RecordChanges {
    return this.records;
  }
}

function world() {
  let wall = 1_000;
  const tick = () => (wall += 10);
  return { a: new Replica('aaaaaaaaaaaa', tick), b: new Replica('bbbbbbbbbbbb', tick) };
}

/** The shared part of a layout (`collapsed` is each machine's own). */
function shared(layout: SidebarLayout) {
  return { ...layout, folders: layout.folders.map(({ collapsed: _c, ...f }) => f) };
}

describe('records ⇄ layout', () => {
  it('writes only what moved: a re-order touches one place, a rename one register, collapse no clock', () => {
    const { a } = world();
    a.change((l) => placeSession(l, { sessionId: 's1', place: 'pinned' }));
    a.change((l) => placeSession(l, { sessionId: 's2', place: 'pinned' }));
    a.change((l) => placeSession(l, { sessionId: 's3', place: 'pinned' }));
    expect(a.layout.pinned).toEqual(['s1', 's2', 's3']);
    const moved = a.change((l) => placeSession(l, { sessionId: 's3', place: 'pinned', index: 0 }));
    expect(moved.places.map((p) => p.sessionId)).toEqual(['s3']);
    expect(a.layout.pinned).toEqual(['s3', 's1', 's2']);

    const created = a.change((l) => addFolder(l, 'f1', 'Acme'));
    expect(created.folders).toHaveLength(1);
    const renamed = a.change((l) => updateFolder(l, 'f1', { name: 'Acme 2' }));
    expect(renamed.folders).toHaveLength(1);
    expect(renamed.folders[0]?.nameClock).not.toBe(created.folders[0]?.nameClock);
    expect(renamed.folders[0]?.placeClock).toBe(created.folders[0]?.placeClock);
    const collapsed = a.change((l) => updateFolder(l, 'f1', { collapsed: true }));
    expect(collapsed.folders[0]).toMatchObject({ collapsed: true, nameClock: renamed.folders[0]?.nameClock, placeClock: created.folders[0]?.placeClock });
    expect(a.change((l) => l).folders).toEqual([]);
  });

  it('a deleted folder stays as a tombstone; its subfolders move up and its sessions go to its parent (D58)', () => {
    const { a } = world();
    a.change((l) => addFolder(l, 'top', 'Acme'));
    a.change((l) => addFolder(l, 'mid', 'PROJ', 'top'));
    a.change((l) => addFolder(l, 'low', 'PROJ-1', 'mid'));
    a.change((l) => placeSession(l, { sessionId: 's1', place: 'folder', folderId: 'mid' }));
    const removed = a.change((l) => removeFolder(l, 'mid'));
    expect(removed.folders.find((f) => f.id === 'mid')?.deletedClock).not.toBeNull();
    expect(a.records.folders.map((f) => f.id).sort()).toEqual(['low', 'mid', 'top']);
    expect(a.layout.folders.map((f) => [f.id, f.parentId, f.sessionIds])).toEqual([
      ['top', null, ['s1']],
      ['low', 'top', []],
    ]);
  });

  it('the loose order (D71 M2): unplaced first, then the manual order; placing materializes the unplaced ones', () => {
    const { a } = world();
    a.change((l) => placeSession(l, { sessionId: 'n3', place: 'loose', index: 0 }, ['n1', 'n2', 'n3']));
    expect(a.layout.loose).toEqual(['n3', 'n1', 'n2']);
    a.change((l) => placeSession(l, { sessionId: 'n3', place: 'loose' }));
    expect(a.layout.loose).toEqual(['n1', 'n2']);
    expect(a.records.places.find((p) => p.sessionId === 'n3')).toMatchObject({ group: 'none' });
  });
});

describe('merge: last write wins per item', () => {
  it('two machines change different items: both changes land on both, the same layout', () => {
    const { a, b } = world();
    b.merge(a.change((l) => addFolder(l, 'f1', 'Acme')));
    const fromA = a.change((l) => placeSession(l, { sessionId: 'a:s1', place: 'folder', folderId: 'f1' }));
    const fromB = b.change((l) => placeSession(l, { sessionId: 'b:s2', place: 'pinned' }));
    a.merge(fromB);
    b.merge(fromA);
    expect(shared(a.layout)).toEqual(shared(b.layout));
    expect(a.layout.pinned).toEqual(['b:s2']);
    expect(a.layout.folders[0]?.sessionIds).toEqual(['a:s1']);
  });

  it('a conflict on one session: the later placement wins on both machines', () => {
    const { a, b } = world();
    b.merge(a.change((l) => addFolder(l, 'f1', 'Acme')));
    const early = a.change((l) => placeSession(l, { sessionId: 's', place: 'pinned' }));
    const late = b.change((l) => placeSession(l, { sessionId: 's', place: 'folder', folderId: 'f1' }));
    a.merge(late);
    b.merge(early);
    expect(a.layout.folders[0]?.sessionIds).toEqual(['s']);
    expect(shared(a.layout)).toEqual(shared(b.layout));
    // A merge that changes nothing writes nothing (no echo).
    expect(a.merge(late)).toEqual({ folders: [], places: [] });
  });

  it('a rename on one machine and a move on the other both survive; collapse stays each machine\'s own', () => {
    const { a, b } = world();
    b.merge(a.change((l) => addFolder(l, 'f1', 'Acme')));
    b.merge(a.change((l) => addFolder(l, 'f2', 'Later')));
    const renamed = a.change((l) => updateFolder(l, 'f1', { name: 'Acme Inc', collapsed: true }));
    const moved = b.change((l) => moveFolder(l, 'f1', 0, 'f2'));
    a.merge(moved);
    b.merge(renamed);
    expect(shared(a.layout)).toEqual(shared(b.layout));
    expect(a.layout.folders.find((f) => f.id === 'f1')).toMatchObject({ name: 'Acme Inc', parentId: 'f2', collapsed: true });
    expect(b.layout.folders.find((f) => f.id === 'f1')).toMatchObject({ collapsed: false });
  });

  it('a folder deleted on one machine while the other puts a session into it: the deletion wins, the session lands in its parent (or unplaced)', () => {
    const { a, b } = world();
    b.merge(a.change((l) => addFolder(l, 'top', 'Acme')));
    b.merge(a.change((l) => addFolder(l, 'sub', 'PROJ-1', 'top')));
    const deleted = a.change((l) => removeFolder(l, 'sub'));
    const placed = b.change((l) => placeSession(l, { sessionId: 's', place: 'folder', folderId: 'sub' }));
    a.merge(placed);
    b.merge(deleted);
    expect(shared(a.layout)).toEqual(shared(b.layout));
    expect(a.layout.folders.map((f) => [f.id, f.sessionIds])).toEqual([['top', ['s']]]);
    // A later change on either side never brings the deleted folder back.
    a.change((l) => placeSession(l, { sessionId: 's2', place: 'pinned' }));
    expect(a.records.folders.find((f) => f.id === 'sub')?.deletedClock).not.toBeNull();
  });

  it('offline catch-up: a machine that missed several changes gets them all from one full exchange, both ways', () => {
    const { a, b } = world();
    b.merge(a.change((l) => addFolder(l, 'f1', 'Acme')));
    // B is away: A changes a lot; B changes something too.
    a.change((l) => addFolder(l, 'f2', 'Later'));
    a.change((l) => placeSession(l, { sessionId: 's1', place: 'folder', folderId: 'f2' }));
    a.change((l) => updateFolder(l, 'f1', { name: 'Acme 2' }));
    a.change((l) => removeFolder(l, 'f2'));
    b.change((l) => placeSession(l, { sessionId: 's2', place: 'pinned' }));
    // Reconnect: each sends all its records.
    const fromA = a.all();
    const fromB = b.all();
    a.merge(fromB);
    b.merge(fromA);
    expect(shared(a.layout)).toEqual(shared(b.layout));
    expect(b.layout).toMatchObject({ pinned: ['s2'], folders: [{ id: 'f1', name: 'Acme 2', sessionIds: [] }] });
    expect(b.records.folders.find((f) => f.id === 'f2')?.deletedClock).not.toBeNull();
  });

  it('a session placed in a folder not known here (yet) shows unplaced, and in the folder once it arrives', () => {
    const { a, b } = world();
    const folder = a.change((l) => addFolder(l, 'f1', 'Acme'));
    const placed = a.change((l) => placeSession(l, { sessionId: 's', place: 'folder', folderId: 'f1' }));
    b.merge(placed);
    expect(b.layout.folders).toEqual([]);
    expect(b.layout.pinned).toEqual([]);
    b.merge(folder);
    expect(b.layout.folders[0]?.sessionIds).toEqual(['s']);
  });

  it('rows from before D71 (no clocks) that differ: both machines pick the same one', () => {
    const base = (group: 'pinned' | 'loose'): SidebarRecords => ({ folders: [], places: [{ sessionId: 's', group, folderId: null, order: '000000i', clock: '' }] });
    const onA = mergeRecords(base('pinned'), base('loose').places.length ? { folders: [], places: base('loose').places } : EMPTY_RECORDS).records;
    const onB = mergeRecords(base('loose'), { folders: [], places: base('pinned').places }).records;
    expect(layoutFromRecords(onA)).toEqual(layoutFromRecords(onB));
  });
});

describe('first enable: always merge (union, same-named folders combined)', () => {
  it('the union of both trees; folders with the same name at the same place combine, also inside a combined folder', () => {
    const { a, b } = world();
    a.change((l) => addFolder(l, 'a-acme', 'Acme'));
    a.change((l) => addFolder(l, 'a-p1', 'PROJ-1', 'a-acme'));
    a.change((l) => addFolder(l, 'a-only', 'Mine'));
    a.change((l) => placeSession(l, { sessionId: 'x', place: 'folder', folderId: 'a-p1' }));
    b.change((l) => addFolder(l, 'b-acme', 'Acme'));
    b.change((l) => addFolder(l, 'b-p1', 'PROJ-1', 'b-acme'));
    b.change((l) => addFolder(l, 'b-p2', 'PROJ-2', 'b-acme'));
    b.change((l) => placeSession(l, { sessionId: 'y', place: 'folder', folderId: 'b-p1' }));
    // Both exchange everything, then each combines (the same survivors: the smaller ids).
    const fromA = a.all();
    b.merge(fromA);
    a.merge(b.all());
    const combinedA = a.change(combineSameNamed);
    const combinedB = b.change(combineSameNamed);
    a.merge(combinedB);
    b.merge(combinedA);
    expect(shared(a.layout)).toEqual(shared(b.layout));
    const tree = a.layout.folders.map((f) => [f.id, f.parentId, [...f.sessionIds].sort()]);
    expect(tree).toEqual([
      ['a-acme', null, []],
      ['a-p1', 'a-acme', ['x', 'y']],
      ['b-p2', 'a-acme', []],
      ['a-only', null, []],
    ]);
  });

  it('nothing with the same name: the layout is left as it is', () => {
    const layout: SidebarLayout = { pinned: [], folders: [{ id: 'f1', name: 'A', collapsed: false, sessionIds: [], parentId: null }], loose: [] };
    expect(combineSameNamed(layout)).toBe(layout);
  });
});

describe('the wire: machine-independent session keys', () => {
  const A = 'aaaaaaaaaaaa';
  const B = 'bbbbbbbbbbbb';
  it("A's own session X and B's remote r~A~X are the same key", () => {
    expect(sessionKey('x-1', A)).toBe(`${A}:x-1`);
    expect(sessionKey(`r~${A}~x-1`, B)).toBe(`${A}:x-1`);
    expect(sessionIdOf(`${A}:x-1`, A)).toBe('x-1');
    expect(sessionIdOf(`${A}:x-1`, B)).toBe(`r~${A}~x-1`);
    expect(sessionIdOf('cccccccccccc:x-2', B)).toBe('r~cccccccccccc~x-2');
    expect(sessionIdOf('nope', A)).toBeNull();
    expect(sessionIdOf(`${A}:r~${B}~x`, A)).toBeNull();
  });

  it('records go out without `collapsed` and come back as the receiver knows them; malformed items are dropped', () => {
    const { a } = world();
    a.change((l) => addFolder(l, 'f1', 'Acme'));
    a.change((l) => updateFolder(l, 'f1', { collapsed: true }));
    a.change((l) => placeSession(l, { sessionId: 'x-1', place: 'folder', folderId: 'f1' }));
    a.change((l) => placeSession(l, { sessionId: `r~${B}~y-1`, place: 'pinned' }));
    const wire = JSON.parse(JSON.stringify(toWire(a.records, A)));
    expect(wire.folders[0]).not.toHaveProperty('collapsed');
    const onB = fromWire({ folders: [...wire.folders, { id: '', name: 'bad' }], places: [...wire.places, { key: 'x', group: 'pinned' }] }, B);
    expect(onB.dropped).toBe(2);
    const layout = layoutFromRecords(mergeRecords(EMPTY_RECORDS, onB.changes).records);
    expect(layout).toEqual({ pinned: ['y-1'], folders: [{ id: 'f1', name: 'Acme', collapsed: false, sessionIds: [`r~${A}~x-1`], parentId: null }], loose: [] });
  });
});
