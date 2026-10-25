/**
 * D131 · lane S · how this browser shows agent chats (the View menu and ⌘.):
 * Comfortable / Compact text, Full width, and the side panel shown or hidden,
 * remembered per browser (`localStorage`). Pure, with the storage passed in.
 */

/** The text density of the chat. */
export type Density = 'comfortable' | 'compact';

/** The agent view's remembered settings. */
export interface ChatViewSettings {
  readonly density: Density;
  /** The chat uses the whole column when the details are hidden (else a comfortable line length). */
  readonly fullWidth: boolean;
  /** The side panel (Details) is hidden on wide screens. */
  readonly sideHidden: boolean;
}

/** The storage key (one JSON value). */
export const VIEW_SETTINGS_KEY = 'switchboard.v2.agentView';

/** What a fresh browser shows (the prototype's defaults). */
export const DEFAULT_VIEW: ChatViewSettings = { density: 'comfortable', fullWidth: false, sideHidden: false };

/** The line-length cap of the chat column (the prototype's `.chat-col`). */
export const LINE_CAP = '84ch';

/** The minimal storage this needs (`window.localStorage`; tests pass a map). */
export interface ViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Reads the settings (defaults for anything missing or broken). */
export function loadView(storage: ViewStorage | null): ChatViewSettings {
  try {
    const raw = storage?.getItem(VIEW_SETTINGS_KEY);
    if (!raw) return DEFAULT_VIEW;
    const value = JSON.parse(raw) as Partial<Record<keyof ChatViewSettings, unknown>>;
    return {
      density: value.density === 'compact' ? 'compact' : 'comfortable',
      fullWidth: value.fullWidth === true,
      sideHidden: value.sideHidden === true,
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

/** Stores the settings (a blocked storage keeps them for this page only). */
export function saveView(storage: ViewStorage | null, view: ChatViewSettings): void {
  try {
    storage?.setItem(VIEW_SETTINGS_KEY, JSON.stringify(view));
  } catch {
    // Storage blocked: the choice lasts this page.
  }
}

/** The chat column's max width: the cap, or none with Full width while the details are hidden. */
export function columnWidth(view: Pick<ChatViewSettings, 'fullWidth' | 'sideHidden'>, sideShown: boolean): string {
  return view.fullWidth && !sideShown ? 'none' : LINE_CAP;
}

/** The reply text's size and line height per density (the prototype: 15.5 / 1.55, compact 14.5 / 1.45). */
export function textMetrics(density: Density): { readonly size: number; readonly lineHeight: number; readonly gap: number } {
  return density === 'compact' ? { size: 14.5, lineHeight: 1.45, gap: 14 } : { size: 15.5, lineHeight: 1.55, gap: 22 };
}
