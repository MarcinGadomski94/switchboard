/**
 * D54 · what a drop in the sidebar's SESSIONS list does (`docs/sidebar.md` →
 * *Drag and drop*); D58: folders also drop into folders (subfolders). Pure: the component (`SidebarSessions.tsx`) reports what is
 * dragged and what it is over; this decides the write and the drop indicator.
 */
import { type SidebarLayout, type SidebarPlaceInput, checkFolderParent, childFolders, dropPosition, parentOf } from '../../core/sidebar-layout.ts';

/** What is being dragged. */
export type DragItem = { readonly kind: 'session'; readonly id: string } | { readonly kind: 'folder'; readonly id: string };

/** The group a session row is shown in. */
export type RowGroup = { readonly kind: 'pinned' } | { readonly kind: 'folder'; readonly folderId: string } | { readonly kind: 'loose' };

/** Which half of the target the pointer is over. */
export type DropSide = 'before' | 'after';

/** D58: which part of a folder head the pointer is over: its upper / lower quarter, or the middle (into it). */
export type FolderDropSide = DropSide | 'into';

/** What the pointer is over while dragging. */
export type DropOver =
  | { readonly zone: 'row'; readonly group: RowGroup; readonly sessionId: string; readonly side: DropSide }
  | { readonly zone: 'pinned-head' }
  | { readonly zone: 'folder-head'; readonly folderId: string; readonly side: FolderDropSide }
  | { readonly zone: 'loose' };

/** The write a drop makes. `parentId` (D58): the folder a moved folder goes into, `null` = the top level. */
export type DropAction =
  | { readonly kind: 'place'; readonly input: SidebarPlaceInput }
  | { readonly kind: 'move-folder'; readonly folderId: string; readonly index: number; readonly parentId: string | null };

/** How the target shows the drop: a line before / after it, or highlighted as the container it goes into. */
export type DropIndicator = DropSide | 'into';

/** The half of a box `clientY` is in. */
export function sideOf(clientY: number, rect: { readonly top: number; readonly height: number }): DropSide {
  return clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

/**
 * D58: the part of a folder head `clientY` is in: the upper quarter is before it,
 * the lower quarter after it, the middle into it (a dragged folder becomes its
 * subfolder; a dragged session goes into it whatever the part).
 */
export function folderSideOf(clientY: number, rect: { readonly top: number; readonly height: number }): FolderDropSide {
  if (clientY < rect.top + rect.height / 4) return 'before';
  if (clientY >= rect.top + (rect.height * 3) / 4) return 'after';
  return 'into';
}

/** D58: moving folder `id` to `index` among the folders of `parentId`, or `null` when that is refused (a loop, too deep). */
function folderMove(layout: SidebarLayout, id: string, parentId: string | null, index: number): DropAction | null {
  if (checkFolderParent(layout, id, parentId) !== null) return null;
  return { kind: 'move-folder', folderId: id, index, parentId };
}

function isLoose(layout: SidebarLayout, id: string): boolean {
  return !layout.pinned.includes(id) && !layout.folders.some((f) => f.sessionIds.includes(id));
}

/**
 * The write dropping `drag` on `over` makes, or `null` when the drop does nothing
 * (a folder dropped on a session, a loose session dropped among the loose ones: that
 * list keeps the service's order).
 */
export function resolveDrop(layout: SidebarLayout, drag: DragItem, over: DropOver): DropAction | null {
  if (drag.kind === 'folder') {
    const dragged = layout.folders.find((f) => f.id === drag.id);
    if (!dragged) return null;
    // D58: out to the top level (at the end of the folders) from the loose list.
    if (over.zone === 'loose' || (over.zone === 'row' && over.group.kind === 'loose')) {
      return parentOf(dragged) === null ? null : folderMove(layout, drag.id, null, childFolders(layout, null).filter((f) => f.id !== drag.id).length);
    }
    if (over.zone !== 'folder-head' || over.folderId === drag.id) return null;
    const target = layout.folders.find((f) => f.id === over.folderId);
    if (!target) return null;
    if (over.side === 'into') return folderMove(layout, drag.id, target.id, childFolders(layout, target.id).filter((f) => f.id !== drag.id).length);
    const parent = parentOf(target);
    const ids = childFolders(layout, parent).map((f) => f.id);
    return folderMove(layout, drag.id, parent, dropPosition(ids, drag.id, target.id, over.side));
  }
  const sessionId = drag.id;
  switch (over.zone) {
    case 'pinned-head':
      return { kind: 'place', input: { sessionId, place: 'pinned', index: 0 } };
    case 'folder-head': {
      const folder = layout.folders.find((f) => f.id === over.folderId);
      if (!folder) return null;
      return { kind: 'place', input: { sessionId, place: 'folder', folderId: folder.id, index: folder.sessionIds.filter((id) => id !== sessionId).length } };
    }
    case 'loose':
      return isLoose(layout, sessionId) ? null : { kind: 'place', input: { sessionId, place: 'loose' } };
    case 'row': {
      const { group } = over;
      if (group.kind === 'loose') return isLoose(layout, sessionId) ? null : { kind: 'place', input: { sessionId, place: 'loose' } };
      if (group.kind === 'pinned') return { kind: 'place', input: { sessionId, place: 'pinned', index: dropPosition(layout.pinned, sessionId, over.sessionId, over.side) } };
      const folder = layout.folders.find((f) => f.id === group.folderId);
      if (!folder) return null;
      return { kind: 'place', input: { sessionId, place: 'folder', folderId: folder.id, index: dropPosition(folder.sessionIds, sessionId, over.sessionId, over.side) } };
    }
  }
}

/** How the element under the pointer shows the drop (`null` = no indicator: the drop does nothing). */
export function indicatorOf(layout: SidebarLayout, drag: DragItem, over: DropOver): DropIndicator | null {
  if (resolveDrop(layout, drag, over) === null) return null;
  switch (over.zone) {
    case 'row':
      return over.group.kind === 'loose' ? 'into' : over.side;
    case 'folder-head':
      return drag.kind === 'folder' ? over.side : 'into';
    case 'loose':
      return 'into';
    default:
      return 'into';
  }
}

/** `true` when two drop targets are the same (the component skips re-renders on every `dragover`). */
export function sameOver(a: DropOver | null, b: DropOver | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
