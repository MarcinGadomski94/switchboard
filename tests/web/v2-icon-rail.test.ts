import { describe, expect, it } from 'vitest';
import { RAIL_LABELS, PHONE_TABS, RESULTS_WORDS } from '../../src/web/v2/glossary.ts';
import { parseV2Route } from '../../src/web/v2/routes.ts';
import { RECENT_COUNT_MAX, RECENT_SHOWN, readRecentCount, recentAgents } from '../../src/web/v2/shared/recent-model.ts';
import type { PinnedEntry } from '../../src/web/v2/shared/pinned-model.ts';
import { pinnedNeeds, railTip, rowComputerName } from '../../src/web/v2/shell/rail-model.ts';

/** D181 · the icon rail's rules: the computer on a pinned / recent row, the Pinned count, Recent's number, Artifacts. */

describe('D181 · the computer a pinned or recent row names', () => {
  it("a paired computer's agent: that computer, always", () => {
    expect(rowComputerName({ name: 'Acme-MacBook' }, 'Acme-PC', true)).toBe('Acme-MacBook');
    expect(rowComputerName({ name: 'Acme-MacBook' }, null, false)).toBe('Acme-MacBook');
  });

  it("this computer's agent: this computer once a computer is paired, nothing with none (or before its name is known)", () => {
    expect(rowComputerName(null, 'Acme-PC', true)).toBe('Acme-PC');
    expect(rowComputerName(undefined, 'Acme-PC', false)).toBeNull();
    expect(rowComputerName(null, null, true)).toBeNull();
  });
});

describe('D181 · the Pinned button counts what the pins need from you', () => {
  const agent = (id: string): PinnedEntry => ({ kind: 'agent', id, session: { id } as never });
  const crew = (needs: number): PinnedEntry => ({ kind: 'crew', id: `crew~${needs}`, crew: { needs } as never });
  const project = (needs: number): PinnedEntry => ({ kind: 'project', id: `plan~${needs}`, project: { needs } as never });

  it("sums an agent's Needs-you items, a crew's and a project's steps", () => {
    const needs = new Map([['a1', 2], ['a2', 0]]);
    expect(pinnedNeeds([agent('a1'), agent('a2'), agent('a3'), crew(1), project(3)], needs)).toBe(6);
  });

  it('nothing pinned or nothing waiting: 0 (no badge)', () => {
    expect(pinnedNeeds([], new Map())).toBe(0);
    expect(pinnedNeeds([agent('a1'), crew(0)], new Map())).toBe(0);
  });

  it("a tooltip says what the count means, and only when there is one", () => {
    expect(railTip('Pinned', '2 need you')).toBe('Pinned · 2 need you');
    expect(railTip('Pinned', null)).toBe('Pinned');
  });
});

describe('D181 · how many agents Recent shows (Settings, per browser)', () => {
  it('reads a whole number 0–20; default 5; past 20 is 20', () => {
    expect(RECENT_SHOWN).toBe(5);
    expect(readRecentCount(null)).toBe(5);
    expect(readRecentCount('8')).toBe(8);
    expect(readRecentCount('0')).toBe(0);
    expect(readRecentCount('99')).toBe(RECENT_COUNT_MAX);
    for (const bad of ['', '-1', '2.5', 'ten', ' ']) expect(readRecentCount(bad), bad).toBe(5);
  });

  it('Recent lists at most that many', () => {
    const sessions = Array.from({ length: 12 }, (_, n) => ({ id: `s${n}`, closedAt: null }));
    const marks = sessions.map((session, n) => ({ id: session.id, at: 100 - n }));
    expect(recentAgents(marks, sessions, [], readRecentCount('8'))).toHaveLength(8);
    expect(recentAgents(marks, sessions, [], readRecentCount('0'))).toEqual([]);
    expect(recentAgents(marks, sessions, [])).toHaveLength(5);
  });
});

describe('D181 · Results is called Artifacts', () => {
  it('the rail, the phone tab and the page say Artifacts; /artifacts opens the page', () => {
    expect(RAIL_LABELS.results).toBe('Artifacts');
    expect(PHONE_TABS.results).toBe('Artifacts');
    expect(RESULTS_WORDS.title).toBe('Artifacts');
    expect(parseV2Route('/artifacts')).toEqual({ area: 'results' });
    expect(parseV2Route('/results')).toEqual({ area: 'results' });
  });
});
