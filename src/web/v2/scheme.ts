import { useEffect, useSyncExternalStore } from 'react';
import { type ColorScheme, SCHEME_STORAGE_KEY, browserStorage, effectiveScheme, readScheme } from '../theme.ts';

/**
 * D131 · the v2 UI's light / dark scheme (per browser): the system's by default,
 * or the one picked in Settings → Appearance. Sets `<html data-scheme>`, which the
 * tokens key on (`tokens.css`). The classic UI is dark only and ignores it.
 */

const DARK_QUERY = '(prefers-color-scheme: dark)';
const listeners = new Set<() => void>();
let current: ColorScheme = readScheme(browserStorage());

function systemDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

/** Puts the effective scheme on `<html>` (before the first v2 paint too: `main.tsx`). */
export function applyScheme(scheme: ColorScheme = current): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset['scheme'] = effectiveScheme(scheme, systemDark());
}

/** Picks the scheme for this browser (`system` follows the system again). */
export function setScheme(scheme: ColorScheme): void {
  current = scheme;
  try {
    const storage = browserStorage();
    if (scheme === 'system') storage?.removeItem(SCHEME_STORAGE_KEY);
    else storage?.setItem(SCHEME_STORAGE_KEY, scheme);
  } catch {
    // Kept for this page only.
  }
  applyScheme();
  for (const listener of listeners) listener();
}

/** The picked scheme (`system` / `light` / `dark`), live. */
export function useScheme(): ColorScheme {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => current,
  );
}

/** Keeps `<html data-scheme>` in step with the system while the v2 UI shows. */
export function useSystemSchemeFollow(): void {
  useEffect(() => {
    applyScheme();
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(DARK_QUERY);
    const onChange = (): void => applyScheme();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
}
