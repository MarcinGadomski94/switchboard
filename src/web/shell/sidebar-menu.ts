/**
 * Where the sidebar's ⋯ menus open (Fix: sidebar scrolling, `docs/sidebar.md` →
 * *Layout and scrolling*). Pure, so the rule is unit-tested without a browser.
 */

/** The gap between a menu and its ⋯ button. */
export const MENU_GAP = 4;
/** The room a menu keeps from the window's edges. */
export const MENU_MARGIN = 8;

/**
 * Where a menu of `height` goes for a ⋯ button at `anchor` in a window `viewport`
 * high: under the button when it fits, else above it when it fits there, else
 * wherever it shows the most, kept inside the window (the sessions list scrolls
 * on its own, so a row near the window's bottom is common).
 */
export function menuTop(anchor: { readonly top: number; readonly bottom: number }, height: number, viewport: number): number {
  const below = anchor.bottom + MENU_GAP;
  if (below + height <= viewport - MENU_MARGIN) return below;
  const above = anchor.top - MENU_GAP - height;
  if (above >= MENU_MARGIN) return above;
  return Math.max(MENU_MARGIN, Math.min(below, viewport - MENU_MARGIN - height));
}

/** D71 (fix · drop a paired machine's session): how close to the list's top / bottom edge a held drag scrolls it, in px. */
export const DRAG_SCROLL_EDGE = 32;
/** The most the list scrolls per `dragover` (the pointer at the very edge). */
export const DRAG_SCROLL_MAX = 14;

/**
 * How far a drag held at `clientY` over the SESSIONS list (`box`) scrolls it on
 * one `dragover`: negative (up) within {@link DRAG_SCROLL_EDGE} px of its top,
 * positive (down) near its bottom, faster closer to the edge; 0 elsewhere.
 * The sidebar does this itself instead of relying on the browser's drag
 * auto-scroll, which WebKit (Safari, the "Add to Dock" app) does not do for a
 * scrolling box: there, a session far below the folders (a paired machine's
 * sessions are listed last) could not reach a folder.
 */
export function dragScrollStep(clientY: number, box: { readonly top: number; readonly bottom: number }): number {
  const height = box.bottom - box.top;
  const edge = Math.min(DRAG_SCROLL_EDGE, height / 4);
  if (edge <= 0 || clientY < box.top || clientY > box.bottom) return 0;
  const step = (distance: number): number => Math.max(1, Math.round(DRAG_SCROLL_MAX * (1 - distance / edge)));
  if (clientY < box.top + edge) return -step(clientY - box.top);
  if (clientY > box.bottom - edge) return step(box.bottom - clientY);
  return 0;
}
