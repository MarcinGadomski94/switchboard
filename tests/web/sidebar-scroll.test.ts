import { describe, expect, it } from 'vitest';
import { menuTop } from '../../src/web/shell/sidebar-menu.ts';

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
