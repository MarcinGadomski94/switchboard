import { useEffect, useRef } from 'react';

/**
 * D131 · the v2 keyboard shortcuts (`docs/v2.md` → *Shortcuts*): the list `?`
 * shows, and a small bus for the ones a lane's page handles (the shell owns the
 * keys, so they never clash). The shell handles ⌘K (palette), ⌘⇧F (Search) and `?`
 * itself; it **emits** ⌘. (the agent's side panel, lane S) and ⌘\ (the folder tree,
 * lane A) for the page on screen to handle: `useShortcut('side-panel', toggle)`.
 * Pure parts are unit-tested.
 */

/** A shortcut a page may handle (the shell emits it). */
export type ShortcutId = 'side-panel' | 'folder-tree';

/** One line of the shortcuts list. */
export interface ShortcutLine {
  /** As shown (`⌘K`, `1 – 4`). */
  readonly keys: string;
  readonly what: string;
}

/** `true` on macOS / iOS (⌘); elsewhere the shortcuts read Ctrl. */
export const APPLE = /Mac|iPhone|iPad|iPod/.test((globalThis as { navigator?: { platform?: string } }).navigator?.platform ?? '');

/** `⌘K` on a Mac, `Ctrl K` elsewhere. */
export function modKey(key: string): string {
  return APPLE ? `⌘${key}` : `Ctrl ${key}`;
}

/** The list `?` shows (the prototype's, in its order). */
export function shortcutList(): readonly ShortcutLine[] {
  return [
    { keys: modKey('K'), what: 'Command palette and quick search' },
    { keys: APPLE ? '⌘⇧F' : 'Ctrl Shift F', what: 'Search everything, every computer' },
    { keys: modKey('.'), what: 'Hide or show the agent’s details panel' },
    { keys: modKey('\\'), what: 'Hide or show the folder tree in Agents' },
    { keys: 'Esc', what: 'Stop the agent you’re looking at' },
    { keys: APPLE ? '⌘↩' : 'Ctrl Enter', what: 'Send' },
    { keys: '1 – 9', what: 'Answer the focused question card' },
    { keys: 'M', what: 'Move the focused agent to a folder or crew' },
    { keys: '?', what: 'This list' },
  ];
}

/** What a key press means to the shell (`null` = not a shell shortcut). Pure. */
export type ShellKey = 'palette' | 'search' | 'shortcuts' | ShortcutId;

/** The parts of a key event the shell reads. */
export interface KeyLike {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** The shell's reading of a key event; `inField` = the focus is in a text box. */
export function shellKeyOf(event: KeyLike, inField: boolean): ShellKey | null {
  const mod = APPLE ? event.metaKey : event.ctrlKey;
  const key = event.key;
  if (mod && !event.shiftKey && !event.altKey && (key === 'k' || key === 'K')) return 'palette';
  if (mod && event.shiftKey && (key === 'f' || key === 'F')) return 'search';
  if (mod && !event.shiftKey && key === '.') return 'side-panel';
  if (mod && !event.shiftKey && key === '\\') return 'folder-tree';
  if (!mod && !event.altKey && key === '?' && !inField) return 'shortcuts';
  return null;
}

const handlers = new Map<ShortcutId, Set<() => void>>();

/** Emits `id` to the pages listening; `false` when none is. */
export function emitShortcut(id: ShortcutId): boolean {
  const set = handlers.get(id);
  if (!set || set.size === 0) return false;
  // The newest listener (the page on top) handles it.
  const last = [...set].at(-1);
  last?.();
  return true;
}

/** Handles `id` while the component is mounted (⌘. in the agent view, ⌘\ in Agents). */
export function useShortcut(id: ShortcutId, handler: () => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = (): void => ref.current();
    let set = handlers.get(id);
    if (!set) {
      set = new Set();
      handlers.set(id, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }, [id]);
}
