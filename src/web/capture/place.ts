/**
 * D81 · the chat selection's "Add to todo": where the floating action (and its popover) sits.
 * Pure, so the unit tests cover it.
 */

/** A rectangle in viewport pixels. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The gap between the selection and the floating action (px). */
export const FLOAT_GAP = 8;

/** The margin kept to the viewport's edges (px). */
export const FLOAT_MARGIN = 8;

/**
 * The top-left of a `size` box next to the selection `rect` in a `viewport`: below the
 * selection's end (where a touch device's own callout is not: it sits above), centred on it,
 * else above it when there is no room below, always inside the viewport by {@link FLOAT_MARGIN}.
 */
export function floatPlace(rect: Box, size: { readonly width: number; readonly height: number }, viewport: { readonly width: number; readonly height: number }): { readonly left: number; readonly top: number; readonly below: boolean } {
  const center = rect.left + rect.width / 2;
  const left = Math.min(Math.max(center - size.width / 2, FLOAT_MARGIN), Math.max(FLOAT_MARGIN, viewport.width - size.width - FLOAT_MARGIN));
  const belowTop = rect.top + rect.height + FLOAT_GAP;
  if (belowTop + size.height + FLOAT_MARGIN <= viewport.height) return { left, top: belowTop, below: true };
  const aboveTop = rect.top - FLOAT_GAP - size.height;
  if (aboveTop >= FLOAT_MARGIN) return { left, top: aboveTop, below: false };
  // Neither fits (a selection taller than the window): inside the window, at its bottom.
  return { left, top: Math.max(FLOAT_MARGIN, viewport.height - size.height - FLOAT_MARGIN), below: true };
}

/** What {@link selectionIn} reads of the conversation element (a DOM `Node`). */
export interface SelectionContainer {
  contains(node: never): boolean;
}

/** What {@link selectionIn} reads of the page's selection (a DOM `Selection`). */
export interface SelectionLike {
  readonly isCollapsed: boolean;
  readonly rangeCount: number;
  readonly anchorNode: unknown;
  readonly focusNode: unknown;
  toString(): string;
}

/** The selected text when the whole selection lies inside `container` (`null` when collapsed, empty or elsewhere). */
export function selectionIn(container: SelectionContainer | null, selection: SelectionLike | null): string | null {
  if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const inside = (node: unknown): boolean => node !== null && node !== undefined && (container.contains as (node: unknown) => boolean)(node);
  if (!inside(selection.anchorNode) || !inside(selection.focusNode)) return null;
  const text = selection.toString().trim();
  return text === '' ? null : text;
}
