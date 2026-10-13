import { useCallback, useSyncExternalStore } from 'react';
import { api } from '../api/client.ts';
import { toolsCollapsedFromSettings, toolsCollapsedPatch } from './nav-grid.ts';

/**
 * D101 · whether the sidebar's TOOLS section is collapsed, kept by the service like
 * D41's pane state (`ui.toolsCollapsed` in `GET/PUT /api/settings`: per install, not
 * synced with paired machines). The value is read from the same `GET /api/settings`
 * the app reads before its first paint (`loadPaneState` in `Panes.tsx` calls
 * {@link seedToolsCollapsed}), so a collapsed section never flashes open; every
 * change is saved at once, one save after the other.
 */

let collapsed = false;
/** A change made on this page wins over a late first read. */
let changedHere = false;
const listeners = new Set<() => void>();
let saving: Promise<unknown> = Promise.resolve();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Takes the stored state from a `GET /api/settings` body (missing reads as expanded). */
export function seedToolsCollapsed(body: Readonly<Record<string, unknown>> | null | undefined): void {
  if (changedHere) return;
  const next = toolsCollapsedFromSettings(body);
  if (next === collapsed) return;
  collapsed = next;
  emit();
}

/** Collapses or expands TOOLS and saves the choice (`PUT /api/settings`); a failed save leaves the page as it is. */
export function setToolsCollapsed(next: boolean): void {
  changedHere = true;
  if (next === collapsed) return;
  collapsed = next;
  emit();
  saving = saving.then(() => api.saveSettings(toolsCollapsedPatch(next))).catch(() => undefined);
}

/** The TOOLS state and its toggle. */
export function useToolsCollapsed(): readonly [boolean, () => void] {
  const value = useSyncExternalStore(subscribe, () => collapsed, () => false);
  const toggle = useCallback(() => setToolsCollapsed(!collapsed), []);
  return [value, toggle];
}
