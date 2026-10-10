import { type RefObject, useLayoutEffect } from 'react';

/**
 * D95 (`docs/performance.md` → *Browser memory*): lets React forget the field when
 * its component unmounts while the field has the focus. React DOM keeps the focused
 * text field in a module variable (for its `onSelect` events) until a `focusout`,
 * which a field removed from the page never sends: the field, and the whole view it
 * was part of (a long chat: tens of thousands of nodes), stayed in memory after the
 * view was left (until another text field took the focus). A blur during the
 * unmount does not help (React ignores events while it commits), so once the
 * commit is over a `focusout` is sent to React's root (`#root`): nothing in the
 * page handles a focusout of the root itself, and the focus is already gone with
 * the field.
 */
export function useReleaseFocus(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(
    () => () => {
      // Read at unmount: the field may have mounted after this component (React clears the ref only after this runs).
      const field = ref.current;
      if (!field || field.ownerDocument.activeElement !== field) return;
      const root = field.closest('#root');
      queueMicrotask(() => {
        if (root && !field.isConnected) root.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });
    },
    [ref],
  );
}
