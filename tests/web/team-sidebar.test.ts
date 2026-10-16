import { describe, expect, it } from 'vitest';
import type { TeamRosterEntry } from '../../src/core/team.ts';
import { ROSTER_GLYPH, collapsedSummary, hasDuration, itemLabel, rosterLine, rosterTitle, shortDuration } from '../../src/web/team/sidebar-roster.ts';

/** D100 follow-up 2026-10-16 · the sidebar's member rows (`src/web/team/sidebar-roster.ts`). */

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60_000;

function entry(patch: Partial<TeamRosterEntry>): TeamRosterEntry {
  return { id: 'm1', name: 'Builder', status: 'idle', sessionRef: 's1', machineName: 'Studio', local: true, current: null, turnStartedAt: null, lastActivityAt: null, ...patch };
}

describe('shortDuration', () => {
  it('is minute-grained, then hours, then days', () => {
    expect(shortDuration(0)).toBe('0m');
    expect(shortDuration(59_999)).toBe('0m');
    expect(shortDuration(40 * MIN)).toBe('40m');
    expect(shortDuration(60 * MIN)).toBe('1h');
    expect(shortDuration(47 * 60 * MIN)).toBe('47h');
    expect(shortDuration(72 * 60 * MIN)).toBe('3d');
    expect(shortDuration(-5)).toBe('0m');
  });
});

describe('itemLabel', () => {
  it('names a plan item by its key, else shortens the title', () => {
    expect(itemLabel({ key: 'PROJ-14', title: 'Wire the sidebar member rows' })).toBe('PROJ-14');
    expect(itemLabel({ key: null, title: 'Fix the login' })).toBe('Fix the login');
    expect(itemLabel({ key: null, title: 'Wire the sidebar member rows' })).toBe('Wire the sideba…');
  });
});

describe('rosterLine', () => {
  it('working: the current item (a todo, a plan item) and the time since the turn started', () => {
    expect(rosterLine(entry({ status: 'working', current: { key: null, title: 'Fix the login' }, turnStartedAt: ago(40 * MIN) }), NOW)).toBe('Fix the login · 40m');
    expect(rosterLine(entry({ status: 'working', current: { key: 'PROJ-14', title: 'Sidebar' }, turnStartedAt: ago(40 * MIN) }), NOW)).toBe('PROJ-14 · 40m');
  });

  it('working without a known item: "working · 12m"; without a known start, no time', () => {
    expect(rosterLine(entry({ status: 'working', turnStartedAt: ago(12 * MIN + 30_000) }), NOW)).toBe('working · 12m');
    expect(rosterLine(entry({ status: 'working' }), NOW)).toBe('working');
    expect(rosterLine(entry({ status: 'working', current: { key: 'PROJ-9', title: 'x' } }), NOW)).toBe('PROJ-9');
  });

  it('needs you, paused and offline are words', () => {
    expect(rosterLine(entry({ status: 'needs-you', lastActivityAt: ago(MIN) }), NOW)).toBe('needs you');
    expect(rosterLine(entry({ status: 'paused', lastActivityAt: ago(MIN) }), NOW)).toBe('paused');
    expect(rosterLine(entry({ status: 'offline', lastActivityAt: ago(MIN) }), NOW)).toBe('offline');
  });

  it('idle: the time since the last activity', () => {
    expect(rosterLine(entry({ status: 'idle', lastActivityAt: ago(2 * 60 * MIN + 5 * MIN) }), NOW)).toBe('idle · 2h');
    expect(rosterLine(entry({ status: 'idle', lastActivityAt: ago(3 * MIN) }), NOW)).toBe('idle · 3m');
    expect(rosterLine(entry({ status: 'idle' }), NOW)).toBe('idle');
    expect(rosterLine(entry({ status: 'idle', lastActivityAt: 'not a time' }), NOW)).toBe('idle');
  });
});

describe('rosterTitle', () => {
  it('carries the full name, the full item and, offline, the other PC', () => {
    expect(rosterTitle(entry({ status: 'idle', name: 'A very long role name indeed' }))).toBe('A very long role name indeed · idle');
    expect(rosterTitle(entry({ status: 'working', current: { key: 'PROJ-14', title: 'Sidebar rows' } }))).toBe('Builder · working on PROJ-14 Sidebar rows');
    expect(rosterTitle(entry({ status: 'offline', machineName: 'Office PC' }))).toBe('Builder · offline: runs on Office PC, which is not reachable');
    expect(rosterTitle(entry({ status: 'needs-you' }))).toBe('Builder · needs you');
  });
});

describe('the glyphs, the folded summary, the minute tick', () => {
  it('has a glyph per status', () => {
    expect(ROSTER_GLYPH).toEqual({ working: '●', 'needs-you': '?', idle: '○', paused: '⏸', offline: '⌁' });
  });

  it('summarises a folded team without the members that need you (the row counts them)', () => {
    const roster = [entry({ status: 'working' }), entry({ status: 'working' }), entry({ status: 'idle' }), entry({ status: 'needs-you' }), entry({ status: 'offline' })];
    expect(collapsedSummary(roster)).toBe('2 working · 1 idle · 1 offline');
    expect(collapsedSummary([entry({ status: 'needs-you' })])).toBe('');
    expect(collapsedSummary([])).toBe('');
  });

  it('ticks only while a row shows a duration', () => {
    expect(hasDuration([entry({ status: 'paused', lastActivityAt: ago(MIN) })])).toBe(false);
    expect(hasDuration([entry({ status: 'working' })])).toBe(false);
    expect(hasDuration([entry({ status: 'working', turnStartedAt: ago(MIN) })])).toBe(true);
    expect(hasDuration([entry({ status: 'idle', lastActivityAt: ago(MIN) })])).toBe(true);
  });
});
