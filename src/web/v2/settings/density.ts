/**
 * D131 · lane R · the v2 chat's default text density (Settings › Appearance), per
 * browser like the theme and the scheme. DOM-free: the storage is passed in.
 * Lane S reads it as the default of the agent view's View menu
 * (`readDensity(window.localStorage)`); `<html data-density>` carries it too.
 */

/** The densities (the prototype's Comfortable / Compact text). */
export const DENSITIES = ['comfortable', 'compact'] as const;
/** A density. */
export type Density = (typeof DENSITIES)[number];

/** Where this browser keeps it. */
export const DENSITY_STORAGE_KEY = 'switchboard.v2.density';

/** The minimal storage it needs (`localStorage`). */
export interface DensityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The stored density, Comfortable without one (or an unreadable one). */
export function readDensity(storage: DensityStorage | null | undefined): Density {
  try {
    const value = storage?.getItem(DENSITY_STORAGE_KEY);
    return value === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

/** Stores it (kept for this page only when storage is unavailable). */
export function writeDensity(storage: DensityStorage | null | undefined, density: Density): void {
  try {
    storage?.setItem(DENSITY_STORAGE_KEY, density);
  } catch {
    // Kept for this page only.
  }
}
