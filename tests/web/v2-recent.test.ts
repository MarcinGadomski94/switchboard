import { describe, expect, it } from 'vitest';
import { RECENT_KEPT, RECENT_SHOWN, parseRecent, recentAgents, touchRecent } from '../../src/web/v2/shared/recent-model.ts';

/** Fix after 2.0 · the rail's Recent: ordering, dedupe, pinned left out, closed dropped, at most 5. */

const s = (id: string, closedAt: string | null = null) => ({ id, closedAt });

describe('recent model', () => {
  it('a touch moves the agent first, without a duplicate', () => {
    let marks = touchRecent([], 'a', 1);
    marks = touchRecent(marks, 'b', 2);
    marks = touchRecent(marks, 'a', 3);
    expect(marks).toEqual([
      { id: 'a', at: 3 },
      { id: 'b', at: 2 },
    ]);
  });
  it('keeps at most RECENT_KEPT marks', () => {
    let marks = touchRecent([], 'x0', 0);
    for (let i = 1; i < RECENT_KEPT + 10; i += 1) marks = touchRecent(marks, `x${i}`, i);
    expect(marks).toHaveLength(RECENT_KEPT);
    expect(marks[0]?.id).toBe(`x${RECENT_KEPT + 9}`);
  });
  it('lists the open ones newest first, at most 5, pinned left out, closed or deleted dropped', () => {
    const marks = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id, i) => ({ id, at: 100 - i }));
    const sessions = [s('a'), s('b'), s('c', '2026-10-26T08:00:00.000Z'), s('d'), s('e'), s('f'), s('g'), s('h')];
    // b is pinned, c is closed, deleted ones are simply missing from the list.
    const list = recentAgents(marks, sessions.filter((x) => x.id !== 'e'), ['b']);
    expect(RECENT_SHOWN).toBe(5);
    expect(list.map((x) => x.id)).toEqual(['a', 'd', 'f', 'g', 'h']);
    expect(recentAgents([{ id: 'a', at: 1 }, { id: 'd', at: 5 }], sessions, []).map((x) => x.id)).toEqual(['d', 'a']);
  });
  it('reads the stored marks safely (malformed, duplicate, unsorted)', () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent('nope')).toEqual([]);
    expect(parseRecent('{"a":1}')).toEqual([]);
    expect(parseRecent(JSON.stringify([{ id: 'a', at: 1 }, { id: 'b', at: 5 }, { id: 'a', at: 9 }, { id: 3, at: 2 }, null]))).toEqual([
      { id: 'b', at: 5 },
      { id: 'a', at: 1 },
    ]);
  });
});
