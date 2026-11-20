import { type ReactNode, createContext, useContext } from 'react';

/**
 * D182 follow-up 2026-11-20 · the bottom dock's one header row: the agent's status line (`Dock`'s
 * `StatusRow`, with Stop / Stop background tasks) on the left and the **Message | Terminal | Both**
 * tabs on the right. `BottomDock` provides the row's element (`slot`) and the tabs; the status line
 * is rendered into it (a portal), so it stays above the terminal in Terminal and Both too. Without a
 * provider (the peek sheet), the status line renders where it is, without tabs.
 */
export interface DockBar {
  /** Where the status line goes (`null` until the row is mounted). */
  readonly slot: HTMLElement | null;
  /** The mode tabs, `null` when the agent gets no terminal. */
  readonly tabs: ReactNode;
}

export const DockBarContext = createContext<DockBar | null>(null);

/** The bottom dock's header row, when the dock is inside one. */
export function useDockBar(): DockBar | null {
  return useContext(DockBarContext);
}
