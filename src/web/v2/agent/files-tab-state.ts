/**
 * SPIKE · what the side panel's Files tab remembers per agent while the page lives:
 * which list it shows, the folders unfolded in Browse (and what they hold), and where
 * each list was scrolled. Kept outside the components, so the tree is as it was left
 * after a file was opened, another tab was shown or the panel was hidden.
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { AgentDirListing, AgentFileRoot } from '../../../core/agent-files.ts';

/** `browse`: the tree over the agent's folders; `touched`: the files its conversation touched. */
export type FilesMode = 'browse' | 'touched';

/** One unfolded folder: its listing, `loading` until it comes, or why it could not be read. */
export type DirState = AgentDirListing | 'loading' | { readonly error: string };

export interface FilesTabState {
  readonly mode: FilesMode;
  /** The agent's folders (the tree's first level); `null` before they were read. */
  readonly roots: readonly AgentFileRoot[] | null;
  /** The unfolded folders, by path. */
  readonly dirs: Readonly<Record<string, DirState>>;
  /** The first folder was unfolded by itself once (never again: it may have been folded on purpose). */
  readonly opened: boolean;
}

/** A tab nobody touched yet: Browse, nothing unfolded. */
export const FILES_TAB_START: FilesTabState = { mode: 'browse', roots: null, dirs: {}, opened: false };

/** `dir` unfolded: `loading` until {@link withListing} brings what it holds (an unfolded one stays as it is). */
export function unfold(state: FilesTabState, dir: string): FilesTabState {
  return dir in state.dirs ? state : { ...state, dirs: { ...state.dirs, [dir]: 'loading' } };
}

/** `dir` folded. The folders unfolded below it stay remembered: they show again when it is unfolded. */
export function fold(state: FilesTabState, dir: string): FilesTabState {
  if (!(dir in state.dirs)) return state;
  const { [dir]: _folded, ...rest } = state.dirs;
  return { ...state, dirs: rest };
}

/** What `dir` holds (or why it could not be read), unless it was folded again meanwhile. */
export function withListing(state: FilesTabState, dir: string, listing: AgentDirListing | { readonly error: string }): FilesTabState {
  return dir in state.dirs ? { ...state, dirs: { ...state.dirs, [dir]: listing } } : state;
}

// ── This page's tabs, per agent ──────────────────────────────────────────────

/** Agents whose tab is remembered (the newest). */
const KEPT = 30;
const states = new Map<string, FilesTabState>();
const scrolls = new Map<string, number>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes the agent's tab (also from a request that ends after the tab was left). */
export function updateFilesTab(sessionId: string, change: (state: FilesTabState) => FilesTabState): void {
  const before = states.get(sessionId) ?? FILES_TAB_START;
  const after = change(before);
  if (after === before) return;
  states.delete(sessionId);
  states.set(sessionId, after);
  if (states.size > KEPT) {
    const oldest = states.keys().next();
    if (!oldest.done) {
      states.delete(oldest.value);
      for (const key of [...scrolls.keys()]) if (key.startsWith(`${oldest.value}\u0000`)) scrolls.delete(key);
    }
  }
  for (const listener of [...listeners]) listener();
}

/** The agent's tab, live, and how to change it. */
export function useFilesTab(sessionId: string): readonly [FilesTabState, (change: (state: FilesTabState) => FilesTabState) => void] {
  const state = useSyncExternalStore(subscribe, () => states.get(sessionId) ?? FILES_TAB_START);
  const update = useCallback((change: (state: FilesTabState) => FilesTabState) => updateFilesTab(sessionId, change), [sessionId]);
  return [state, update] as const;
}

/** Where a list of the agent's tab was scrolled (px), 0 when never. */
export function filesScroll(sessionId: string, mode: FilesMode): number {
  return scrolls.get(`${sessionId}\u0000${mode}`) ?? 0;
}

/** Remembers it (not a render: nothing listens). */
export function rememberFilesScroll(sessionId: string, mode: FilesMode, top: number): void {
  scrolls.set(`${sessionId}\u0000${mode}`, top);
}
