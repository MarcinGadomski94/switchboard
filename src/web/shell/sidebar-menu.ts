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
