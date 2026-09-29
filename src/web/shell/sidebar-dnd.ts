/**
 * D54 · what a drop in the sidebar's SESSIONS list does (`docs/sidebar.md` →
 * *Drag and drop*). Pure: the component (`SidebarSessions.tsx`) reports what is
 * dragged and what it is over; this decides the write and the drop indicator.
 */
import { type SidebarLayout, type SidebarPlaceInput, dropPosition } from '../../core/sidebar-layout.ts';

/** What is being dragged. */
export type DragItem = { readonly kind: 'session'; readonly id: string } | { readonly kind: 'folder'; readonly id: string };

/** The group a session row is shown in. */
export type RowGroup = { readonly kind: 'pinned' } | { readonly kind: 'folder'; readonly folderId: string } | { readonly kind: 'loose' };

/** Which half of the target the pointer is over. */
export type DropSide = 'before' | 'after';

/** What the pointer is over while dragging. */
export type DropOver =
  | { readonly zone: 'row'; readonly group: RowGroup; readonly sessionId: string; readonly side: DropSide }
  | { readonly zone: 'pinned-head' }
  | { readonly zone: 'folder-head'; readonly folderId: string; readonly side: DropSide }
  | { readonly zone: 'loose' };

/** The write a drop makes. */
export type DropAction =
  | { readonly kind: 'place'; readonly input: SidebarPlaceInput }
  | { readonly kind: 'move-folder'; readonly folderId: string; readonly index: number };

/** How the target shows the drop: a line before / after it, or highlighted as the container it goes into. */
export type DropIndicator = DropSide | 'into';

/** The half of a box `clientY` is in. */
export function sideOf(clientY: number, rect: { readonly top: number; readonly height: number }): DropSide {
  return clientY < rect.top + rect.height / 2 ? 'before' : 'after';
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
    if (over.zone !== 'folder-head') return null;
    const ids = layout.folders.map((f) => f.id);
    return { kind: 'move-folder', folderId: drag.id, index: dropPosition(ids, drag.id, over.folderId, over.side) };
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
    default:
      return 'into';
  }
}

/** `true` when two drop targets are the same (the component skips re-renders on every `dragover`). */
export function sameOver(a: DropOver | null, b: DropOver | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
