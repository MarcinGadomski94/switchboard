/**
 * Whether Switchboard runs as an installed app (D34, `docs/install-app.md`): the
 * manifest asks for `display: standalone`, so an app window (Chrome) or a Dock
 * app (Safari) matches `(display-mode: standalone)`. A browser tab does not.
 */

/** The media query of an installed app's window. */
export const STANDALONE_QUERY = '(display-mode: standalone)';

/** `true` in an installed app's window (also iOS Safari's older `navigator.standalone`). */
export function isStandalone(): boolean {
  return window.matchMedia(STANDALONE_QUERY).matches || (navigator as Navigator & { readonly standalone?: boolean }).standalone === true;
}

/** Calls `listener` when the display mode changes (a tab moved into an app window); returns the unsubscribe. */
export function subscribeStandalone(listener: () => void): () => void {
  const query = window.matchMedia(STANDALONE_QUERY);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}
