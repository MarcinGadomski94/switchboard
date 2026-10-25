import { useSyncExternalStore } from 'react';

/**
 * D131 · a tiny "is it open, and with what" store (the + New sheet, the ⌘K
 * palette, the shortcuts list): any view can open it, the shell renders it once.
 */
export interface OpenStore<T> {
  readonly open: (value: T) => void;
  readonly close: () => void;
  readonly get: () => T | null;
  readonly use: () => T | null;
}

/** Makes an {@link OpenStore}. */
export function openStore<T>(): OpenStore<T> {
  let value: T | null = null;
  const listeners = new Set<() => void>();
  const set = (next: T | null): void => {
    value = next;
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return {
    open: (next) => set(next),
    close: () => set(null),
    get: () => value,
    use: () => useSyncExternalStore(subscribe, () => value, () => value),
  };
}
