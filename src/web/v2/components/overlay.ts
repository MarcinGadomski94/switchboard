import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { placeBelow } from './place.ts';

export { placeBelow } from './place.ts';

/**
 * D131 · what every v2 overlay shares (menus, popovers, dialogs, sheets): Escape
 * closes it, focus moves in when it opens and back to where it was when it
 * closes, Tab stays inside a modal one, and a click outside closes a light one.
 */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The focusable elements inside `root`, in order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('inert') && el.getAttribute('aria-hidden') !== 'true');
}

/** Closes on Escape while `open` (the innermost overlay wins: it stops the event). */
export function useEscape(open: boolean, onClose: () => void): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      ref.current();
    };
    // Capture on the document: the newest overlay's listener runs first.
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);
}

/**
 * Moves focus into `ref` when `open` turns true (its `[data-autofocus]`, else its
 * first focusable, else itself) and back to the element focused before when it
 * closes; with `trap`, Tab and Shift+Tab cycle inside.
 */
export function useFocusScope(ref: RefObject<HTMLElement | null>, open: boolean, trap: boolean): void {
  useEffect(() => {
    if (!open) return undefined;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = ref.current;
    if (root) {
      const first = root.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(root)[0] ?? root;
      first.focus({ preventScroll: true });
    }
    const onKey = (event: KeyboardEvent): void => {
      if (!trap || event.key !== 'Tab' || !ref.current) return;
      const items = focusables(ref.current);
      if (items.length === 0) return;
      const firstItem = items[0] as HTMLElement;
      const lastItem = items[items.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (before && document.contains(before)) before.focus({ preventScroll: true });
    };
  }, [open, trap, ref]);
}

/** Calls `onOutside` on a pointer press outside `refs` while `open`. */
export function useOutside(refs: ReadonlyArray<RefObject<HTMLElement | null>>, open: boolean, onOutside: () => void): void {
  const ref = useRef(onOutside);
  ref.current = onOutside;
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && refs.some((r) => r.current?.contains(target))) return;
      ref.current();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, refs]);
}

/** The position of a floating box anchored to `anchor` (recomputed on open, resize and scroll). */
export function useAnchoredPosition(anchor: HTMLElement | null, box: RefObject<HTMLElement | null>, open: boolean, align: 'start' | 'end'): { readonly top: number; readonly left: number } | null {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !anchor) {
      setPos(null);
      return undefined;
    }
    const place = (): void => {
      const el = box.current;
      if (!el) return;
      const rect = anchor.getBoundingClientRect();
      setPos(placeBelow(rect, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, align));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, box, open, align]);
  return pos;
}
