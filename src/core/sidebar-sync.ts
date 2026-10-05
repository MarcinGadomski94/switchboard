/**
 * D71 · what paired machines exchange to share the sidebar layout
 * (`docs/peers.md` → *Shared sidebar layout (D71)*): the layout's records
 * (`sidebar-records.ts`) with machine-independent session keys. Pure.
 *
 * A session is one item on every machine: machine A's own session `X` and, on
 * machine B, the remote id `r~A~X` are both the key `A:X` (`<origin machine
 * id>:<session id>`). Folder ids are random UUIDs, the same everywhere. The
 * `collapsed` state of a folder is each machine's own and never sent.
 */
import { isClock } from './hlc.ts';
import { isMachineId, isRemoteId, parseRemoteId, remoteId } from './peers.ts';
import { isOrderKey } from './sidebar-keys.ts';
import { SIDEBAR_FOLDER_NAME_MAX, SIDEBAR_SESSION_ID_MAX } from './sidebar-layout.ts';
import type { FolderRecord, PlaceGroup, PlaceRecord, RecordChanges } from './sidebar-records.ts';

/** The exchange's version (`v`): a machine that does not know it answers `enabled: false, unsupported: true`. */
export const SIDEBAR_SYNC_VERSION = 1;

/** The most items one message carries (a whole layout is far smaller). */
export const SIDEBAR_SYNC_MAX_ITEMS = 20_000;

/** A folder as sent. */
export interface SidebarSyncFolder {
  readonly id: string;
  readonly name: string;
  readonly nameClock: string;
  readonly parentId: string | null;
  readonly order: string;
  readonly placeClock: string;
  readonly deletedClock: string | null;
}

/** A session place as sent (`key` = `<origin machine id>:<session id>`). */
export interface SidebarSyncPlace {
  readonly key: string;
  readonly group: PlaceGroup;
  readonly folderId: string | null;
  readonly order: string;
  readonly clock: string;
}

/**
 * `POST /peer/v1/sidebar` (the peer listener; not part of `/peer/v1/api`): the
 * caller's records, all of them (`full`: a (re)connect or the switch turned on)
 * or the ones a change just wrote.
 */
export interface SidebarSyncMessage {
  readonly v: number;
  readonly full: boolean;
  readonly folders: readonly SidebarSyncFolder[];
  readonly places: readonly SidebarSyncPlace[];
}

/**
 * Its answer: `enabled` = the answering machine shares its layout with the
 * caller (its own switch for the caller is on) and merged the message; for a
 * `full` message it also sends all its records back.
 */
export interface SidebarSyncAnswer {
  readonly v: number;
  readonly enabled: boolean;
  readonly folders?: readonly SidebarSyncFolder[];
  readonly places?: readonly SidebarSyncPlace[];
}

/** The machine-independent key of a session id as this machine (`selfId`) knows it. */
export function sessionKey(sessionId: string, selfId: string): string {
  const remote = parseRemoteId(sessionId);
  return remote ? `${remote.machineId}:${remote.id}` : `${selfId}:${sessionId}`;
}

/** The session id this machine (`selfId`) knows a key by: its own id, or a remote id. `null` for a malformed key. */
export function sessionIdOf(key: string, selfId: string): string | null {
  const at = key.indexOf(':');
  if (at <= 0 || at === key.length - 1) return null;
  const machine = key.slice(0, at);
  const id = key.slice(at + 1);
  // Never a chain (a third machine's remote id inside a key).
  if (!isMachineId(machine) || isRemoteId(id)) return null;
  return machine === selfId ? id : remoteId(machine, id);
}

/** Records → what is sent (keys for session ids; `collapsed` left out). */
export function toWire(changes: RecordChanges, selfId: string): { readonly folders: SidebarSyncFolder[]; readonly places: SidebarSyncPlace[] } {
  return {
    folders: changes.folders.map((f) => ({ id: f.id, name: f.name, nameClock: f.nameClock, parentId: f.parentId, order: f.order, placeClock: f.placeClock, deletedClock: f.deletedClock })),
    places: changes.places.map((p) => ({ key: sessionKey(p.sessionId, selfId), group: p.group, folderId: p.folderId, order: p.order, clock: p.clock })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= SIDEBAR_SESSION_ID_MAX;
}

const GROUPS: readonly PlaceGroup[] = ['pinned', 'folder', 'loose', 'none'];

/** One folder as received, or `null` when malformed. */
function readFolder(value: unknown): FolderRecord | null {
  if (!isRecord(value)) return null;
  const { id, name, nameClock, parentId, order, placeClock, deletedClock } = value;
  if (!isId(id) || typeof name !== 'string' || name.trim() === '' || name.length > SIDEBAR_FOLDER_NAME_MAX) return null;
  if (!isClock(nameClock) || !isClock(placeClock) || !isOrderKey(order)) return null;
  if (!(parentId === null || (isId(parentId) && parentId !== id))) return null;
  if (!(deletedClock === null || (isClock(deletedClock) && deletedClock !== ''))) return null;
  return { id, name, nameClock, parentId, order, placeClock, deletedClock, collapsed: false };
}

/** One place as received (its key turned into this machine's session id), or `null` when malformed. */
function readPlace(value: unknown, selfId: string): PlaceRecord | null {
  if (!isRecord(value)) return null;
  const { key, group, folderId, order, clock } = value;
  if (typeof key !== 'string' || key.length > SIDEBAR_SESSION_ID_MAX) return null;
  const sessionId = sessionIdOf(key, selfId);
  if (sessionId === null || sessionId.length > SIDEBAR_SESSION_ID_MAX) return null;
  if (typeof group !== 'string' || !(GROUPS as readonly string[]).includes(group) || !isClock(clock)) return null;
  if (group === 'folder' ? !isId(folderId) : folderId !== null) return null;
  if (group === 'none' ? order !== '' : !isOrderKey(order)) return null;
  return { sessionId, group: group as PlaceGroup, folderId: group === 'folder' ? (folderId as string) : null, order: order as string, clock };
}

/** What a peer sent → records (malformed items are left out and counted). */
export function fromWire(value: { readonly folders?: unknown; readonly places?: unknown }, selfId: string): { readonly changes: RecordChanges; readonly dropped: number } {
  const folders: FolderRecord[] = [];
  const places: PlaceRecord[] = [];
  let dropped = 0;
  const list = (items: unknown): unknown[] => (Array.isArray(items) ? items.slice(0, SIDEBAR_SYNC_MAX_ITEMS) : []);
  for (const item of list(value.folders)) {
    const folder = readFolder(item);
    if (folder) folders.push(folder);
    else dropped++;
  }
  for (const item of list(value.places)) {
    const place = readPlace(item, selfId);
    if (place) places.push(place);
    else dropped++;
  }
  return { changes: { folders, places }, dropped };
}

/** Reads a `POST /peer/v1/sidebar` body (`null` when it is not one). */
export function readSyncMessage(body: unknown): { readonly v: number; readonly full: boolean; readonly folders: unknown; readonly places: unknown } | null {
  if (!isRecord(body) || typeof body['v'] !== 'number' || typeof body['full'] !== 'boolean') return null;
  return { v: body['v'], full: body['full'], folders: body['folders'], places: body['places'] };
}
