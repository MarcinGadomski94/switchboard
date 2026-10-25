import { type ReactNode, createContext, useContext } from 'react';
import { createPortal } from 'react-dom';

/**
 * D131 · where v2 overlays render (menus, popovers, dialogs, sheets, drawers):
 * the `.v2-overlays` layer at the end of the v2 root (`App.tsx`), outside any
 * scroller or blurred bar (a `backdrop-filter` makes an ancestor the containing
 * block of `position: fixed`, which would shift them). Outside the v2 root (a
 * unit render) they render in place.
 */
export const OverlayRoot = createContext<HTMLElement | null>(null);

/** Renders `children` into the overlay layer. */
export function Portal({ children }: { readonly children: ReactNode }) {
  const root = useContext(OverlayRoot);
  return root ? createPortal(children, root) : <>{children}</>;
}
