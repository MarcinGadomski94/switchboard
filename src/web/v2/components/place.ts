/**
 * D131 · where a v2 menu or popover goes (pure; unit-tested).
 */

/** Where a floating box goes under (or over) its anchor, kept inside the window. Pure. */
export function placeBelow(
  anchor: { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number },
  box: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  align: 'start' | 'end' = 'start',
  gap = 6,
): { readonly top: number; readonly left: number } {
  const margin = 8;
  let left = align === 'end' ? anchor.right - box.width : anchor.left;
  left = Math.max(margin, Math.min(left, viewport.width - box.width - margin));
  let top = anchor.bottom + gap;
  if (top + box.height > viewport.height - margin && anchor.top - gap - box.height >= margin) top = anchor.top - gap - box.height;
  top = Math.max(margin, Math.min(top, viewport.height - box.height - margin));
  return { top, left };
}
