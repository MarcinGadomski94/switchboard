import { useCallback, useSyncExternalStore } from 'react';
import { readKnownSettings } from '../../core/settings.ts';
import { api } from '../api/client.ts';

/**
 * D101 / D106 · whether a sidebar section is folded to its header: TOOLS
 * (`ui.toolsCollapsed`), SESSIONS (`ui.sessionsCollapsed`) and CHATS
 * (`ui.chatsCollapsed`), kept by the service like D41's pane state (`GET/PUT
 * /api/settings`: per install, not synced with paired machines). The values are read
 * from the same `GET /api/settings` the app reads before its first paint
 * (`loadPaneState` in `Panes.tsx` calls {@link seedToolsCollapsed}), so a collapsed
 * section never flashes open; every change is saved at once, one save after the other.
 */

/** The settings that fold a sidebar section. */
export type SectionCollapseKey = 'ui.toolsCollapsed' | 'ui.sessionsCollapsed' | 'ui.chatsCollapsed';

const KEYS: readonly SectionCollapseKey[] = ['ui.toolsCollapsed', 'ui.sessionsCollapsed', 'ui.chatsCollapsed'];

const collapsed = new Map<SectionCollapseKey, boolean>(KEYS.map((key) => [key, false]));
/** A change made on this page wins over a late first read. */
const changedHere = new Set<SectionCollapseKey>();
const listeners = new Set<() => void>();
let saving: Promise<unknown> = Promise.resolve();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Takes the stored states from a `GET /api/settings` body (missing or mistyped reads as expanded). */
export function seedToolsCollapsed(body: Readonly<Record<string, unknown>> | null | undefined): void {
  const known = readKnownSettings(body);
  let changed = false;
  for (const key of KEYS) {
    if (changedHere.has(key)) continue;
    const next = known[key];
    if (next === collapsed.get(key)) continue;
    collapsed.set(key, next);
    changed = true;
  }
  if (changed) emit();
}

/** Folds or unfolds a section and saves the choice (`PUT /api/settings`); a failed save leaves the page as it is. */
export function setSectionCollapsed(key: SectionCollapseKey, next: boolean): void {
  changedHere.add(key);
  if (next === collapsed.get(key)) return;
  collapsed.set(key, next);
  emit();
  saving = saving.then(() => api.saveSettings({ [key]: next })).catch(() => undefined);
}

/** Collapses or expands TOOLS (D101). */
export function setToolsCollapsed(next: boolean): void {
  setSectionCollapsed('ui.toolsCollapsed', next);
}

/** A section's state and its toggle. */
export function useSectionCollapsed(key: SectionCollapseKey): readonly [boolean, () => void] {
  const value = useSyncExternalStore(subscribe, () => collapsed.get(key) ?? false, () => false);
  const toggle = useCallback(() => setSectionCollapsed(key, !(collapsed.get(key) ?? false)), [key]);
  return [value, toggle];
}

/** The TOOLS state and its toggle (D101). */
export function useToolsCollapsed(): readonly [boolean, () => void] {
  return useSectionCollapsed('ui.toolsCollapsed');
}
