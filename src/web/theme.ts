import { useSyncExternalStore } from 'react';
import { DEFAULT_UI_THEME, type UiTheme, isUiTheme } from '../core/settings.ts';

/**
 * D131 · the two UIs (`docs/v2.md` → *Two themes*): which one this browser shows.
 *
 * - The service keeps a default for every browser (`ui.theme`, default `v2`).
 * - Each browser / phone may choose its own, kept in its `localStorage`
 *   ({@link THEME_STORAGE_KEY}); that choice wins.
 * - The choice is known before the first render (`main.tsx` reads it with the
 *   pane state), so the wrong UI never flashes.
 * - Switching swaps the whole UI at once, without a reload (`Root.tsx` listens to
 *   {@link themeStore}); the address is kept where both UIs have the page
 *   (`v2/routes.ts` → `toClassicPath` / `toV2Path`).
 *
 * Pure parts ({@link resolveTheme}, {@link readDeviceTheme}) are unit-tested.
 */

export type { UiTheme } from '../core/settings.ts';

/** The browser's own choice (`v2` / `classic`); absent = the service's default. */
export const THEME_STORAGE_KEY = 'switchboard.ui.theme';

/** The part of `Storage` the theme uses (tests pass a map). */
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The part of `document` the theme touches (absent outside a browser). */
interface DocumentLike {
  readonly documentElement: { readonly dataset: Record<string, string | undefined> };
  querySelector(selector: string): { setAttribute(name: string, value: string): void } | null;
}

function pageDocument(): DocumentLike | null {
  return (globalThis as { document?: DocumentLike }).document ?? null;
}

/** The browser's `localStorage`, or `null` where it cannot be used (private modes, tests without a DOM). */
export function browserStorage(): ThemeStorage | null {
  try {
    return (globalThis as { localStorage?: ThemeStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** The browser's own choice, `null` when it has none (or it is not a theme). */
export function readDeviceTheme(storage: ThemeStorage | null): UiTheme | null {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY) ?? null;
    return isUiTheme(value) ? value : null;
  } catch {
    return null;
  }
}

/** Stores (or, with `null`, forgets) the browser's own choice. Never throws. */
export function writeDeviceTheme(storage: ThemeStorage | null, theme: UiTheme | null): void {
  try {
    if (theme === null) storage?.removeItem(THEME_STORAGE_KEY);
    else storage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // A full or blocked storage keeps the choice for this page only.
  }
}

/**
 * The theme to show: the browser's own choice, else the service's default
 * (`ui.theme` of `GET /api/settings`), else {@link DEFAULT_UI_THEME} (`v2`).
 */
export function resolveTheme(input: { readonly device: UiTheme | null; readonly serverDefault: unknown }): UiTheme {
  if (input.device) return input.device;
  return isUiTheme(input.serverDefault) ? input.serverDefault : DEFAULT_UI_THEME;
}

/** The service's default read from a `GET /api/settings` body (`null` when absent). */
export function serverDefaultOf(settings: Readonly<Record<string, unknown>> | null | undefined): UiTheme | null {
  const value = settings?.['ui.theme'];
  return isUiTheme(value) ? value : null;
}

/** Marks the document with the theme (`<html data-ui="v2">`): the page background and the v2 tokens key on it. */
export function applyThemeToDocument(theme: UiTheme): void {
  const doc = pageDocument();
  if (!doc) return;
  doc.documentElement.dataset['ui'] = theme;
  const meta = doc.querySelector('meta[name="theme-color"]');
  // The v2 bar colour follows its light / dark scheme (tokens.css); classic keeps its own.
  if (meta) meta.setAttribute('content', theme === 'v2' ? (doc.documentElement.dataset['scheme'] === 'dark' ? '#131312' : '#f6f5f2') : '#111214');
}

interface ThemeState {
  readonly theme: UiTheme;
  /** The service's default as last read (`null` until known). */
  readonly serverDefault: UiTheme | null;
  /** The browser's own choice (`null` = follows the service). */
  readonly device: UiTheme | null;
}

let state: ThemeState = { theme: DEFAULT_UI_THEME, serverDefault: null, device: null };
const listeners = new Set<() => void>();

function emit(next: ThemeState): void {
  if (next.theme === state.theme && next.serverDefault === state.serverDefault && next.device === state.device) return;
  state = next;
  applyThemeToDocument(state.theme);
  for (const listener of listeners) listener();
}

/** The page's theme state, shared by both UIs. */
export const themeStore = {
  get: (): ThemeState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Boot (`main.tsx`): the stored choice and the service's default, read before the first render. */
  init(serverDefault: UiTheme | null, storage: ThemeStorage | null = browserStorage()): UiTheme {
    const device = readDeviceTheme(storage);
    const theme = resolveTheme({ device, serverDefault });
    state = { theme, serverDefault, device };
    applyThemeToDocument(theme);
    return theme;
  },
  /** This browser picks `theme` (stored in its `localStorage`); the UI swaps at once. */
  choose(theme: UiTheme, storage: ThemeStorage | null = browserStorage()): void {
    writeDeviceTheme(storage, theme);
    emit({ ...state, device: theme, theme });
  },
  /** This browser follows the service's default again. */
  followDefault(storage: ThemeStorage | null = browserStorage()): void {
    writeDeviceTheme(storage, null);
    emit({ ...state, device: null, theme: resolveTheme({ device: null, serverDefault: state.serverDefault }) });
  },
  /** The service's default changed (Settings saved it, here or in another browser). */
  serverDefaultChanged(serverDefault: UiTheme | null): void {
    emit({ ...state, serverDefault, theme: resolveTheme({ device: state.device, serverDefault }) });
  },
};

/** The theme state, live (`theme`, `device`, `serverDefault`). */
export function useThemeState(): ThemeState {
  return useSyncExternalStore(themeStore.subscribe, themeStore.get, themeStore.get);
}

// ── v2's light / dark scheme (per browser) ─────────────────────────────

/** The v2 UI's colour scheme: the system's, or a fixed one (Settings → Appearance). */
export type ColorScheme = 'system' | 'light' | 'dark';

/** Where the browser keeps its scheme (absent = `system`). */
export const SCHEME_STORAGE_KEY = 'switchboard.v2.scheme';

/** The stored scheme (`system` when absent or unknown). */
export function readScheme(storage: ThemeStorage | null): ColorScheme {
  try {
    const value = storage?.getItem(SCHEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

/** `light` or `dark` for a scheme and whether the system prefers dark. */
export function effectiveScheme(scheme: ColorScheme, systemDark: boolean): 'light' | 'dark' {
  return scheme === 'system' ? (systemDark ? 'dark' : 'light') : scheme;
}
