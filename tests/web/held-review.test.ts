import { describe, expect, it } from 'vitest';
import type { FileDiff } from '../../src/core/api.ts';
import { heldScopeOptions, mergeReviewFiles, nextHeldReview, shownReview } from '../../src/web/v2/agent/held-review.ts';

/**
 * D174 follow-up (2026-11-20): "changes should never disappear during the review panel is on".
 * The side panel's For review list is held while shown (`src/web/v2/agent/held-review.ts`).
 */

const file = (path: string, added = 1): FileDiff => ({ solution: 'acme', path, branch: 'main', added, removed: 0, lines: [], uncommitted: true });

describe('the held For review list', () => {
  it('a reply or Mark reviewed clears the review: the list stays, marked reviewed, still For review (catches `if (mine.reviewed && !input.reviewOffered) return { scope: "review", … }`)', () => {
    let held = nextHeldReview(null, { type: 'answer', sessionId: 's1', files: [file('a.md')] });
    expect(shownReview(held, { sessionId: 's1', scope: 'review', reviewOffered: true, viewKind: 'scope' })).toMatchObject({ scope: 'review', held: { reviewed: false } });
    held = nextHeldReview(held, { type: 'cleared', sessionId: 's1' });
    // Without the hold, the panel falls back to what pickedScope/shownScope give without a review (head).
    const shown = shownReview(held, { sessionId: 's1', scope: 'head', reviewOffered: false, viewKind: 'scope' });
    expect(shown.scope).toBe('review');
    expect(shown.held?.files.map((f) => f.path)).toEqual(['a.md']);
    expect(shown.held?.reviewed).toBe(true);
  });

  it('a refresh with a pending review updates the list in place (catches the answer event replacing `files`)', () => {
    let held = nextHeldReview(null, { type: 'answer', sessionId: 's1', files: [file('a.md')] });
    held = nextHeldReview(held, { type: 'answer', sessionId: 's1', files: [file('a.md', 3), file('b.md')] });
    expect(held?.files.map((f) => [f.path, f.added])).toEqual([
      ['a.md', 3],
      ['b.md', 1],
    ]);
    expect(held?.reviewed).toBe(false);
  });

  it('a new review while a reviewed list is shown adds to it (catches `mine.reviewed ? mine.files : mine.earlier`)', () => {
    let held = nextHeldReview(null, { type: 'answer', sessionId: 's1', files: [file('a.md')] });
    held = nextHeldReview(held, { type: 'cleared', sessionId: 's1' });
    held = nextHeldReview(held, { type: 'answer', sessionId: 's1', files: [file('c.md')] });
    expect(held?.files.map((f) => f.path)).toEqual(['a.md', 'c.md']);
    expect(held?.reviewed).toBe(false);
    // Its refresh keeps the earlier files under the new answer.
    held = nextHeldReview(held, { type: 'answer', sessionId: 's1', files: [file('c.md', 2)] });
    expect(held?.files.map((f) => [f.path, f.added])).toEqual([
      ['a.md', 1],
      ['c.md', 2],
    ]);
  });

  it('picking another view, a turn, or another agent drops it (catches `if (event.type === "leave") return null` and the session / view checks)', () => {
    let held = nextHeldReview(null, { type: 'answer', sessionId: 's1', files: [file('a.md')] });
    held = nextHeldReview(held, { type: 'cleared', sessionId: 's1' });
    expect(shownReview(held, { sessionId: 's2', scope: 'head', reviewOffered: false, viewKind: 'scope' })).toEqual({ scope: 'head', held: null });
    expect(shownReview(held, { sessionId: 's1', scope: 'head', reviewOffered: false, viewKind: 'turn' })).toEqual({ scope: 'head', held: null });
    expect(nextHeldReview(held, { type: 'leave' })).toBeNull();
  });

  it('the render where the review is gone but the clear is not applied yet already holds it (catches the `!input.reviewOffered` branch)', () => {
    const held = nextHeldReview(null, { type: 'answer', sessionId: 's1', files: [file('a.md')] });
    expect(shownReview(held, { sessionId: 's1', scope: 'head', reviewOffered: false, viewKind: 'scope' })).toMatchObject({ scope: 'review', held: { reviewed: true, files: [{ path: 'a.md' }] } });
  });

  it('while the review is pending and another view is shown, nothing is held over it', () => {
    const held = nextHeldReview(null, { type: 'answer', sessionId: 's1', files: [file('a.md')] });
    expect(shownReview(held, { sessionId: 's1', scope: 'repo', reviewOffered: true, viewKind: 'scope' })).toEqual({ scope: 'repo', held: null });
  });

  it('cleared without a list shown changes nothing; another agent’s clear leaves this one as it is', () => {
    expect(nextHeldReview(null, { type: 'cleared', sessionId: 's1' })).toBeNull();
    const held = nextHeldReview(null, { type: 'answer', sessionId: 's1', files: [file('a.md')] });
    expect(nextHeldReview(held, { type: 'cleared', sessionId: 's2' })).toBe(held);
  });

  it('the picker keeps For review while a cleared one is held (catches `heldScopeOptions`)', () => {
    let held = nextHeldReview(null, { type: 'answer', sessionId: 's1', files: [file('a.md')] });
    expect(heldScopeOptions(['head', 'repo'], held)).toEqual(['head', 'repo']);
    held = nextHeldReview(held, { type: 'cleared', sessionId: 's1' });
    expect(heldScopeOptions(['head', 'repo'], held)).toEqual(['review', 'head', 'repo']);
    expect(heldScopeOptions(['review', 'head'], held)).toEqual(['review', 'head']);
  });

  it('merges by repository and path, newer over earlier, in path order', () => {
    expect(mergeReviewFiles([file('b.md'), file('a.md', 5)], [file('a.md', 1)]).map((f) => [f.path, f.added])).toEqual([
      ['a.md', 1],
      ['b.md', 1],
    ]);
  });
});
