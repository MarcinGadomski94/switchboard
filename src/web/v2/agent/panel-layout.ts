/**
 * D180 · the side panel's layout rules, pure (`docs/v2.md` → *The agent view's side panel*).
 *
 * - From {@link WIDE_MIN} px the panel is **wide**: Files and Changes show their list docked on
 *   the outer (right) edge and the file or diff next to the chat. Narrower, the list comes first
 *   and an opened file or diff fills the panel; the list button pops the list over it.
 * - ⟷ switches the panel between {@link PANEL_NARROW} and {@link PANEL_WIDE} px (clamped by
 *   the room the view has, `sideMax`).
 * - Esc closes one thing at a time, in {@link ESC_ORDER}.
 */

/** From this panel width the list docks beside the file or diff (and Side by side is offered). */
export const WIDE_MIN = 760;
/** ⟷'s two widths. */
export const PANEL_NARROW = 560;
export const PANEL_WIDE = 820;

/** `true` when a panel `width` px wide lays its list beside the content. */
export function isWide(width: number): boolean {
  return width >= WIDE_MIN;
}

/**
 * What ⟷ does to a panel `width` px wide in a view whose widest panel is `max` px: a wide panel
 * goes to {@link PANEL_NARROW}, any other to {@link PANEL_WIDE} (never above `max`).
 */
export function toggledWidth(width: number, max: number): number {
  return isWide(width) ? Math.min(PANEL_NARROW, max) : Math.min(PANEL_WIDE, max);
}

/** What one Esc closes, first match first (the comment box and an open menu close themselves before these). */
export type EscTarget = 'popover' | 'reader' | 'helper' | 'diff';

/** The order Esc goes through what is open (after the comment box and a menu). */
export const ESC_ORDER: readonly EscTarget[] = ['popover', 'reader', 'helper', 'diff'];

/** What is open in the panel now, as far as Esc is concerned. */
export interface EscState {
  /** The list popped over the content (narrow). */
  readonly popover: boolean;
  /** Files' reader, filling a narrow panel. */
  readonly reader: boolean;
  /** A helper's chat in the panel. */
  readonly helper: boolean;
  /** Changes' diff, filling a narrow panel. */
  readonly diff: boolean;
}

/** What one Esc closes now (`null`: nothing of the panel's; the key goes on to the page). */
export function escTarget(state: EscState): EscTarget | null {
  return ESC_ORDER.find((target) => state[target]) ?? null;
}
