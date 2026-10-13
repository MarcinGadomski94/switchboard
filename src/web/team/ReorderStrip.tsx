import { type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { dragScrollStep } from '../shell/sidebar-menu.ts';
import { LONG_PRESS_MS, type Press, pressHeld, pressMove, pressStart } from '../shell/touch-drag.ts';
import { dropOrder, moveInOrder, sideAlong } from './model.ts';

/**
 * D100 follow-up 2026-10-14 · a reorderable strip (`docs/team.md` → *The Team page*
 * → *Order*): the member cards (one horizontally scrolling row on a desktop or a
 * tablet, a vertical list on a phone) and the team tabs. The sidebar's approach
 * (D54 / D71 / D74), on one axis:
 *
 * - **Mouse:** HTML drag and drop; the item under the pointer shows a line on the
 *   side it would go (`dropOrder`, the sidebar's `dropPosition`). A click without
 *   moving is a click (no drag starts).
 * - **Touch:** a long press ({@link LONG_PRESS_MS}) lifts the item (`touch-drag.ts`),
 *   which then follows the finger over the same targets; a finger that moves first
 *   scrolls, and no drag starts.
 * - **Keyboard:** Alt+← / → (Alt+↑ / ↓ on the vertical list) moves the focused item
 *   one place; focus stays on it.
 * - **Edge auto-scroll** while a drag is held at the scroller's edge (`dragScrollStep`,
 *   every frame; WebKit has no drag auto-scroll of its own for a scrolling box).
 * - **Horizontal:** native sideways scroll (shift+wheel, trackpad) with a soft fade on
 *   the side that has more (the Plans graph's pattern), and `revealId` scrolled into
 *   view when it changes (an item selected from elsewhere).
 *
 * `onReorder` gets the whole new order; the parent shows it at once and saves it.
 */
export function ReorderStrip<T>({
  items,
  idOf,
  labelOf,
  axis,
  revealId,
  onReorder,
  className,
  testId,
  children,
}: {
  readonly items: readonly T[];
  readonly idOf: (item: T) => string;
  /** The item's name (the drag's text for the browser). */
  readonly labelOf: (item: T) => string;
  readonly axis: 'x' | 'y';
  /** Scrolled into view when it changes (horizontal strips). */
  readonly revealId?: string | null;
  readonly onReorder: (ids: string[], movedId: string) => void;
  readonly className: string;
  readonly testId: string;
  readonly children: (item: T) => ReactNode;
}) {
  const ids = items.map(idOf);
  const strip = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ readonly id: string; readonly side: 'before' | 'after' } | null>(null);
  const [fade, setFade] = useState<{ readonly start: boolean; readonly end: boolean }>({ start: false, end: false });
  const focusAfter = useRef<string | null>(null);
  const latest = useRef({ ids, drag, over, onReorder });
  latest.current = { ids, drag, over, onReorder };

  /** What a held drag scrolls: the strip (horizontal), else the nearest scrolling ancestor (the phone's page). */
  const scroller = useCallback((): HTMLElement | null => {
    const element = strip.current;
    if (!element) return null;
    if (axis === 'x') return element;
    for (let node = element.parentElement; node; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 1 && getComputedStyle(node).overflowY !== 'visible') return node;
    }
    return document.scrollingElement as HTMLElement | null;
  }, [axis]);

  // ── edge auto-scroll ──
  const scrolling = useRef<{ step: number; frame: number | null }>({ step: 0, frame: null });
  const edgeScroll = useCallback(
    (step: number): void => {
      const state = scrolling.current;
      state.step = step;
      if (step === 0) {
        if (state.frame !== null) cancelAnimationFrame(state.frame);
        state.frame = null;
        return;
      }
      if (state.frame !== null) return;
      const tick = (): void => {
        const element = scroller();
        if (!element || state.step === 0) {
          state.frame = null;
          return;
        }
        if (axis === 'x') element.scrollLeft += state.step / 2;
        else element.scrollTop += state.step / 2;
        state.frame = requestAnimationFrame(tick);
      };
      state.frame = requestAnimationFrame(tick);
    },
    [axis, scroller],
  );
  const edgeStep = (point: { readonly x: number; readonly y: number }): number => {
    const box = scroller()?.getBoundingClientRect();
    if (!box) return 0;
    return axis === 'x' ? dragScrollStep(point.x, { top: box.left, bottom: box.right }) : dragScrollStep(point.y, { top: Math.max(box.top, 0), bottom: Math.min(box.bottom, window.innerHeight) });
  };
  useEffect(() => () => edgeScroll(0), [edgeScroll]);

  const end = (): void => {
    setDrag(null);
    setOver(null);
    edgeScroll(0);
  };

  const drop = (dragged: string, at: { readonly id: string; readonly side: 'before' | 'after' } | null): void => {
    const next = at ? dropOrder(latest.current.ids, dragged, at.id, at.side) : null;
    end();
    if (next) {
      focusAfter.current = null;
      latest.current.onReorder(next, dragged);
    }
  };

  // ── the soft fade (horizontal) ──
  useEffect(() => {
    const element = strip.current;
    if (!element || axis !== 'x') return undefined;
    const measure = (): void => {
      const start = element.scrollLeft > 1;
      const endSide = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setFade((current) => (current.start === start && current.end === endSide ? current : { start, end: endSide }));
    };
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [axis, items.length]);

  // ── reveal the selected item ──
  useEffect(() => {
    const element = strip.current;
    if (!element || axis !== 'x' || !revealId) return;
    const item = element.querySelector<HTMLElement>(`[data-reorder-id="${CSS.escape(revealId)}"]`);
    if (!item) return;
    // The strip's own padding is kept beside the card (so the first / last card scrolls to the very edge).
    const style = getComputedStyle(element);
    const padStart = Number.parseFloat(style.paddingLeft) || 0;
    const padEnd = Number.parseFloat(style.paddingRight) || 0;
    const left = item.offsetLeft - element.offsetLeft;
    const right = left + item.offsetWidth;
    if (left < element.scrollLeft + padStart) element.scrollTo({ left: Math.max(0, left - padStart), behavior: 'smooth' });
    else if (right > element.scrollLeft + element.clientWidth - padEnd) element.scrollTo({ left: right - element.clientWidth + padEnd, behavior: 'smooth' });
  }, [axis, revealId]);

  // ── keyboard: focus stays on the moved item ──
  useLayoutEffect(() => {
    const id = focusAfter.current;
    if (!id || !strip.current) return;
    const item = strip.current.querySelector<HTMLElement>(`[data-reorder-id="${CSS.escape(id)}"]`);
    if (!item) return;
    focusAfter.current = null;
    (item.querySelector<HTMLElement>('[tabindex="0"]') ?? item).focus({ preventScroll: false });
  });
  const onKey = (id: string) => (event: KeyboardEvent<HTMLElement>) => {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const forward = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    if (event.key !== back && event.key !== forward) return;
    event.preventDefault();
    event.stopPropagation();
    const next = moveInOrder(ids, id, event.key === back ? -1 : 1);
    if (!next) return;
    focusAfter.current = id;
    onReorder(next, id);
  };

  // ── touch: long press lifts ──
  const touch = useRef<{ press: Press; id: string; pointerId: number; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const swallowClick = useRef(0);
  const cancelTouch = useCallback((): void => {
    const current = touch.current;
    if (current?.timer) clearTimeout(current.timer);
    touch.current = null;
  }, []);
  const touchStart = (id: string) => (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' || !event.isPrimary) return;
    // The ⋯ keeps its own touches.
    if (event.target instanceof Element && event.target.closest('button:not([data-reorder-handle]), input, textarea')) return;
    cancelTouch();
    const pressed = { press: pressStart({ x: event.clientX, y: event.clientY }), id, pointerId: event.pointerId, timer: null as ReturnType<typeof setTimeout> | null };
    pressed.timer = setTimeout(() => {
      if (touch.current !== pressed) return;
      pressed.timer = null;
      pressed.press = pressHeld(pressed.press);
      if (pressed.press.phase === 'dragging') setDrag(id);
    }, LONG_PRESS_MS);
    touch.current = pressed;
  };
  useEffect(() => {
    const element = strip.current;
    const targetAt = (x: number, y: number): { readonly id: string; readonly side: 'before' | 'after' } | null => {
      const item = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-reorder-id]');
      if (!item || !element?.contains(item)) return null;
      const id = item.dataset['reorderId'] as string;
      return { id, side: sideAlong(axis, { x, y }, item.getBoundingClientRect()) };
    };
    const move = (event: globalThis.PointerEvent): void => {
      const current = touch.current;
      if (!current || event.pointerId !== current.pointerId) return;
      if (current.press.phase === 'pending') {
        current.press = pressMove(current.press, { x: event.clientX, y: event.clientY });
        if (current.press.phase === 'cancelled') cancelTouch();
        return;
      }
      if (current.press.phase !== 'dragging') return;
      const at = targetAt(event.clientX, event.clientY);
      const valid = at && dropOrder(latest.current.ids, current.id, at.id, at.side) ? at : null;
      const was = latest.current.over;
      if (was?.id !== valid?.id || was?.side !== valid?.side) setOver(valid);
      edgeScroll(edgeStep({ x: event.clientX, y: event.clientY }));
    };
    const up = (event: globalThis.PointerEvent): void => {
      const current = touch.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const dragging = current.press.phase === 'dragging';
      cancelTouch();
      if (!dragging) return;
      swallowClick.current = Date.now() + 600;
      drop(current.id, event.type === 'pointerup' ? targetAt(event.clientX, event.clientY) : null);
    };
    // A lifted item's finger never scrolls; only a non-passive listener may say so.
    const hold = (event: TouchEvent): void => {
      if (touch.current?.press.phase === 'dragging' && event.cancelable) event.preventDefault();
    };
    const menu = (event: Event): void => {
      if (touch.current) event.preventDefault();
    };
    const click = (event: globalThis.MouseEvent): void => {
      if (Date.now() < swallowClick.current) {
        swallowClick.current = 0;
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    element?.addEventListener('touchmove', hold, { passive: false });
    element?.addEventListener('contextmenu', menu);
    element?.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      element?.removeEventListener('touchmove', hold);
      element?.removeEventListener('contextmenu', menu);
      element?.removeEventListener('click', click, true);
    };
    // `drop` / `edgeStep` read `latest` and refs only.
  }, [axis, cancelTouch, edgeScroll]);
  useEffect(() => cancelTouch, [cancelTouch]);

  // ── mouse: HTML drag and drop ──
  const mouse = (id: string, label: string) => ({
    draggable: true,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      event.stopPropagation();
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', label);
      setDrag(id);
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      const dragged = latest.current.drag;
      if (!dragged) return;
      const side = sideAlong(axis, { x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect());
      if (!dropOrder(latest.current.ids, dragged, id, side)) {
        if (over !== null) setOver(null);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (over?.id !== id || over.side !== side) setOver({ id, side });
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      const dragged = latest.current.drag;
      if (!dragged) return;
      event.preventDefault();
      const side = sideAlong(axis, { x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect());
      drop(dragged, { id, side });
    },
    onDragEnd: end,
  });

  const frame = (
    <div
      ref={strip}
      className={className}
      data-testid={testId}
      data-axis={axis}
      data-dragging={drag ? '' : undefined}
      onDragOver={(event) => {
        if (latest.current.drag) edgeScroll(edgeStep({ x: event.clientX, y: event.clientY }));
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) edgeScroll(0);
      }}
    >
      {items.map((item) => {
        const id = idOf(item);
        return (
          <div
            key={id}
            className="sb-team-reorder-item"
            data-reorder-id={id}
            data-lifted={drag === id ? '' : undefined}
            data-drop={over?.id === id ? over.side : undefined}
            onKeyDown={onKey(id)}
            onPointerDown={touchStart(id)}
            {...mouse(id, labelOf(item))}
          >
            {children(item)}
          </div>
        );
      })}
    </div>
  );
  if (axis !== 'x') return frame;
  return (
    <div className="sb-team-strip-frame" data-fade-left={fade.start || undefined} data-fade-right={fade.end || undefined}>
      {frame}
    </div>
  );
}
