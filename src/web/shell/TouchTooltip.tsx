import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LONG_PRESS_MS, TOUCH_SLOP_PX, movedBeyondSlop } from './touch-drag.ts';
import { useCoarsePointer } from './useLayout.ts';

/** How long a long-press tooltip stays up when nothing else dismisses it. */
const TOOLTIP_MS = 3_000;
/** The room the tooltip keeps from the window's edges. */
const EDGE = 8;

/** Where a press may not show a tooltip: the sidebar's sessions list (a long press there lifts the row, D74). */
const NO_TOOLTIP = '.sb-sessions, input, textarea, [contenteditable="true"]';

interface Shown {
  readonly text: string;
  readonly anchor: DOMRect;
}

/**
 * D74 · tooltips on a touch screen (`docs/responsive.md` → *Touch*): a pointer
 * that cannot hover never sees a `title`, so on a coarse pointer a long press
 * (~500 ms without moving) on an element with a `title` shows it in a bubble
 * above the element; the click that would follow the press is swallowed, the
 * next touch anywhere (or a few seconds) dismisses it. Renders nothing otherwise.
 */
export function TouchTooltip() {
  const coarse = useCoarsePointer();
  const [shown, setShown] = useState<Shown | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!coarse) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let start: { x: number; y: number } | null = null;
    let swallowUntil = 0;
    const clear = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      start = null;
    };
    const down = (event: PointerEvent): void => {
      setShown(null);
      clear();
      if (event.pointerType === 'mouse' || !(event.target instanceof Element)) return;
      if (event.target.closest(NO_TOOLTIP)) return;
      const owner = event.target.closest<HTMLElement>('[title]');
      const text = owner?.getAttribute('title')?.trim();
      if (!owner || !text) return;
      start = { x: event.clientX, y: event.clientY };
      timer = setTimeout(() => {
        timer = null;
        swallowUntil = Date.now() + 1_000;
        setShown({ text, anchor: owner.getBoundingClientRect() });
      }, LONG_PRESS_MS + 100);
    };
    const move = (event: PointerEvent): void => {
      if (start && movedBeyondSlop(start, { x: event.clientX, y: event.clientY }, TOUCH_SLOP_PX)) clear();
    };
    const click = (event: MouseEvent): void => {
      if (Date.now() < swallowUntil) {
        swallowUntil = 0;
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const menu = (event: Event): void => {
      if (timer !== null || Date.now() < swallowUntil) event.preventDefault();
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', clear, true);
    window.addEventListener('pointercancel', clear, true);
    window.addEventListener('click', click, true);
    window.addEventListener('contextmenu', menu, true);
    return () => {
      clear();
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', clear, true);
      window.removeEventListener('pointercancel', clear, true);
      window.removeEventListener('click', click, true);
      window.removeEventListener('contextmenu', menu, true);
    };
  }, [coarse]);

  useEffect(() => {
    if (!shown) return undefined;
    const timer = setTimeout(() => setShown(null), TOOLTIP_MS);
    return () => clearTimeout(timer);
  }, [shown]);

  useLayoutEffect(() => {
    const el = bubble.current;
    if (!shown || !el) {
      setPlace(null);
      return;
    }
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(shown.anchor.left + shown.anchor.width / 2 - width / 2, window.innerWidth - EDGE - width));
    const above = shown.anchor.top - 6 - height;
    setPlace({ left, top: above >= EDGE ? above : shown.anchor.bottom + 6 });
  }, [shown]);

  if (!coarse || !shown) return null;
  return (
    <div
      ref={bubble}
      className="sb-touch-tooltip"
      role="tooltip"
      data-testid="touch-tooltip"
      style={place ? { left: place.left, top: place.top } : { left: EDGE, top: EDGE, visibility: 'hidden' }}
    >
      {shown.text}
    </div>
  );
}
