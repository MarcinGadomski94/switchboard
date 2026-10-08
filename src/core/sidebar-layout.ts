/**
 * D54 · the sidebar's pins and folders (`docs/sidebar.md`): the pure layout
 * rules shared by the server (`/api/sidebar*`, migrations 0019 and 0021) and the UI.
 *
 * A session sits in exactly one place: **pinned** (the Pinned group at the top of
 * SESSIONS, in the order the developer dragged them into), in one **folder** (in
 * that folder's dragged order), or **loose** (the list below the folders). D71:
 * the loose list is the **unplaced** sessions first (never placed, or unpinned /
 * taken out of a folder: in the service's own order, newest first, as before
 * D54, so a new session shows at the top), then the loose sessions the
 * developer put in an order (`loose`, the dragged order). Folders are
 * in a manual order, each with a name and a remembered collapsed state; since
 * D58 a folder can hold folders too (subfolders, up to
 * {@link SIDEBAR_FOLDER_DEPTH_MAX} levels), each level in its own manual order. A paired machine's session
 * (remote id `r~<machine>~<id>`) can be pinned or put into a folder here. D71:
 * the layout is stored as records (`sidebar-records.ts`) and can be shared
 * with paired machines (off until switched on per machine).
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
  /**
   * D58: the folder it sits in, `null` (or absent, a D54-shaped layout) = top
   * level. The service always sends it.
   */
  readonly parentId?: string | null;
}

/**
 * `GET /api/sidebar` (D54): the pinned sessions and the folders, each in its
 * manual order. D58: `folders` is the folder tree in **tree order** (each folder
 * followed by its subfolders, depth first); the folders with the same
 * `parentId` are in their manual order.
 */
export interface SidebarLayout {
  readonly pinned: readonly string[];
  readonly folders: readonly SidebarFolder[];
  /**
   * D71: the loose sessions in the dragged order, listed after the unplaced
   * ones (closed and unknown ids included: kept, not shown). The service always
   * sends it; absent (a D54-shaped layout) = none.
   */
  readonly loose?: readonly string[];
}

/** Where a session goes (`POST /api/sidebar/place`). */
export type SidebarPlace = 'pinned' | 'folder' | 'loose';

/** The values of {@link SidebarPlace}. */
export const SIDEBAR_PLACES: readonly SidebarPlace[] = ['pinned', 'folder', 'loose'];

/**
 * Body of `POST /api/sidebar/place`. `index` = the final position in the target
 * group (absent = at its end). D71: for `loose`, `index` is the position in the
 * whole loose list as shown (the unplaced sessions, then {@link SidebarLayout.loose};
 * the unplaced ones get their places in that order too), and absent = unplaced
 * (the top of the loose list, in the service's order).
 */
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
  /** D58: the folder to create it in (at the end of its subfolders); absent / `null` = top level. */
  readonly parentId?: string | null;
}

/** Body of `PUT /api/sidebar/folders/{folderId}`: any of the two. */
export interface SidebarFolderPatch {
  readonly name?: string;
  readonly collapsed?: boolean;
}

/** Body of `PUT /api/sidebar/folders/{folderId}/position`. */
export interface SidebarFolderMove {
  /** The final position among the folders of its (new) level. */
  readonly index: number;
  /** D58: the folder it goes into; `null` = the top level; absent = it stays at its level (D54's re-order). */
  readonly parentId?: string | null;
}

/** D58: how deep folders nest (a top-level folder is level 1). */
export const SIDEBAR_FOLDER_DEPTH_MAX = 5;

/** The longest folder name. */
export const SIDEBAR_FOLDER_NAME_MAX = 60;

/** The longest session id the layout stores (local ids are UUIDs; remote ids add the prefix and machine id). */
export const SIDEBAR_SESSION_ID_MAX = 300;

/** The name a new folder is offered with. */
export const NEW_FOLDER_NAME = 'New folder';

/** A layout with nothing pinned and no folder. */
export const EMPTY_SIDEBAR_LAYOUT: SidebarLayout = { pinned: [], folders: [], loose: [] };

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

/** Where a session sits now: `pinned`, the id of its folder, or `null` (loose: unplaced or in the loose order). */
export function placeOf(layout: SidebarLayout, sessionId: string): 'pinned' | { readonly folderId: string } | null {
  if (layout.pinned.includes(sessionId)) return 'pinned';
  const folder = layout.folders.find((f) => f.sessionIds.includes(sessionId));
  return folder ? { folderId: folder.id } : null;
}

/** D71: the stored loose order (none for a D54-shaped layout). */
export function looseOf(layout: SidebarLayout): readonly string[] {
  return layout.loose ?? [];
}

/** D71: `true` when the layout holds `sessionId` somewhere (pinned, in a folder, or in the loose order). */
export function isPlaced(layout: SidebarLayout, sessionId: string): boolean {
  return placeOf(layout, sessionId) !== null || looseOf(layout).includes(sessionId);
}

/**
 * D71: the whole loose list as shown, hidden ids included: the ids of `listed`
 * (the service's order) that the layout does not hold, then the stored loose
 * order. A loose drop's `index` counts in it.
 */
export function looseList(layout: SidebarLayout, listed: readonly string[]): string[] {
  return [...listed.filter((id) => !isPlaced(layout, id)), ...looseOf(layout)];
}

/** The layout without `sessionId` anywhere (it becomes loose, unplaced). */
export function withoutSession(layout: SidebarLayout, sessionId: string): SidebarLayout {
  return {
    pinned: layout.pinned.filter((id) => id !== sessionId),
    folders: layout.folders.map((f) => (f.sessionIds.includes(sessionId) ? { ...f, sessionIds: f.sessionIds.filter((id) => id !== sessionId) } : f)),
    loose: looseOf(layout).filter((id) => id !== sessionId),
  };
}

/**
 * Moves a session: out of wherever it is, into `place` at `index` (the final
 * position there, clamped; absent = the end). `loose` without `index` takes it
 * out (unplaced); D71: `loose` with `index` puts it at that position of the
 * whole loose list ({@link looseList} of `listed`, the service's order of the
 * listed sessions), and the unplaced sessions before it keep their places in
 * that order. `null` when `place` is `folder` and there is no folder `folderId`.
 */
export function placeSession(layout: SidebarLayout, input: SidebarPlaceInput, listed: readonly string[] = []): SidebarLayout | null {
  if (input.place === 'folder' && !layout.folders.some((f) => f.id === input.folderId)) return null;
  const rest = withoutSession(layout, input.sessionId);
  if (input.place === 'loose') {
    if (input.index === undefined) return rest;
    return { ...rest, loose: insertAt(looseList(rest, listed.filter((id) => id !== input.sessionId)), input.sessionId, input.index) };
  }
  if (input.place === 'pinned') return { ...rest, pinned: insertAt(rest.pinned, input.sessionId, input.index) };
  return {
    ...rest,
    folders: rest.folders.map((f) => (f.id === input.folderId ? { ...f, sessionIds: insertAt(f.sessionIds, input.sessionId, input.index) } : f)),
  };
}

/**
 * D83: the fresh session `newId` takes the place of the session it continues
 * (`oldId`): pinned at its position, in its folder at its position, or at its
 * place in the loose order; the old id leaves the layout. `null` (nothing to
 * change) when the old session was never placed (both are then unplaced: the new
 * one shows at the top, newest first) or the new one is placed already (it was
 * moved since, or this ran before).
 */
export function inheritPlace(layout: SidebarLayout, oldId: string, newId: string): SidebarLayout | null {
  if (isPlaced(layout, newId) || !isPlaced(layout, oldId)) return null;
  const swap = (ids: readonly string[]): string[] => ids.map((id) => (id === oldId ? newId : id));
  return {
    pinned: swap(layout.pinned),
    folders: layout.folders.map((f) => (f.sessionIds.includes(oldId) ? { ...f, sessionIds: swap(f.sessionIds) } : f)),
    loose: swap(looseOf(layout)),
  };
}

/** D58: the folder a folder sits in (`null` = top level). */
export function parentOf(folder: SidebarFolder): string | null {
  return folder.parentId ?? null;
}

/**
 * D58: the folders in tree order (each followed by its subfolders, depth first;
 * siblings keep their order in `folders`), every one with an explicit
 * `parentId`. A folder whose parent is missing, or that sits in a loop (never
 * written so), is put at the top level: nothing is lost.
 */
export function normalizeFolders(folders: readonly SidebarFolder[]): SidebarFolder[] {
  const ids = new Set(folders.map((f) => f.id));
  const children = new Map<string | null, SidebarFolder[]>();
  for (const folder of folders) {
    const parent = parentOf(folder);
    const key = parent !== null && ids.has(parent) && parent !== folder.id ? parent : null;
    const list = children.get(key) ?? [];
    list.push(key === parent ? folder : { ...folder, parentId: key });
    children.set(key, list);
  }
  const out: SidebarFolder[] = [];
  const seen = new Set<string>();
  const visit = (folder: SidebarFolder): void => {
    if (seen.has(folder.id)) return;
    seen.add(folder.id);
    out.push(folder.parentId === undefined ? { ...folder, parentId: null } : folder);
    for (const child of children.get(folder.id) ?? []) visit(child);
  };
  for (const root of children.get(null) ?? []) visit(root);
  // Folders in a loop: none of them is reachable from the top level.
  for (const folder of folders) {
    if (!seen.has(folder.id)) {
      const lifted = (children.get(parentOf(folder)) ?? []).find((f) => f.id === folder.id) ?? folder;
      visit({ ...lifted, parentId: null });
    }
  }
  return out;
}

/** D58: the subfolders of `parentId` (`null` = the top-level folders), in their order. */
export function childFolders(layout: SidebarLayout, parentId: string | null): SidebarFolder[] {
  return layout.folders.filter((f) => parentOf(f) === parentId);
}

/** D58: the level of a folder (a top-level folder is 1); 0 for `null` (the top level itself) or an unknown id. */
export function folderDepth(layout: SidebarLayout, id: string | null): number {
  const byId = new Map(layout.folders.map((f) => [f.id, f]));
  let depth = 0;
  let at = id === null ? undefined : byId.get(id);
  while (at && depth <= layout.folders.length) {
    depth += 1;
    const parent = parentOf(at);
    at = parent === null ? undefined : byId.get(parent);
  }
  return depth;
}

/** D58: the ids of every folder inside `id`, at any depth (not `id` itself). */
export function descendantIds(layout: SidebarLayout, id: string): string[] {
  const out: string[] = [];
  const queue = [id];
  const seen = new Set([id]);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of childFolders(layout, current)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child.id);
      queue.push(child.id);
    }
  }
  return out;
}

/** D58: how many levels a folder spans with its subfolders (1 = no subfolder). */
export function subtreeHeight(layout: SidebarLayout, id: string): number {
  const base = folderDepth(layout, id);
  return Math.max(base, ...descendantIds(layout, id).map((d) => folderDepth(layout, d))) - base + 1;
}

/** Why a folder cannot go where asked (D58). */
export type SidebarTreeProblem = { readonly kind: 'not-found'; readonly id: string } | { readonly kind: 'invalid'; readonly message: string };

/**
 * D58: whether folder `folderId` (`null` = a new folder) may sit in `parentId`
 * (`null` = the top level): both exist, the parent is not the folder itself or
 * one of its subfolders (no loops), and the deepest folder stays within
 * {@link SIDEBAR_FOLDER_DEPTH_MAX} levels. `null` = fine.
 */
export function checkFolderParent(layout: SidebarLayout, folderId: string | null, parentId: string | null): SidebarTreeProblem | null {
  if (folderId !== null && !layout.folders.some((f) => f.id === folderId)) return { kind: 'not-found', id: folderId };
  if (parentId !== null && !layout.folders.some((f) => f.id === parentId)) return { kind: 'not-found', id: parentId };
  if (folderId !== null && parentId !== null && (parentId === folderId || descendantIds(layout, folderId).includes(parentId))) {
    return { kind: 'invalid', message: 'a folder cannot go into itself or one of its subfolders' };
  }
  const height = folderId === null ? 1 : subtreeHeight(layout, folderId);
  if (folderDepth(layout, parentId) + height > SIDEBAR_FOLDER_DEPTH_MAX) {
    return { kind: 'invalid', message: `folders nest at most ${SIDEBAR_FOLDER_DEPTH_MAX} levels deep` };
  }
  return null;
}

/**
 * Puts `folder` (not in `rest`) among the subfolders of its `parentId` at
 * `index` (clamped; absent = the end), keeping the tree order.
 */
function insertFolder(rest: readonly SidebarFolder[], folder: SidebarFolder, index: number | undefined): SidebarFolder[] {
  const parent = parentOf(folder);
  const siblings = rest.filter((f) => parentOf(f) === parent);
  const at = clamp(index, siblings.length);
  const out = [...rest];
  const anchor = siblings[at];
  if (anchor) out.splice(out.indexOf(anchor), 0, folder);
  else out.push(folder);
  return normalizeFolders(out);
}

/**
 * A new, expanded, empty folder at the end of the folders of `parentId` (D58;
 * `null` / absent = the top level, as D54). `null` when the parent is unknown,
 * or too deep ({@link checkFolderParent}).
 */
export function addFolder(layout: SidebarLayout, id: string, name: string, parentId: string | null = null): SidebarLayout | null {
  if (checkFolderParent(layout, null, parentId) !== null) return null;
  return { ...layout, folders: insertFolder(normalizeFolders(layout.folders), { id, name, collapsed: false, sessionIds: [], parentId }, undefined) };
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

/**
 * The folder is gone; nothing inside it is lost (D58): its subfolders move up
 * one level, into its place among its siblings (in their order), and its
 * sessions go to the end of its parent folder, or are loose again when it was
 * a top-level folder (D54). `null` when there is no such folder.
 */
export function removeFolder(layout: SidebarLayout, id: string): SidebarLayout | null {
  const folder = layout.folders.find((f) => f.id === id);
  if (!folder) return null;
  const parent = parentOf(folder);
  const tree = normalizeFolders(layout.folders);
  const folders = tree
    .filter((f) => f.id !== id)
    .map((f) => {
      let next = f;
      if (parentOf(f) === id) next = { ...next, parentId: parent };
      if (parent !== null && f.id === parent) next = { ...next, sessionIds: [...f.sessionIds, ...folder.sessionIds.filter((s) => !f.sessionIds.includes(s))] };
      return next;
    });
  return { ...layout, folders: normalizeFolders(folders) };
}

/**
 * The folder moves to `index` (its final position, clamped) among the folders
 * of `parentId` (D58: another folder, `null` = the top level, absent = the
 * level it is at), with its subfolders and sessions. `null` when there is no
 * such folder or the move is refused ({@link checkFolderParent}: an unknown
 * parent, into itself or a subfolder of its own, too deep).
 */
export function moveFolder(layout: SidebarLayout, id: string, index: number, parentId?: string | null): SidebarLayout | null {
  const folder = layout.folders.find((f) => f.id === id);
  if (!folder) return null;
  const target = parentId === undefined ? parentOf(folder) : parentId;
  if (checkFolderParent(layout, id, target) !== null) return null;
  const rest = normalizeFolders(layout.folders).filter((f) => f.id !== id);
  return { ...layout, folders: insertFolder(rest, { ...folder, parentId: target }, index) };
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
  /** D58: 0 for a top-level folder, 1 for its subfolders, … */
  readonly level: number;
  /** D58: a folder above it is collapsed, so it is not shown. */
  readonly hidden: boolean;
  /** D58: its sessions and those of its subfolders at any depth (a collapsed folder's count and amber dot). */
  readonly total: readonly T[];
}

/** The sidebar's SESSIONS list, grouped: Pinned, then the folders in their order, then the loose sessions. */
export interface ArrangedSidebar<T> {
  readonly pinned: readonly T[];
  /** In tree order (D58): each folder followed by its subfolders. */
  readonly folders: ReadonlyArray<ArrangedFolder<T>>;
  /** D71: the unplaced sessions in the order of the given list (the service's: newest first), then the loose order. */
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
  const tree = normalizeFolders(layout.folders);
  const own = tree.map((folder) => ({ folder, sessions: take(folder.sessionIds) }));
  const level = new Map<string, number>();
  const hidden = new Map<string, boolean>();
  for (const { folder } of own) {
    const parent = parentOf(folder);
    const parentFolder = parent === null ? undefined : tree.find((f) => f.id === parent);
    level.set(folder.id, parent === null ? 0 : (level.get(parent) ?? 0) + 1);
    hidden.set(folder.id, parentFolder !== undefined && (parentFolder.collapsed || (hidden.get(parentFolder.id) ?? false)));
  }
  // Totals bottom-up: the tree order puts every folder before its subfolders.
  const total = new Map<string, T[]>(own.map((f) => [f.folder.id, [...f.sessions]]));
  for (let i = own.length - 1; i >= 0; i--) {
    const folder = own[i]?.folder as SidebarFolder;
    const parent = parentOf(folder);
    if (parent !== null) total.get(parent)?.push(...(total.get(folder.id) ?? []));
  }
  const folders = own.map(({ folder, sessions: inside }) => ({
    folder,
    sessions: inside,
    level: level.get(folder.id) ?? 0,
    hidden: hidden.get(folder.id) ?? false,
    total: total.get(folder.id) ?? [],
  }));
  // D71: the stored loose order after the unplaced sessions (taken last, so a stale duplicate keeps its first place).
  const ordered = new Set(looseOf(layout));
  const unplaced = sessions.filter((s) => !placed.has(s.id) && !ordered.has(s.id));
  const loose = [...unplaced, ...take(looseOf(layout))];
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

/** D58: an optional `parentId`: absent, `null` (the top level) or a folder id. */
function readParentId(body: Record<string, unknown>, errors: SidebarFieldError[]): { readonly parentId?: string | null } {
  const value = body['parentId'];
  if (value === undefined) return {};
  if (value === null) return { parentId: null };
  if (typeof value === 'string' && value !== '' && value.length <= SIDEBAR_SESSION_ID_MAX) return { parentId: value };
  errors.push({ field: 'parentId', message: 'parentId must be a folder id or null (the top level)' });
  return {};
}

/** Reads `POST /api/sidebar/folders` (D58: an optional `parentId`). */
export function parseFolderCreate(body: unknown): SidebarParse<SidebarFolderCreate> {
  if (!isObject(body)) return { ok: false, errors: [{ field: 'body', message: 'expected { name, parentId? }' }] };
  const errors: SidebarFieldError[] = [];
  const name = checkFolderName(body['name']);
  if (!name.ok) errors.push(...name.errors);
  const parent = readParentId(body, errors);
  if (errors.length > 0 || !name.ok) return { ok: false, errors };
  return { ok: true, value: { name: name.value, ...parent } };
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

/** Reads `PUT /api/sidebar/folders/{folderId}/position` (D58: an optional `parentId`). */
export function parseFolderMove(body: unknown): SidebarParse<SidebarFolderMove> {
  if (!isObject(body)) return { ok: false, errors: [{ field: 'index', message: 'index must be a whole number ≥ 0' }] };
  const errors: SidebarFieldError[] = [];
  if (!isIndex(body['index'])) errors.push({ field: 'index', message: 'index must be a whole number ≥ 0' });
  const parent = readParentId(body, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { index: body['index'] as number, ...parent } };
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
      ...(index !== undefined ? { index: index as number } : {}),
    },
  };
}
