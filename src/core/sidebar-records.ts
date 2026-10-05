/**
 * D71 · the sidebar layout as stored and shared (`docs/sidebar.md` → *Shared
 * layout (D71)*). Pure; used by the service (storage in migration 0029, the peer
 * sync) and its tests.
 *
 * The layout (`SidebarLayout`: arrays, as the routes and the UI know it) is
 * stored as **records**, one per folder and one per placed session, each with
 * order keys (`sidebar-keys.ts`) and hybrid-clock timestamps (`hlc.ts`):
 *
 * - a folder: its name (`nameClock`), its place (parent + order key,
 *   `placeClock`), a tombstone once deleted (`deletedClock`, kept so a peer
 *   learns it), and `collapsed`, which is this machine's own and never shared;
 * - a session: its group (`pinned`, a `folder`, the `loose` order, or `none` =
 *   unplaced) and order key, under one `clock`.
 *
 * A change is made on the arrays (the D54 / D58 rules in `sidebar-layout.ts`)
 * and turned back into records by {@link recordsAfter}: only the items that
 * moved get new keys and clocks. Merging a peer's records is per item, last
 * write wins ({@link mergeRecords}); both ends end up with the same records,
 * so the same layout. Shown, a folder whose parent was deleted sits in the
 * nearest folder above it that is not, and a session in a deleted folder too
 * (unplaced when there is none); a session in a folder not known here
 * (yet) is unplaced.
 */
import { NO_CLOCK } from './hlc.ts';
import { compareKeyed, keyBetween, rekeyGroup } from './sidebar-keys.ts';
import { type SidebarFolder, type SidebarLayout, childFolders, looseOf, moveFolder, normalizeFolders, parentOf, placeSession, removeFolder } from './sidebar-layout.ts';

/** A stored folder (D71). */
export interface FolderRecord {
  readonly id: string;
  readonly name: string;
  readonly nameClock: string;
  /** As written (may name a deleted or unknown folder: shown in the nearest live one above, else top level). */
  readonly parentId: string | null;
  readonly order: string;
  readonly placeClock: string;
  /** Set once deleted (a tombstone); never cleared. */
  readonly deletedClock: string | null;
  /** This machine's own (not shared). */
  readonly collapsed: boolean;
}

/** Where a stored session sits. */
export type PlaceGroup = 'pinned' | 'folder' | 'loose' | 'none';

/** A stored session place (D71). `none` = unplaced (kept, with its clock, so the move out wins over an older place elsewhere). */
export interface PlaceRecord {
  readonly sessionId: string;
  readonly group: PlaceGroup;
  /** Set for `folder` only. */
  readonly folderId: string | null;
  readonly order: string;
  readonly clock: string;
}

/** The stored layout. */
export interface SidebarRecords {
  readonly folders: readonly FolderRecord[];
  readonly places: readonly PlaceRecord[];
}

/** No folder, no place. */
export const EMPTY_RECORDS: SidebarRecords = { folders: [], places: [] };

/** The records a change or a merge wrote (to store, and to send on to the peers). */
export interface RecordChanges {
  readonly folders: readonly FolderRecord[];
  readonly places: readonly PlaceRecord[];
}

/** `true` when nothing changed. */
export function noChanges(changes: RecordChanges): boolean {
  return changes.folders.length === 0 && changes.places.length === 0;
}

/** The folder a folder is shown in: its parent, or the nearest live folder above a deleted one; `null` = top level. */
function shownParent(byId: ReadonlyMap<string, FolderRecord>, folder: FolderRecord): string | null {
  const seen = new Set<string>([folder.id]);
  let at = folder.parentId;
  while (at !== null && !seen.has(at)) {
    seen.add(at);
    const parent = byId.get(at);
    if (!parent) return null;
    if (parent.deletedClock === null) return at;
    at = parent.parentId;
  }
  return null;
}

/** The live folder a session placed in `folderId` is shown in (a deleted one's nearest live folder above), or `null`. */
function shownFolder(byId: ReadonlyMap<string, FolderRecord>, folderId: string | null): string | null {
  const seen = new Set<string>();
  let at = folderId;
  while (at !== null && !seen.has(at)) {
    seen.add(at);
    const folder = byId.get(at);
    if (!folder) return null;
    if (folder.deletedClock === null) return at;
    at = folder.parentId;
  }
  return null;
}

function sorted<T>(items: readonly T[], key: (item: T) => string, id: (item: T) => string): T[] {
  return [...items].sort((a, b) => compareKeyed({ key: key(a), id: id(a) }, { key: key(b), id: id(b) }));
}

/** The layout the records show (folders in tree order, every group in key order). */
export function layoutFromRecords(records: SidebarRecords): SidebarLayout {
  const byId = new Map(records.folders.map((f) => [f.id, f]));
  const live = sorted(
    records.folders.filter((f) => f.deletedClock === null),
    (f) => f.order,
    (f) => f.id,
  );
  const inFolder = new Map<string, string[]>(live.map((f) => [f.id, []]));
  const pinned: string[] = [];
  const loose: string[] = [];
  for (const place of sorted(records.places, (p) => p.order, (p) => p.sessionId)) {
    if (place.group === 'pinned') pinned.push(place.sessionId);
    else if (place.group === 'loose') loose.push(place.sessionId);
    else if (place.group === 'folder') {
      const shown = shownFolder(byId, place.folderId);
      if (shown !== null) inFolder.get(shown)?.push(place.sessionId);
    }
  }
  const folders: SidebarFolder[] = live.map((f) => ({ id: f.id, name: f.name, collapsed: f.collapsed, sessionIds: inFolder.get(f.id) ?? [], parentId: shownParent(byId, f) }));
  return { pinned, folders: normalizeFolders(folders), loose };
}

/** Where the layout shows a session: `pinned`, `loose`, `folder:<id>`, or `none`. */
function groupsOf(layout: SidebarLayout): Map<string, string> {
  const out = new Map<string, string>();
  const put = (id: string, group: string): void => {
    if (!out.has(id)) out.set(id, group);
  };
  for (const id of layout.pinned) put(id, 'pinned');
  for (const folder of layout.folders) for (const id of folder.sessionIds) put(id, `folder:${folder.id}`);
  for (const id of looseOf(layout)) put(id, 'loose');
  return out;
}

/**
 * The records after the layout became `next` (made by the `sidebar-layout.ts`
 * rules from {@link layoutFromRecords} of `records`): only what moved, was
 * renamed, created or deleted gets a new key and / or `clock()`; `collapsed`
 * changes without a clock (it is not shared). Answers the new records and the
 * changed ones.
 */
export function recordsAfter(records: SidebarRecords, next: SidebarLayout, clock: () => string): { readonly records: SidebarRecords; readonly changes: RecordChanges } {
  const before = layoutFromRecords(records);
  let stamp: string | null = null;
  const now = (): string => (stamp ??= clock());
  const folderById = new Map(records.folders.map((f) => [f.id, f]));
  const beforeFolders = new Map(before.folders.map((f) => [f.id, f]));
  const changedFolders = new Map<string, FolderRecord>();
  const tree = normalizeFolders(next.folders);
  const nextIds = new Set(tree.map((f) => f.id));

  // Folders: name and collapsed; then each level's order.
  for (const folder of tree) {
    const record = folderById.get(folder.id);
    if (!record || record.deletedClock !== null) continue;
    let updated = record;
    if (folder.name !== record.name) updated = { ...updated, name: folder.name, nameClock: now() };
    if (folder.collapsed !== record.collapsed) updated = { ...updated, collapsed: folder.collapsed };
    if (updated !== record) changedFolders.set(folder.id, updated);
  }
  const parents = new Set<string | null>(tree.map((f) => parentOf(f)));
  for (const parent of parents) {
    const ids = tree.filter((f) => parentOf(f) === parent).map((f) => f.id);
    const { keys, changed } = rekeyGroup(ids, (id) => {
      const was = beforeFolders.get(id);
      const record = folderById.get(id);
      return was && record && parentOf(was) === parent ? record.order : null;
    });
    for (const id of changed) {
      const folder = tree.find((f) => f.id === id) as SidebarFolder;
      const record = changedFolders.get(id) ?? folderById.get(id);
      const order = keys.get(id) as string;
      if (record && record.deletedClock === null) {
        changedFolders.set(id, { ...record, parentId: parent, order, placeClock: now() });
      } else {
        const at = now();
        changedFolders.set(id, { id, name: folder.name, nameClock: at, parentId: parent, order, placeClock: at, deletedClock: null, collapsed: folder.collapsed });
      }
    }
  }
  for (const folder of before.folders) {
    if (nextIds.has(folder.id)) continue;
    const record = folderById.get(folder.id);
    if (record && record.deletedClock === null) changedFolders.set(folder.id, { ...record, deletedClock: now() });
  }

  // Sessions: each group's order; the ones the layout no longer holds become unplaced.
  const placeById = new Map(records.places.map((p) => [p.sessionId, p]));
  const beforeGroups = groupsOf(before);
  const nextGroups = groupsOf(next);
  const changedPlaces = new Map<string, PlaceRecord>();
  const group = (ids: readonly string[], name: string, kind: PlaceGroup, folderId: string | null): void => {
    const unique = ids.filter((id, i) => ids.indexOf(id) === i && nextGroups.get(id) === name);
    const { keys, changed } = rekeyGroup(unique, (id) => (beforeGroups.get(id) === name ? (placeById.get(id)?.order ?? null) : null));
    for (const id of changed) changedPlaces.set(id, { sessionId: id, group: kind, folderId, order: keys.get(id) as string, clock: now() });
  };
  group(next.pinned, 'pinned', 'pinned', null);
  for (const folder of tree) group(folder.sessionIds, `folder:${folder.id}`, 'folder', folder.id);
  group(looseOf(next), 'loose', 'loose', null);
  for (const [id] of beforeGroups) {
    if (!nextGroups.has(id)) changedPlaces.set(id, { sessionId: id, group: 'none', folderId: null, order: '', clock: now() });
  }

  const changes: RecordChanges = { folders: [...changedFolders.values()], places: [...changedPlaces.values()] };
  return { records: applyChanges(records, changes), changes };
}

/** The records with `changes` written over them (by id). */
export function applyChanges(records: SidebarRecords, changes: RecordChanges): SidebarRecords {
  if (noChanges(changes)) return records;
  const folders = new Map(records.folders.map((f) => [f.id, f]));
  for (const folder of changes.folders) folders.set(folder.id, folder);
  const places = new Map(records.places.map((p) => [p.sessionId, p]));
  for (const place of changes.places) places.set(place.sessionId, place);
  return { folders: [...folders.values()], places: [...places.values()] };
}

/** `a` is a later write than `b`: the later clock, else (equal clocks: rows from before D71) the larger value, so both ends pick the same. */
function later(clockA: string, valueA: string, clockB: string, valueB: string): boolean {
  if (clockA !== clockB) return clockA > clockB;
  return valueA > valueB;
}

/**
 * Merges a peer's records into ours, per item, last write wins: a folder's
 * name, its place (parent + order) and its deletion each on their own clock
 * (a deletion is final); a session's place on its clock. `collapsed` stays
 * ours (a new folder arrives expanded). Answers the merged records and what
 * changed here.
 */
export function mergeRecords(records: SidebarRecords, incoming: RecordChanges): { readonly records: SidebarRecords; readonly changes: RecordChanges } {
  const folders = new Map(records.folders.map((f) => [f.id, f]));
  const changedFolders: FolderRecord[] = [];
  for (const theirs of incoming.folders) {
    const ours = folders.get(theirs.id);
    if (!ours) {
      const added = { ...theirs, collapsed: false };
      folders.set(theirs.id, added);
      changedFolders.push(added);
      continue;
    }
    let merged = ours;
    if (later(theirs.nameClock, theirs.name, ours.nameClock, ours.name)) merged = { ...merged, name: theirs.name, nameClock: theirs.nameClock };
    if (later(theirs.placeClock, `${theirs.parentId ?? ''} ${theirs.order}`, ours.placeClock, `${ours.parentId ?? ''} ${ours.order}`)) {
      merged = { ...merged, parentId: theirs.parentId, order: theirs.order, placeClock: theirs.placeClock };
    }
    if (theirs.deletedClock !== null && (ours.deletedClock === null || theirs.deletedClock > ours.deletedClock)) merged = { ...merged, deletedClock: theirs.deletedClock };
    if (merged !== ours) {
      folders.set(theirs.id, merged);
      changedFolders.push(merged);
    }
  }
  const places = new Map(records.places.map((p) => [p.sessionId, p]));
  const changedPlaces: PlaceRecord[] = [];
  const valueOf = (p: PlaceRecord): string => `${p.group} ${p.folderId ?? ''} ${p.order}`;
  for (const theirs of incoming.places) {
    const ours = places.get(theirs.sessionId);
    if (ours && !later(theirs.clock, valueOf(theirs), ours.clock, valueOf(ours))) continue;
    if (ours && valueOf(ours) === valueOf(theirs) && ours.clock === theirs.clock) continue;
    places.set(theirs.sessionId, theirs);
    changedPlaces.push(theirs);
  }
  const changes: RecordChanges = { folders: changedFolders, places: changedPlaces };
  return { records: noChanges(changes) ? records : { folders: [...folders.values()], places: [...places.values()] }, changes };
}

/** Every clock in `changes` (the receiving clock observes them, so its next write is later). */
export function clocksOf(changes: RecordChanges): string[] {
  const out: string[] = [];
  for (const f of changes.folders) {
    out.push(f.nameClock, f.placeClock);
    if (f.deletedClock !== null) out.push(f.deletedClock);
  }
  for (const p of changes.places) out.push(p.clock);
  return out.filter((c) => c !== NO_CLOCK);
}

/**
 * D71 first enable ("always merge", developer ruling): after the union of both
 * trees, folders with the same name in the same place are combined, top level
 * first, then inside each combined folder: the one with the smallest id stays
 * (both machines pick the same one), the other's subfolders and sessions move
 * to its end, in their order, and the other is deleted. Answers the layout
 * (unchanged when nothing has the same name).
 */
export function combineSameNamed(layout: SidebarLayout): SidebarLayout {
  let current = layout;
  for (let guard = 0; guard < 1000; guard++) {
    const pair = firstSameNamed(current);
    if (!pair) return current;
    const [keep, gone] = pair;
    let next: SidebarLayout | null = current;
    for (const child of childFolders(current, gone.id)) {
      next = next && moveFolder(next, child.id, childFolders(next, keep.id).length, keep.id);
    }
    for (const sessionId of gone.sessionIds) {
      const target = next?.folders.find((f) => f.id === keep.id);
      next = next && target ? placeSession(next, { sessionId, place: 'folder', folderId: keep.id, index: target.sessionIds.length }) : next;
    }
    next = next && removeFolder(next, gone.id);
    if (!next) return current;
    current = next;
  }
  return current;
}

/** The first two folders with the same name and the same parent, in tree order (the smaller id first). */
function firstSameNamed(layout: SidebarLayout): readonly [SidebarFolder, SidebarFolder] | null {
  const tree = normalizeFolders(layout.folders);
  for (const folder of tree) {
    const twins = tree.filter((f) => f.id !== folder.id && parentOf(f) === parentOf(folder) && f.name === folder.name);
    if (twins.length === 0) continue;
    const all = [folder, ...twins].sort((a, b) => (a.id < b.id ? -1 : 1));
    return [all[0] as SidebarFolder, all[1] as SidebarFolder];
  }
  return null;
}

/** An order key after every key in `keys` (e.g. migration rows). */
export function keyAfter(keys: readonly string[]): string {
  const last = [...keys].sort().at(-1);
  return keyBetween(last ?? null, null);
}
