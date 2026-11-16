import { describe, expect, it } from 'vitest';
import { REVIEW_FILES_MAX, addReviewTurn, readSessionReview, reviewItemDetail, reviewItemTitle, reviewStripText, reviewsSession } from '../../src/core/review.ts';

/**
 * D166 (`docs/inbox.md` → *To review*): the pure rules of an agent's pending review: a
 * file-changing turn starts or grows it (one per episode), a project step's run never gets one,
 * the stored value is read defensively, and the words of the card and the strip.
 */

const AT = '2026-11-16T10:00:00.000Z';
const LATER = '2026-11-16T10:05:00.000Z';

describe('D166 · the pending review', () => {
  it('a file-changing turn starts it; a further one grows it (same episode, distinct files counted once)', () => {
    const first = addReviewTurn(null, ['/w/a.ts', '/w/b.ts'], AT);
    expect(first).toEqual({ since: AT, turns: 1, fileCount: 2, files: ['/w/a.ts', '/w/b.ts'] });
    const second = addReviewTurn(first, ['/w/b.ts', '/w/c.ts'], LATER);
    expect(second).toEqual({ since: AT, turns: 2, fileCount: 3, files: ['/w/a.ts', '/w/b.ts', '/w/c.ts'] });
  });

  it('keeps at most REVIEW_FILES_MAX paths while the count goes on', () => {
    const many = Array.from({ length: REVIEW_FILES_MAX + 7 }, (_, i) => `/w/f${i}.ts`);
    const pending = addReviewTurn(null, many, AT);
    expect(pending.files).toHaveLength(REVIEW_FILES_MAX);
    expect(pending.fileCount).toBe(REVIEW_FILES_MAX + 7);
  });

  it('a project step’s run (todoLink) never gets one; any other session does', () => {
    expect(reviewsSession({ todoLink: { sourceSessionId: 's', todoId: 't' } })).toBe(false);
    expect(reviewsSession({ todoLink: null })).toBe(true);
    expect(reviewsSession({})).toBe(true);
  });

  it('reads a stored value defensively', () => {
    expect(readSessionReview(null)).toEqual({ pending: null, cursor: null });
    expect(readSessionReview({ cursor: 12 })).toEqual({ pending: null, cursor: 12 });
    expect(readSessionReview({ pending: { since: AT, turns: 1 }, cursor: 'x' })).toEqual({ pending: null, cursor: null });
    expect(readSessionReview({ pending: { since: AT, turns: 2, fileCount: 2, files: ['/a', 3, '/b'] }, cursor: 4 })).toEqual({ pending: { since: AT, turns: 2, fileCount: 2, files: ['/a', '/b'] }, cursor: 4 });
  });

  it('the card and the strip say how much changed', () => {
    const one = addReviewTurn(null, ['C:\\w\\src\\a.ts'], AT);
    expect(reviewItemTitle('Checkout fix', one)).toBe('Review: Checkout fix · 1 file changed');
    expect(reviewItemDetail(one)).toBe('Its last turn changed 1 file: a.ts. Review the changes, then Mark reviewed (or reply to the agent).');
    expect(reviewStripText(one)).toBe('Changed 1 file');
    const more = addReviewTurn(addReviewTurn(null, ['/1', '/2', '/3'], AT), ['/4', '/5', '/6', '/7'], LATER);
    expect(reviewItemTitle('X', more)).toBe('Review: X · 7 files changed');
    expect(reviewItemDetail(more)).toBe('Its last 2 turns changed 7 files: 1, 2, 3, 4, 5, and 2 more. Review the changes, then Mark reviewed (or reply to the agent).');
    expect(reviewStripText(more)).toBe('Changed 7 files in 2 turns');
  });
});
