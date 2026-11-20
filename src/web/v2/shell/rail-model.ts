/**
 * D181 · the rail's small rules (`docs/v2.md` → *Shell*), pure so they are tested without a browser.
 */

/**
 * D181: the computer a pinned or recent agent's row names. A paired computer's agent: its
 * computer's name. This computer's agent: this computer's name, but only once a computer is
 * paired (with none, every agent runs here and the name says nothing). `null` = no name.
 */
export function rowComputerName(machine: { readonly name: string } | null | undefined, selfName: string | null, anyPaired: boolean): string | null {
  if (machine) return machine.name;
  return anyPaired && selfName ? selfName : null;
}

/** D181 (2026-11-20): the desktop sidebar's width limits and default (px), and the keyboard step. */
export const RAIL_WIDTH_MIN = 200;
export const RAIL_WIDTH_MAX = 400;
export const RAIL_WIDTH_DEFAULT = 232;
export const RAIL_WIDTH_STEP = 16;
/** Where this browser remembers the sidebar's width. */
export const RAIL_WIDTH_KEY = 'switchboard.v2.railWidth';

/** `width` kept between {@link RAIL_WIDTH_MIN} and {@link RAIL_WIDTH_MAX}, whole pixels; not a number → the default. */
export function clampRailWidth(width: number): number {
  if (!Number.isFinite(width)) return RAIL_WIDTH_DEFAULT;
  return Math.round(Math.max(RAIL_WIDTH_MIN, Math.min(RAIL_WIDTH_MAX, width)));
}

/** The remembered width (`localStorage`'s text): nothing or unreadable → the default. */
export function readRailWidth(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === '') return RAIL_WIDTH_DEFAULT;
  return clampRailWidth(Number(raw));
}

/** The width after a key on the resize handle (← / → by a step, Home / End to the ends); `null` = not a resize key. */
export function railWidthByKey(current: number, key: string): number | null {
  if (key === 'ArrowLeft') return clampRailWidth(current - RAIL_WIDTH_STEP);
  if (key === 'ArrowRight') return clampRailWidth(current + RAIL_WIDTH_STEP);
  if (key === 'Home') return RAIL_WIDTH_MIN;
  if (key === 'End') return RAIL_WIDTH_MAX;
  return null;
}
