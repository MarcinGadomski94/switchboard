/**
 * D74 · responsive layout (`docs/responsive.md`): the window widths the UI adapts
 * at. Pure, so the thresholds are unit-tested and shared by the CSS media queries'
 * comments, the React side (`useLayout.ts`) and the E2E specs.
 *
 * - **desktop** (≥ 1280 px): the prototype's layout, unchanged (the visual oracle
 *   measures it at 1440×900; 1366 and 1920 are desktop too).
 * - **tablet** (768–1279 px): the sidebar is a slide-over drawer opened from the
 *   top app bar, the session's right panel a drawer from the right.
 * - **phone** (≤ 767 px): one column; the sidebar a full-screen drawer, the right
 *   panel a bottom sheet, dialogs full-screen sheets.
 *
 * The CSS uses the same numbers: `(max-width: 1279px)` (compact = tablet + phone),
 * `(max-width: 1023px)` (tablet portrait and below: the session header's actions
 * move into its ⋯ menu) and `(max-width: 767px)` (phone). Touch sizing keys on
 * `(pointer: coarse)`, independent of the width.
 */

/** The narrowest desktop window: everything at this width and above is the prototype's layout. */
export const DESKTOP_MIN = 1280;
/** The narrowest tablet window (portrait tablets are 768 px). */
export const TABLET_MIN = 768;
/** Below this the session header's actions sit in its ⋯ menu (tablet portrait and phones). */
export const HEADER_MENU_BELOW = 1024;

/** The layout the UI takes at a width. */
export type Layout = 'desktop' | 'tablet' | 'phone';

/** The media query of each compact layout (the CSS uses the same thresholds). */
export const COMPACT_QUERY = `(max-width: ${DESKTOP_MIN - 1}px)`;
export const PHONE_QUERY = `(max-width: ${TABLET_MIN - 1}px)`;
export const HEADER_MENU_QUERY = `(max-width: ${HEADER_MENU_BELOW - 1}px)`;
/** A touch screen (or another imprecise pointer) is the primary pointer. */
export const COARSE_QUERY = '(pointer: coarse)';

/** The layout at a window `width` in CSS pixels. */
export function layoutOf(width: number): Layout {
  if (width >= DESKTOP_MIN) return 'desktop';
  return width >= TABLET_MIN ? 'tablet' : 'phone';
}

/** `true` for the tablet and phone layouts (the sidebar and the right panel are drawers). */
export function isCompact(layout: Layout): boolean {
  return layout !== 'desktop';
}
