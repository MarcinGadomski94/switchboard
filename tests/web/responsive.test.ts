import { describe, expect, it } from 'vitest';
import { LONG_PRESS_MS, TOUCH_SLOP_PX, dropOverAt, movedBeyondSlop, pressHeld, pressMove, pressStart } from '../../src/web/shell/touch-drag.ts';
import { COMPACT_QUERY, DESKTOP_MIN, HEADER_MENU_QUERY, PHONE_QUERY, TABLET_MIN, isCompact, layoutOf } from '../../src/web/shell/viewport.ts';

describe('D74 layout thresholds (viewport.ts)', () => {
  it('desktop from 1280 px (1366, 1440 and 1920 are desktop), tablet 768–1279, phone below', () => {
    expect(DESKTOP_MIN).toBe(1280);
    expect(TABLET_MIN).toBe(768);
    for (const width of [1280, 1366, 1440, 1920]) expect(layoutOf(width)).toBe('desktop');
    for (const width of [768, 820, 1024, 1279]) expect(layoutOf(width)).toBe('tablet');
    for (const width of [360, 390, 640, 767]) expect(layoutOf(width)).toBe('phone');
    expect(isCompact('desktop')).toBe(false);
    expect(isCompact('tablet')).toBe(true);
    expect(isCompact('phone')).toBe(true);
  });

  it('the media queries name the same thresholds as the CSS', () => {
    expect(COMPACT_QUERY).toBe('(max-width: 1279px)');
    expect(HEADER_MENU_QUERY).toBe('(max-width: 1023px)');
    expect(PHONE_QUERY).toBe('(max-width: 767px)');
  });
});

describe('D74 long-press drag (touch-drag.ts)', () => {
  it('a press lifts once held still; moving beyond the slop first is a scroll and never lifts', () => {
    expect(LONG_PRESS_MS).toBe(400);
    const start = pressStart({ x: 100, y: 200 });
    // Jitter within the slop keeps it pending; the hold lifts it.
    const jitter = pressMove(start, { x: 103, y: 204 });
    expect(jitter.phase).toBe('pending');
    expect(pressHeld(jitter).phase).toBe('dragging');
    // A swipe before the hold cancels it, and a late hold does not bring it back.
    const swiped = pressMove(start, { x: 100, y: 200 - TOUCH_SLOP_PX - 1 });
    expect(swiped.phase).toBe('cancelled');
    expect(pressHeld(swiped).phase).toBe('cancelled');
    // Once lifted, moving keeps dragging.
    expect(pressMove(pressHeld(start), { x: 300, y: 600 }).phase).toBe('dragging');
  });

  it('measures the slop as a distance', () => {
    expect(movedBeyondSlop({ x: 0, y: 0 }, { x: 5, y: 6 })).toBe(false);
    expect(movedBeyondSlop({ x: 0, y: 0 }, { x: 6, y: 6 })).toBe(true);
  });

  it('reads the drop target the mouse handlers would build from the element under the finger', () => {
    const box = { top: 100, height: 40 };
    const el = (dataset: Record<string, string>) => ({ dataset, getBoundingClientRect: () => box });
    expect(dropOverAt(el({ dropZone: 'row', sessionId: 's1', group: 'loose' }), 110)).toEqual({ zone: 'row', group: { kind: 'loose' }, sessionId: 's1', side: 'before' });
    expect(dropOverAt(el({ dropZone: 'row', sessionId: 's1', group: 'folder', groupFolder: 'f1' }), 130)).toEqual({
      zone: 'row',
      group: { kind: 'folder', folderId: 'f1' },
      sessionId: 's1',
      side: 'after',
    });
    expect(dropOverAt(el({ dropZone: 'row', sessionId: 's1', group: 'pinned' }), 110)).toMatchObject({ group: { kind: 'pinned' } });
    expect(dropOverAt(el({ dropZone: 'folder-head', folderId: 'f1' }), 120)).toEqual({ zone: 'folder-head', folderId: 'f1', side: 'into' });
    expect(dropOverAt(el({ dropZone: 'folder-head', folderId: 'f1' }), 101)).toEqual({ zone: 'folder-head', folderId: 'f1', side: 'before' });
    expect(dropOverAt(el({ dropZone: 'pinned-head' }), 120)).toEqual({ zone: 'pinned-head' });
    expect(dropOverAt(el({ dropZone: 'loose' }), 120)).toEqual({ zone: 'loose' });
    expect(dropOverAt(el({}), 120)).toBeNull();
    expect(dropOverAt(el({ dropZone: 'row', group: 'loose' }), 120)).toBeNull();
  });
});
