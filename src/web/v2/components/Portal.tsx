import { type ReactNode, createContext, useContext, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

/**
 * D131 · where v2 overlays render (menus, popovers, dialogs, sheets, drawers):
 * the `.v2-overlays` layer at the end of the v2 root (`App.tsx`), outside any
 * scroller or blurred bar (a `backdrop-filter` makes an ancestor the containing
 * block of `position: fixed`, which would shift them). Outside the v2 root (a
 * unit render) they render in place.
 *
 * While an element fills the screen (the Project graph's full screen, Fixes after
 * 2.0 → *The Project graph in full screen*) it registers its own overlay layer
 * with {@link setFullscreenOverlayHost}: overlays (and toasts) then render there,
 * since the Fullscreen API shows only the full-screen element and its contents.
 */
export const OverlayRoot = createContext<HTMLElement | null>(null);

let fullscreenHost: HTMLElement | null = null;
const listeners = new Set<() => void>();

/** Sets (or clears, `null`) the overlay layer inside the element that fills the screen. */
export function setFullscreenOverlayHost(host: HTMLElement | null): void {
  if (fullscreenHost === host) return;
  fullscreenHost = host;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The full-screen element's overlay layer while one is set, else `null`. */
export function useFullscreenOverlayHost(): HTMLElement | null {
  return useSyncExternalStore(
    subscribe,
    () => fullscreenHost,
    () => null,
  );
}

/** Renders `children` into the overlay layer (the full-screen element's while one is set). */
export function Portal({ children }: { readonly children: ReactNode }) {
  const root = useContext(OverlayRoot);
  const host = useFullscreenOverlayHost();
  const target = root ? (host ?? root) : null;
  return target ? createPortal(children, target) : <>{children}</>;
}
