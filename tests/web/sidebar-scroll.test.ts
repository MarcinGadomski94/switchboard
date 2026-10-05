import { describe, expect, it } from 'vitest';
import { DRAG_SCROLL_MAX, dragScrollStep, menuTop } from '../../src/web/shell/sidebar-menu.ts';

/** Fix: sidebar scrolling · where a row's ⋯ menu opens (`docs/sidebar.md` → *Layout and scrolling*). */
describe('menuTop', () => {
  const anchor = { top: 600, bottom: 620 };

  it('opens under its ⋯ when it fits there (4 px gap, 8 px from the window edge)', () => {
    expect(menuTop(anchor, 100, 900)).toBe(624);
    expect(menuTop(anchor, 268, 900)).toBe(624); // 624 + 268 = 892 = 900 − 8
  });

  it('opens above its ⋯ when the window has no room below', () => {
    expect(menuTop(anchor, 269, 900)).toBe(600 - 4 - 269);
    expect(menuTop({ top: 860, bottom: 880 }, 90, 900)).toBe(860 - 4 - 90);
  });

  it('fits neither way: kept inside the window, as low as it can start under its ⋯', () => {
    expect(menuTop({ top: 300, bottom: 320 }, 700, 900)).toBe(192); // 900 − 8 − 700
    expect(menuTop({ top: 100, bottom: 120 }, 700, 900)).toBe(124);
    expect(menuTop({ top: 300, bottom: 320 }, 1000, 900)).toBe(8);
  });
});

describe('dragScrollStep (D71 fix: the list scrolls itself while a drag is held at its edge)', () => {
  const box = { top: 400, bottom: 700 };
  it('scrolls up near the top, down near the bottom, faster closer to the edge', () => {
    expect(dragScrollStep(400, box)).toBe(-DRAG_SCROLL_MAX);
    expect(dragScrollStep(700, box)).toBe(DRAG_SCROLL_MAX);
    expect(dragScrollStep(420, box)).toBeLessThan(0);
    expect(dragScrollStep(420, box)).toBeGreaterThan(dragScrollStep(401, box));
    expect(dragScrollStep(690, box)).toBeGreaterThan(0);
  });
  it('does nothing in the middle or outside the list', () => {
    expect(dragScrollStep(550, box)).toBe(0);
    expect(dragScrollStep(399, box)).toBe(0);
    expect(dragScrollStep(701, box)).toBe(0);
  });
  it('a short list keeps a middle where nothing scrolls', () => {
    const small = { top: 0, bottom: 80 };
    expect(dragScrollStep(40, small)).toBe(0);
    expect(dragScrollStep(5, small)).toBeLessThan(0);
  });
});
