/**
 * D97 (`docs/search.md` → *Opening a result*): bringing a chat's event into view
 * when the chat opens at it (a search result). Chat items carry their event's id
 * (`data-event-id`: a user bubble, an agent block, a step line); the innermost
 * element with the id is the one shown (a step line inside its block), centred
 * and marked `data-search-hit` for {@link SEARCH_HIT_MS} (the highlight).
 */

/** How long the highlight stays (ms; the CSS animation fades it out over this time). */
export const SEARCH_HIT_MS = 2_600;

/** The element of event `eventId` in `container`, `null` when the chat does not show it (not loaded, or not a chat line). */
export function eventElement(container: ParentNode, eventId: number): HTMLElement | null {
  const nodes = container.querySelectorAll<HTMLElement>(`[data-event-id="${eventId}"]`);
  return nodes.length === 0 ? null : (nodes[nodes.length - 1] ?? null);
}

/**
 * Scrolls `scroller` so event `eventId` sits in its middle and highlights it;
 * `false` when the chat does not show it (yet). The highlight is taken off after
 * {@link SEARCH_HIT_MS} (a later reveal of another event takes it off at once).
 */
export function revealEvent(scroller: HTMLElement, eventId: number): boolean {
  const node = eventElement(scroller, eventId);
  if (!node) return false;
  for (const old of scroller.querySelectorAll('[data-search-hit]')) old.removeAttribute('data-search-hit');
  const box = node.getBoundingClientRect();
  const frame = scroller.getBoundingClientRect();
  scroller.scrollTop += box.top - frame.top - Math.max(0, (scroller.clientHeight - box.height) / 2);
  node.setAttribute('data-search-hit', 'true');
  window.setTimeout(() => node.removeAttribute('data-search-hit'), SEARCH_HIT_MS);
  return true;
}
