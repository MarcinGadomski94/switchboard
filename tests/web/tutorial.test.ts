import { describe, expect, it } from 'vitest';
import { CARD_GAP, EDGE, SPOT_PADDING, endTours, kickerOf, placeCard, sheetEdge, spotBox, startTours, tourRunning, tourStatusText } from '../../src/web/tutorial/tour.ts';

/** D85 · the tutorial's card geometry, its run store and the Settings rows' copy. */

const VIEW = { width: 1440, height: 900 };
const CARD = { width: 360, height: 260 };

describe('tutorial geometry', () => {
  it('pads the cutout and keeps it inside the window', () => {
    expect(spotBox({ top: 100, left: 20, width: 200, height: 40 }, VIEW)).toEqual({ top: 100 - SPOT_PADDING, left: 20 - SPOT_PADDING, width: 200 + 2 * SPOT_PADDING, height: 40 + 2 * SPOT_PADDING });
    expect(spotBox({ top: 0, left: 0, width: 1440, height: 900 }, VIEW)).toEqual({ top: 2, left: 2, width: 1436, height: 896 });
  });

  it('places the card right of the cutout, else left, below, above, else over the corner', () => {
    // A sidebar element: right of it, vertically centred and clamped.
    const sidebar = placeCard({ top: 40, left: 8, width: 240, height: 30 }, CARD, VIEW);
    expect(sidebar).toEqual({ top: EDGE, left: 8 + 240 + CARD_GAP, placement: 'right' });
    // Near the right edge: left of it.
    expect(placeCard({ top: 400, left: 1200, width: 200, height: 40 }, CARD, VIEW).placement).toBe('left');
    // Full-width element at the top: below it.
    expect(placeCard({ top: 10, left: 10, width: 1420, height: 100 }, CARD, VIEW)).toMatchObject({ top: 10 + 100 + CARD_GAP, placement: 'below' });
    // Full-width element at the bottom: above it.
    expect(placeCard({ top: 700, left: 10, width: 1420, height: 150 }, CARD, VIEW)).toMatchObject({ top: 700 - CARD_GAP - 260, placement: 'above' });
    // The whole window: over the bottom-right corner, inside the window.
    expect(placeCard({ top: 2, left: 2, width: 1436, height: 896 }, CARD, VIEW)).toEqual({ top: 900 - 260 - EDGE, left: 1440 - 360 - EDGE, placement: 'over' });
  });

  it("a phone's sheet goes to the top when the element sits low", () => {
    expect(sheetEdge(null, 844)).toBe('bottom');
    expect(sheetEdge({ top: 100, left: 0, width: 390, height: 60 }, 844)).toBe('bottom');
    expect(sheetEdge({ top: 700, left: 0, width: 390, height: 100 }, 844)).toBe('top');
  });
});

describe('tutorial run store', () => {
  it('starts known tours only and ends', () => {
    startTours(['nope'], { replay: true });
    expect(tourRunning()).toBe(false);
    startTours(['nope', 'main'], { replay: true });
    expect(tourRunning()).toBe(true);
    endTours();
    expect(tourRunning()).toBe(false);
  });

  it("kicker: Tour, or What's new with the feature and its place in a chain", () => {
    expect(kickerOf('main', 0, 1)).toBe('Tour');
    expect(kickerOf('todo-board', 0, 1)).toBe("What's new · Todos board");
    expect(kickerOf('cleanup', 2, 9)).toBe("What's new · Clean-up (3 of 9)");
  });

  it('status copy of the Settings rows', () => {
    expect(tourStatusText({ status: 'completed', updatedAt: 'x' })).toBe('seen');
    expect(tourStatusText({ status: 'skipped', updatedAt: 'x' })).toBe('skipped');
    expect(tourStatusText({ status: 'pending', updatedAt: 'x' })).toBe('not seen yet');
    expect(tourStatusText({ status: null, updatedAt: null })).toBe('not shown on this machine');
    expect(tourStatusText(null)).toBe('not shown on this machine');
  });
});
