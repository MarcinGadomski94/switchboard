import { useCallback, useRef } from 'react';

// Typing lag fix (2026-10-29, `docs/performance.md` → *Typing in a long chat*):
// keeping what a chat renders the same objects while it is equal, so memoized
// chat rows skip the renders that change nothing of theirs. The chat's items are
// built anew from the events on every `/hub` event; without this every message of
// the loaded window rendered again for each event (and each event comes while you
// may be typing).

/**
 * `true` when two plain values (strings, numbers,
 * booleans, `null`, arrays and plain objects of them, as chat rows are made of) are
 * equal field by field. Other objects (a `Map`, a `Date`, a function) are equal
 * only when they are the same object.
 */
export function samePlain(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!samePlain(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const protoA = Object.getPrototypeOf(a) as unknown;
  const protoB = Object.getPrototypeOf(b) as unknown;
  if ((protoA !== Object.prototype && protoA !== null) || (protoB !== Object.prototype && protoB !== null)) return false;
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!samePlain((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/**
 * `next` with every item that equals the previous
 * build's item of the same key ({@link samePlain}) replaced by that previous row
 * object, and `previous` itself when nothing changed. The rows are built anew from
 * the events on every `/hub` event; keeping the unchanged ones the same objects lets
 * the memoized chat rows skip them, so a received message renders its own row (and
 * the few around it that change), not the whole window.
 */
export function keepIdentity<T extends { readonly key: string }>(previous: readonly T[] | null, next: readonly T[]): readonly T[] {
  if (previous === null || previous.length === 0) return next;
  const byKey = new Map<string, T>();
  for (const row of previous) byKey.set(row.key, row);
  let changed = previous.length !== next.length;
  const out = next.map((row, index) => {
    const old = byKey.get(row.key);
    const kept = old !== undefined && samePlain(old, row) ? old : row;
    if (kept !== previous[index]) changed = true;
    return kept;
  });
  return changed ? out : previous;
}

/** A callback that stays the same function for the component's life and calls the newest `fn` (a memoized child keeps its props). */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}
