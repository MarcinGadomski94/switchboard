/**
 * D74 · long-press drag on a touch screen (`docs/responsive.md` → *Long-press
 * drag*). The HTML drag and drop of D54 / D58 / D71 needs a mouse; on a touch
 * screen a sidebar row or folder lifts after a long press (~400 ms) without
 * moving, then follows the finger over the same drop targets (`sidebar-dnd.ts`:
 * `resolveDrop`, `indicatorOf`). A finger that moves before the hold is a scroll
 * and never starts a drag. Pure, so the gesture's rules are unit-tested.
 */
import type { DropOver, RowGroup } from './sidebar-dnd.ts';
import { folderSideOf, sideOf } from './sidebar-dnd.ts';

/** How long a finger holds still before the row lifts. */
export const LONG_PRESS_MS = 400;
/** How far a finger may wander during the hold (the screen's jitter) before it counts as a scroll. */
export const TOUCH_SLOP_PX = 8;

/** A point in viewport pixels. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** `true` when `to` is more than `slop` px from `from`. */
export function movedBeyondSlop(from: Point, to: Point, slop = TOUCH_SLOP_PX): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) > slop;
}

/**
 * A press's phase: `pending` (held, waiting for the long press), `dragging`
 * (lifted), `cancelled` (moved or lifted before the hold: a scroll or a tap).
 */
export type PressPhase = 'pending' | 'dragging' | 'cancelled';

/** A touch press on a draggable row. */
export interface Press {
  readonly phase: PressPhase;
  readonly start: Point;
}

/** A press that just began at `start`. */
export function pressStart(start: Point): Press {
  return { phase: 'pending', start };
}

/** The finger moved to `to`: a pending press that moved beyond the slop is a scroll (cancelled); a drag keeps going. */
export function pressMove(press: Press, to: Point): Press {
  if (press.phase !== 'pending') return press;
  return movedBeyondSlop(press.start, to) ? { ...press, phase: 'cancelled' } : press;
}

/** The hold elapsed: a still-pending press lifts its row. */
export function pressHeld(press: Press): Press {
  return press.phase === 'pending' ? { ...press, phase: 'dragging' } : press;
}

/** What {@link dropOverAt} reads of a drop target (an element's `data-*` and box). */
export interface DropTargetElement {
  readonly dataset: Readonly<Record<string, string | undefined>>;
  getBoundingClientRect(): { readonly top: number; readonly height: number };
}

/**
 * The drop target a finger at `clientY` is over, read from the target's
 * `data-drop-zone` (and its ids), the same {@link DropOver} the mouse handlers
 * build; `null` when the element is no drop target.
 */
export function dropOverAt(target: DropTargetElement, clientY: number): DropOver | null {
  const data = target.dataset;
  const rect = target.getBoundingClientRect();
  switch (data['dropZone']) {
    case 'row': {
      const sessionId = data['sessionId'];
      if (!sessionId) return null;
      const group: RowGroup | null =
        data['group'] === 'pinned'
          ? { kind: 'pinned' }
          : data['group'] === 'loose'
            ? { kind: 'loose' }
            : data['group'] === 'folder' && data['groupFolder']
              ? { kind: 'folder', folderId: data['groupFolder'] }
              : null;
      return group ? { zone: 'row', group, sessionId, side: sideOf(clientY, rect) } : null;
    }
    case 'folder-head':
      return data['folderId'] ? { zone: 'folder-head', folderId: data['folderId'], side: folderSideOf(clientY, rect) } : null;
    case 'pinned-head':
      return { zone: 'pinned-head' };
    case 'loose':
      return { zone: 'loose' };
    default:
      return null;
  }
}
