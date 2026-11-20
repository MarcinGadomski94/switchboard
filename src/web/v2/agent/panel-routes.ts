/**
 * SPIKE · the addresses that only open something in the side panel on a desktop or a
 * tablet-wide window (`…/changes`, `…/helpers`): the chat stays where it is, so the
 * address goes back to the agent's own. Pure.
 */

/**
 * How to leave such an address. `openedFrom`: the page its history entry was opened
 * from inside the app (the router notes it in the entry, D36), `null` when unknown (a
 * pasted or reloaded address). Opened from the agent's own page: one step back, so
 * Back does not meet that page twice. From anywhere else: the address is replaced, and
 * Back still returns to where the reader came from.
 */
export function leavePanelAddress(openedFrom: string | null, base: string): 'back' | 'replace' {
  return openedFrom === base ? 'back' : 'replace';
}
