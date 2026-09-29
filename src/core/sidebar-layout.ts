/**
 * D54 · the sidebar's pins and folders (`docs/sidebar.md`): the pure layout
 * rules shared by the server (`/api/sidebar*`, migration 0019) and the UI.
 *
 * A session sits in exactly one place: **pinned** (the Pinned group at the top of
 * SESSIONS, in the order the developer dragged them into), in one **folder** (in
 * that folder's dragged order), or **loose** (no layout row: the list below the
 * folders, in the service's own order, newest first, as before D54). Folders are
 * one level (no nesting), in a manual order, each with a name and a remembered
 * collapsed state. The layout is this machine's: a paired machine's session
 * (remote id `r~<machine>~<id>`) can be pinned or put into a folder here, and
 * nothing of it goes to the peer.
 *
 * Every function returns a new layout and never mutates its input.
 */

/** A sidebar folder (D54). Not to be confused with a saved folder (D14, `Folder`). */
export interface SidebarFolder {
  readonly id: string;
  /** Trimmed, 1–{@link SIDEBAR_FOLDER_NAME_MAX} characters; names may repeat. */
  readonly name: string;
  /** Collapsed in the sidebar (remembered, the same in every tab). */
  readonly collapsed: boolean;
  /** Its sessions, in the dragged order (closed and unknown ids included: they are kept, not shown). */
  readonly sessionIds: readonly string[];
}

/** `GET /api/sidebar` (D54): the pinned sessions and the folders, each in its manual order. */
export interface SidebarLayout {
  readonly pinned: readonly string[];
  readonly folders: readonly SidebarFolder[];
}

/** Where a session goes (`POST /api/sidebar/place`). */
export type SidebarPlace = 'pinned' | 'folder' | 'loose';

/** The values of {@link SidebarPlace}. */
export const SIDEBAR_PLACES: readonly SidebarPlace[] = ['pinned', 'folder', 'loose'];

/** Body of `POST /api/sidebar/place`. `index` = the final position in the target group (absent = at its end); ignored for `loose`. */
export interface SidebarPlaceInput {
  readonly sessionId: string;
  readonly place: SidebarPlace;
  /** Required for `folder`. */
  readonly folderId?: string;
  readonly index?: number;
}

/** Body of `POST /api/sidebar/folders`. */
export interface SidebarFolderCreate {
  readonly name: string;
}

/** Body of `PUT /api/sidebar/folders/{folderId}`: any of the two. */
export interface SidebarFolderPatch {
  readonly name?: string;
  readonly collapsed?: boolean;
}

/** Body of `PUT /api/sidebar/folders/{folderId}/position`. */
export interface SidebarFolderMove {
  readonly index: number;
}

/** The longest folder name. */
export const SIDEBAR_FOLDER_NAME_MAX = 60;

/** The longest session id the layout stores (local ids are UUIDs; remote ids add the prefix and machine id). */
export const SIDEBAR_SESSION_ID_MAX = 300;

/** The name a new folder is offered with. */
export const NEW_FOLDER_NAME = 'New folder';

/** A layout with nothing pinned and no folder. */
export const EMPTY_SIDEBAR_LAYOUT: SidebarLayout = { pinned: [], folders: [] };

/** One validation problem (`422 { error: "invalid", errors }`). */
export interface SidebarFieldError {
  readonly field: string;
  readonly message: string;
}

/** A validation result. */
export type SidebarParse<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly SidebarFieldError[] };

function clamp(index: number | undefined, length: number): number {
  if (index === undefined || !Number.isFinite(index)) return length;
  return Math.max(0, Math.min(length, Math.trunc(index)));
}

function insertAt<T>(list: readonly T[], item: T, index: number | undefined): T[] {
  const out = [...list];
  out.splice(clamp(index, out.length), 0, item);
  return out;
}

/** Where a session sits now: `pinned`, the id of its folder, or `null` (loose). */
export function placeOf(layout: SidebarLayout, sessionId: string): 'pinned' | { readonly folderId: string } | null {
  if (layout.pinned.includes(sessionId)) return 'pinned';
  const folder = layout.folders.find((f) => f.sessionIds.includes(sessionId));
  return folder ? { folderId: folder.id } : null;
}

/** The layout without `sessionId` anywhere (it becomes loose). */
export function withoutSession(layout: SidebarLayout, sessionId: string): SidebarLayout {
  return {
    pinned: layout.pinned.filter((id) => id !== sessionId),
    folders: layout.folders.map((f) => (f.sessionIds.includes(sessionId) ? { ...f, sessionIds: f.sessionIds.filter((id) => id !== sessionId) } : f)),
  };
}

/**
 * Moves a session: out of wherever it is, into `place` at `index` (the final
 * position there, clamped; absent = the end). `loose` just takes it out.
 * `null` when `place` is `folder` and there is no folder `folderId`.
 */
export function placeSession(layout: SidebarLayout, input: SidebarPlaceInput): SidebarLayout | null {
  if (input.place === 'folder' && !layout.folders.some((f) => f.id === input.folderId)) return null;
  const rest = withoutSession(layout, input.sessionId);
  if (input.place === 'loose') return rest;
  if (input.place === 'pinned') return { ...rest, pinned: insertAt(rest.pinned, input.sessionId, input.index) };
  return {
    ...rest,
    folders: rest.folders.map((f) => (f.id === input.folderId ? { ...f, sessionIds: insertAt(f.sessionIds, input.sessionId, input.index) } : f)),
  };
}

/** A new, expanded, empty folder at the end of the folders. */
export function addFolder(layout: SidebarLayout, id: string, name: string): SidebarLayout {
  return { ...layout, folders: [...layout.folders, { id, name, collapsed: false, sessionIds: [] }] };
}

/** The folder's name and / or collapsed state changed; `null` when there is no such folder. */
export function updateFolder(layout: SidebarLayout, id: string, patch: SidebarFolderPatch): SidebarLayout | null {
  if (!layout.folders.some((f) => f.id === id)) return null;
  return {
    ...layout,
    folders: layout.folders.map((f) =>
      f.id === id ? { ...f, ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.collapsed !== undefined ? { collapsed: patch.collapsed } : {}) } : f,
    ),
  };
}

/** The folder is gone and its sessions are loose again; `null` when there is no such folder. */
export function removeFolder(layout: SidebarLayout, id: string): SidebarLayout | null {
  if (!layout.folders.some((f) => f.id === id)) return null;
  return { ...layout, folders: layout.folders.filter((f) => f.id !== id) };
}

/** The folder moves to `index` (its final position, clamped); `null` when there is no such folder. */
export function moveFolder(layout: SidebarLayout, id: string, index: number): SidebarLayout | null {
  const folder = layout.folders.find((f) => f.id === id);
  if (!folder) return null;
  return { ...layout, folders: insertAt(layout.folders.filter((f) => f.id !== id), folder, index) };
}

/**
 * The final index of `draggedId` when it is dropped just `side` of `anchorId` in
 * `ids` (the target group as stored, which may hold ids the sidebar does not show,
 * and `draggedId` itself for a move inside the group). `anchorId` `null` (or not
 * in the group) = at the end; dropped on itself = where it is.
 */
export function dropPosition(ids: readonly string[], draggedId: string, anchorId: string | null, side: 'before' | 'after'): number {
  if (anchorId === draggedId) {
    const at = ids.indexOf(draggedId);
    return at < 0 ? ids.length : at;
  }
  const rest = ids.filter((id) => id !== draggedId);
  const at = anchorId === null ? -1 : rest.indexOf(anchorId);
  if (at < 0) return rest.length;
  return side === 'before' ? at : at + 1;
}

/**
 * "Move up" (-1) / "Move down" (+1) of `id`: the final index in the stored group
 * `ids` that puts it before the previous / after the next item the sidebar shows
 * (`visible`, in order). `null` at an edge or when it is not shown.
 */
export function stepPosition(ids: readonly string[], visible: readonly string[], id: string, delta: -1 | 1): number | null {
  const at = visible.indexOf(id);
  if (at < 0) return null;
  const neighbour = visible[at + delta];
  if (neighbour === undefined) return null;
  return dropPosition(ids, id, neighbour, delta < 0 ? 'before' : 'after');
}

/** A folder with the sessions of the list that sit in it, in its order. */
export interface ArrangedFolder<T> {
  readonly folder: SidebarFolder;
  readonly sessions: readonly T[];
}

/** The sidebar's SESSIONS list, grouped: Pinned, then the folders in their order, then the loose sessions. */
export interface ArrangedSidebar<T> {
  readonly pinned: readonly T[];
  readonly folders: ReadonlyArray<ArrangedFolder<T>>;
  /** In the order of the given list (the service's: newest first). */
  readonly loose: readonly T[];
}

/**
 * Groups the listed (open) sessions by the layout. Ids the layout holds that the
 * list does not (a closed session, a peer's session that ended) are skipped, and
 * kept in the layout, so a reopened session comes back to its place (D54). A
 * session listed twice by a stale layout (never written so) shows once, in its
 * first place.
 */
export function arrangeSidebar<T extends { readonly id: string }>(sessions: readonly T[], layout: SidebarLayout): ArrangedSidebar<T> {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const placed = new Set<string>();
  const take = (ids: readonly string[]): T[] => {
    const out: T[] = [];
    for (const id of ids) {
      const session = byId.get(id);
      if (session && !placed.has(id)) {
        placed.add(id);
        out.push(session);
      }
    }
    return out;
  };
  const pinned = take(layout.pinned);
  const folders = layout.folders.map((folder) => ({ folder, sessions: take(folder.sessionIds) }));
  const loose = sessions.filter((s) => !placed.has(s.id));
  return { pinned, folders, loose };
}

/** `true` when a session of the list waits for the developer (status `need`): a collapsed folder shows it with a dot. */
export function needsYou(sessions: ReadonlyArray<{ readonly status: string }>): boolean {
  return sessions.some((s) => s.status === 'need');
}

/** A folder name, trimmed and checked. */
export function checkFolderName(value: unknown): SidebarParse<string> {
  if (typeof value !== 'string') return { ok: false, errors: [{ field: 'name', message: 'name must be a string' }] };
  const name = value.trim();
  if (name === '') return { ok: false, errors: [{ field: 'name', message: 'a folder needs a name' }] };
  if (name.length > SIDEBAR_FOLDER_NAME_MAX) return { ok: false, errors: [{ field: 'name', message: `a folder name has at most ${SIDEBAR_FOLDER_NAME_MAX} characters` }] };
  return { ok: true, value: name };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Reads `POST /api/sidebar/folders`. */
export function parseFolderCreate(body: unknown): SidebarParse<SidebarFolderCreate> {
  if (!isObject(body)) return { ok: false, errors: [{ field: 'body', message: 'expected { name }' }] };
  const name = checkFolderName(body['name']);
  return name.ok ? { ok: true, value: { name: name.value } } : name;
}

/** Reads `PUT /api/sidebar/folders/{folderId}`: `name` and / or `collapsed`, at least one. */
export function parseFolderPatch(body: unknown): SidebarParse<SidebarFolderPatch> {
  if (!isObject(body)) return { ok: false, errors: [{ field: 'body', message: 'expected { name?, collapsed? }' }] };
  const errors: SidebarFieldError[] = [];
  let name: string | undefined;
  let collapsed: boolean | undefined;
  if (body['name'] !== undefined) {
    const checked = checkFolderName(body['name']);
    if (checked.ok) name = checked.value;
    else errors.push(...checked.errors);
  }
  if (body['collapsed'] !== undefined) {
    if (typeof body['collapsed'] === 'boolean') collapsed = body['collapsed'];
    else errors.push({ field: 'collapsed', message: 'collapsed must be true or false' });
  }
  if (errors.length === 0 && name === undefined && collapsed === undefined) errors.push({ field: 'body', message: 'nothing to change: give name or collapsed' });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { ...(name !== undefined ? { name } : {}), ...(collapsed !== undefined ? { collapsed } : {}) } };
}

/** Reads `PUT /api/sidebar/folders/{folderId}/position`. */
export function parseFolderMove(body: unknown): SidebarParse<SidebarFolderMove> {
  if (!isObject(body) || !isIndex(body['index'])) return { ok: false, errors: [{ field: 'index', message: 'index must be a whole number ≥ 0' }] };
  return { ok: true, value: { index: body['index'] } };
}

/** Reads `POST /api/sidebar/place`. */
export function parsePlaceInput(body: unknown): SidebarParse<SidebarPlaceInput> {
  if (!isObject(body)) return { ok: false, errors: [{ field: 'body', message: 'expected { sessionId, place, folderId?, index? }' }] };
  const errors: SidebarFieldError[] = [];
  const sessionId = body['sessionId'];
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > SIDEBAR_SESSION_ID_MAX) errors.push({ field: 'sessionId', message: 'sessionId must be a session id' });
  const place = body['place'];
  if (typeof place !== 'string' || !(SIDEBAR_PLACES as readonly string[]).includes(place)) errors.push({ field: 'place', message: `place must be one of ${SIDEBAR_PLACES.join(', ')}` });
  const folderId = body['folderId'];
  if (place === 'folder' && (typeof folderId !== 'string' || folderId === '')) errors.push({ field: 'folderId', message: 'folderId names the folder' });
  const index = body['index'];
  if (index !== undefined && !isIndex(index)) errors.push({ field: 'index', message: 'index must be a whole number ≥ 0' });
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      sessionId: sessionId as string,
      place: place as SidebarPlace,
      ...(place === 'folder' ? { folderId: folderId as string } : {}),
      ...(index !== undefined && place !== 'loose' ? { index: index as number } : {}),
    },
  };
}
