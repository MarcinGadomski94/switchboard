import { useEffect, useSyncExternalStore } from 'react';
import { COARSE_QUERY, COMPACT_QUERY, HEADER_MENU_QUERY, type Layout, PHONE_QUERY } from './viewport.ts';

/**
 * D74 · the React side of the responsive layout (`viewport.ts`,
 * `docs/responsive.md`): media-query hooks that re-render on a change (a rotated
 * tablet, a resized window). Desktop renders exactly what it rendered before D74:
 * every compact-only element is mounted only when one of these says so.
 */

function subscribeTo(query: string) {
  return (onChange: () => void): (() => void) => {
    if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
    const list = window.matchMedia(query);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  };
}

const subscriptions = new Map<string, (onChange: () => void) => () => void>();

/** `true` while `query` matches. */
export function useMedia(query: string): boolean {
  let subscribe = subscriptions.get(query);
  if (!subscribe) {
    subscribe = subscribeTo(query);
    subscriptions.set(query, subscribe);
  }
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/** The current layout: `desktop` (≥ 1280 px), `tablet` (768–1279 px) or `phone` (≤ 767 px). */
export function useLayout(): Layout {
  const compact = useMedia(COMPACT_QUERY);
  const phone = useMedia(PHONE_QUERY);
  if (!compact) return 'desktop';
  return phone ? 'phone' : 'tablet';
}

/** `true` below 1024 px, where the session header's actions sit in its ⋯ menu. */
export function useHeaderMenu(): boolean {
  return useMedia(HEADER_MENU_QUERY);
}

/** `true` when the primary pointer is coarse (a touch screen). */
export function useCoarsePointer(): boolean {
  return useMedia(COARSE_QUERY);
}

/**
 * Keeps `--app-height` on the document at the visual viewport's height while the
 * layout is compact, so the shell (and the composer pinned at its bottom) stays
 * above an on-screen keyboard even where the browser does not resize the layout
 * viewport for it (iOS Safari). Unset on desktop (the shell is `100vh` there).
 */
export function useVisualViewportHeight(compact: boolean): void {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    if (!compact || !viewport) {
      root.style.removeProperty('--app-height');
      return undefined;
    }
    const update = (): void => {
      root.style.setProperty('--app-height', `${Math.round(viewport.height)}px`);
      // iOS scrolls the page up to show a focused field; the shell already fits the visible part.
      if (window.scrollY !== 0 && viewport.offsetTop === 0) window.scrollTo(0, 0);
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      root.style.removeProperty('--app-height');
    };
  }, [compact]);
}
