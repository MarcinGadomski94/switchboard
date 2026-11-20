import { describe, expect, it } from 'vitest';
import { RAIL_LABELS, PHONE_TABS, RESULTS_WORDS } from '../../src/web/v2/glossary.ts';
import { parseV2Route } from '../../src/web/v2/routes.ts';
import { RECENT_COUNT_MAX, RECENT_SHOWN, readRecentCount, recentAgents } from '../../src/web/v2/shared/recent-model.ts';
import { RAIL_AREAS } from '../../src/web/v2/routes.ts';
import { RAIL_WIDTH_DEFAULT, RAIL_WIDTH_MAX, RAIL_WIDTH_MIN, RAIL_WIDTH_STEP, clampRailWidth, railWidthByKey, readRailWidth, rowComputerName } from '../../src/web/v2/shell/rail-model.ts';

describe('D181 (2026-11-20) · the sidebar width (the resize handle)', () => {
  it('200–400 px, 232 by default, whole pixels; nonsense is the default', () => {
    expect([RAIL_WIDTH_MIN, RAIL_WIDTH_DEFAULT, RAIL_WIDTH_MAX, RAIL_WIDTH_STEP]).toEqual([200, 232, 400, 16]);
    // Catches the min clamp (Math.max(RAIL_WIDTH_MIN, …)).
    expect(clampRailWidth(120)).toBe(200);
    // Catches the max clamp (Math.min(RAIL_WIDTH_MAX, …)).
    expect(clampRailWidth(900)).toBe(400);
    // Catches the rounding.
    expect(clampRailWidth(300.6)).toBe(301);
    // Catches the Number.isFinite guard.
    expect(clampRailWidth(Number.NaN)).toBe(232);
  });

  it('the remembered width: nothing, empty or unreadable → 232; a number → kept in range', () => {
    expect(readRailWidth(null)).toBe(232);
    expect(readRailWidth('')).toBe(232);
    expect(readRailWidth('wide')).toBe(232);
    expect(readRailWidth('320')).toBe(320);
    expect(readRailWidth('9999')).toBe(400);
  });

  it('keys: ← / → by 16 px within the range, Home / End to the ends, other keys do nothing', () => {
    expect(railWidthByKey(232, 'ArrowRight')).toBe(248);
    expect(railWidthByKey(232, 'ArrowLeft')).toBe(216);
    expect(railWidthByKey(392, 'ArrowRight')).toBe(400);
    expect(railWidthByKey(208, 'ArrowLeft')).toBe(200);
    expect(railWidthByKey(300, 'Home')).toBe(200);
    expect(railWidthByKey(300, 'End')).toBe(400);
    expect(railWidthByKey(300, 'Enter')).toBeNull();
  });
});

/** D181 · the rail's rules: the computer on a pinned / recent row, Recent's number, Artifacts, the eight grid icons. */

describe('D181 (corrected 2026-11-20) · eight destinations for the two rows of four', () => {
  it('in order, Settings last', () => {
    expect(RAIL_AREAS).toEqual(['home', 'agents', 'projects', 'crews', 'results', 'tasks', 'terminals', 'settings']);
  });
});

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
