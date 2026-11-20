/**
 * SPIKE · the side panel's tab and width, remembered per browser. Kept apart from
 * `view-settings.ts` so that file and its tests stay as they are. Pure, with the
 * storage passed in.
 */
import type { ViewStorage } from './view-settings.ts';

/**
 * What the side panel shows. `changes`, `files` and `helpers` (the agent's helpers at
 * work, and a helper's own chat) are its tabs; `details` (the agent's settings and facts) is not one of them
 * any more: it opens from the ⓘ at the end of the tab row.
 */
export type SideTab = 'changes' | 'files' | 'helpers' | 'details';

export interface SideSettings {
  readonly tab: SideTab;
  /** The panel's width (px), the same whatever it shows: switching what it shows never moves the chat. */
  readonly width: number;
}

export const SIDE_SETTINGS_KEY = 'switchboard.v2.agentSide';
export const SIDE_DEFAULT_WIDTH = 560;
/** Never narrower than this. */
export const SIDE_MIN = 320;
/** Never wider than this share of the agent view. */
export const SIDE_MAX_RATIO = 0.7;
/** The chat always keeps at least this much. */
export const CHAT_MIN = 360;
/** One arrow key press; with Shift {@link SIDE_STEP_BIG}. */
export const SIDE_STEP = 16;
export const SIDE_STEP_BIG = 64;

export const DEFAULT_SIDE: SideSettings = { tab: 'changes', width: SIDE_DEFAULT_WIDTH };

const TABS: readonly SideTab[] = ['changes', 'files', 'helpers', 'details'];

function widthOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= SIDE_MIN && value <= 4000 ? Math.round(value) : fallback;
}

export function loadSide(storage: ViewStorage | null): SideSettings {
  try {
    const raw = storage?.getItem(SIDE_SETTINGS_KEY);
    if (!raw) return DEFAULT_SIDE;
    const value = JSON.parse(raw) as { readonly tab?: unknown; readonly width?: unknown; readonly wideWidth?: unknown };
    return {
      tab: TABS.find((tab) => tab === value.tab) ?? DEFAULT_SIDE.tab,
      // An earlier build kept a width for Details and one for reading (`wideWidth`): the reading one is the panel's.
      width: widthOr(value.wideWidth ?? value.width, SIDE_DEFAULT_WIDTH),
    };
  } catch {
    return DEFAULT_SIDE;
  }
}

export function saveSide(storage: ViewStorage | null, side: SideSettings): void {
  try {
    storage?.setItem(SIDE_SETTINGS_KEY, JSON.stringify(side));
  } catch {
    // Storage blocked: the choice lasts this page.
  }
}

/**
 * The tab shown for an agent: the remembered one, or Changes while that one has
 * nothing to show (`has.helpers`: the agent has, or had, a helper or a run). What
 * is remembered stays as it is, for the next agent that has them.
 */
export function shownSideTab(tab: SideTab, has: { readonly helpers: boolean }): SideTab {
  return tab === 'helpers' && !has.helpers ? 'changes' : tab;
}

/** The widest the panel may be in a view `viewWidth` px wide (0 = not measured yet). */
export function sideMax(viewWidth: number): number {
  if (viewWidth <= 0) return 4000;
  return Math.max(SIDE_MIN, Math.floor(Math.min(viewWidth * SIDE_MAX_RATIO, viewWidth - CHAT_MIN)));
}

/** `width` kept between {@link SIDE_MIN} and {@link sideMax}. */
export function clampSide(width: number, viewWidth: number): number {
  return Math.round(Math.max(SIDE_MIN, Math.min(width, sideMax(viewWidth))));
}
