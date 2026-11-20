import type { ViewStorage } from './view-settings.ts';

/**
 * D182 · the bottom of an agent's conversation (`docs/terminals.md` → *The agent's terminal*):
 * tabs **Message | Terminal**, and **Both** (the terminal above the message box). What is shown and
 * the terminal's height are remembered in this browser; a phone has the tabs only.
 */

/** What the bottom shows. */
export type DockMode = 'message' | 'terminal' | 'both';

/** What this browser remembers. */
export interface DockSettings {
  readonly mode: DockMode;
  /** The terminal's height in Both, in px. */
  readonly height: number;
}

export const DOCK_SETTINGS_KEY = 'switchboard.v2.agentDock';
export const DOCK_MIN_HEIGHT = 120;
export const DOCK_DEFAULT_HEIGHT = 260;
const MODES: readonly DockMode[] = ['message', 'terminal', 'both'];
const DEFAULT_DOCK: DockSettings = { mode: 'message', height: DOCK_DEFAULT_HEIGHT };

/** A height kept between {@link DOCK_MIN_HEIGHT} and `max` (the room the conversation leaves). */
export function clampDockHeight(height: number, max: number): number {
  const top = Math.max(DOCK_MIN_HEIGHT, Math.floor(max));
  if (!Number.isFinite(height)) return Math.min(DOCK_DEFAULT_HEIGHT, top);
  return Math.min(top, Math.max(DOCK_MIN_HEIGHT, Math.round(height)));
}

/** The remembered settings (defaults when none, or unreadable). */
export function loadDock(storage: ViewStorage | null): DockSettings {
  try {
    const raw = storage?.getItem(DOCK_SETTINGS_KEY);
    if (!raw) return DEFAULT_DOCK;
    const value = JSON.parse(raw) as { readonly mode?: unknown; readonly height?: unknown };
    return {
      mode: MODES.find((mode) => mode === value.mode) ?? DEFAULT_DOCK.mode,
      height: typeof value.height === 'number' && Number.isFinite(value.height) && value.height >= DOCK_MIN_HEIGHT ? Math.round(value.height) : DOCK_DEFAULT_HEIGHT,
    };
  } catch {
    return DEFAULT_DOCK;
  }
}

export function saveDock(storage: ViewStorage | null, settings: DockSettings): void {
  try {
    storage?.setItem(DOCK_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage blocked: the choice lasts this page.
  }
}

/**
 * What is shown: the remembered mode, except Message while the terminal can't open here
 * (`terminalRefusal`), and Terminal for Both on a phone (no room for two).
 */
export function shownDockMode(mode: DockMode, options: { readonly phone: boolean; readonly terminalRefusal: string | null }): DockMode {
  if (options.terminalRefusal !== null) return 'message';
  if (options.phone && mode === 'both') return 'terminal';
  return mode;
}

/** The modes offered as tabs: a phone has no Both. */
export function dockModes(phone: boolean): readonly DockMode[] {
  return phone ? ['message', 'terminal'] : MODES;
}

/** Whether `mode` shows the terminal (it is started the first time one does). */
export function showsTerminal(mode: DockMode): boolean {
  return mode !== 'message';
}

/** Ctrl+`: the terminal when it isn't shown, the message box when it is. */
export function toggledDockMode(mode: DockMode): DockMode {
  return showsTerminal(mode) ? 'message' : 'terminal';
}

/** Why the agent's terminal can't open from here (`null` = it can); while the agent loads, not yet. */
export function agentTerminalRefusal(agent: { readonly remote: boolean; readonly closed: boolean; readonly missing: boolean }): string | null {
  if (agent.remote) return 'This agent runs on another computer: open a terminal there (Terminals → New terminal, that computer).';
  if (agent.closed) return 'This agent is archived.';
  if (agent.missing) return 'Loading…';
  return null;
}
