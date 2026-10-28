import { describe, expect, it } from 'vitest';
import type { SessionListItem } from '../../src/core/api.ts';
import { crewOfPin, crewPinId, isCrewPinId } from '../../src/core/crew-pins.ts';
import { HybridClock } from '../../src/core/hlc.ts';
import { type SidebarLayout, placeSession } from '../../src/core/sidebar-layout.ts';
import { EMPTY_RECORDS, layoutFromRecords, mergeRecords, recordsAfter } from '../../src/core/sidebar-records.ts';
import { fromWire, sessionIdOf, sessionKey, toWire } from '../../src/core/sidebar-sync.ts';
import type { TeamRosterEntry, TeamSummary } from '../../src/core/team.ts';
import { crewPinInput, isCrewPinned, mateStatus, needsByAgent, pinnedCrewLabel, pinnedCrewLine, pinnedCrewOf, pinnedEntries, readOpenCrews, setCrewOpen } from '../../src/web/v2/shared/pinned-model.ts';

/**
 * Fix after 2.0 (2.4.4) · pinned crews: the pin id (`src/core/crew-pins.ts`), the D71 wire key it
 * travels by, and the rail's pure rules (`src/web/v2/shared/pinned-model.ts`): the Pinned list in the
 * layout's order, a crew's teammates with archived ones left out, Pin / Unpin's place input and
 * the per-browser expanded crews.
 */

const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';

function roster(id: string, patch: Partial<TeamRosterEntry> = {}): TeamRosterEntry {
  return { id, name: `Role ${id}`, status: 'idle', sessionRef: `s-${id}`, machineName: 'Acme-MacBook', local: true, current: null, turnStartedAt: null, lastActivityAt: null, ...patch };
}

function crew(id: string, entries: readonly TeamRosterEntry[], needsYou = 0, archived?: number): TeamSummary {
  return { id, name: `Crew ${id}`, order: 0, members: entries.length, needsYou, roster: entries, ...(archived === undefined ? {} : { archived }) };
}

function session(id: string, patch: Partial<SessionListItem> = {}): SessionListItem {
  return { id, name: id, status: 'idle', closedAt: null, ...patch } as SessionListItem;
}

describe('the crew pin id', () => {
  it('is crew~<team id>; anything else is not one', () => {
    expect(crewPinId('team')).toBe('crew~team');
    expect(crewOfPin('crew~team')).toBe('team');
    expect(crewOfPin('crew~3f2a9c4e-0b1d-4e8f-9a7c-2d1e0f3b4a5c')).toBe('3f2a9c4e-0b1d-4e8f-9a7c-2d1e0f3b4a5c');
    for (const id of ['team', 'crew~', 'crew~a b', 'crew~a:b', `r~${A}~crew~team`, 'Crew~team', 42, null]) expect(isCrewPinId(id), String(id)).toBe(false);
  });
});

describe('the sync payload (D71 wire)', () => {
  it('a crew pin is its own key on every machine (a team id is shared), never <machine>:<id>', () => {
    expect(sessionKey('crew~team', A)).toBe('crew~team');
    expect(sessionIdOf('crew~team', A)).toBe('crew~team');
    expect(sessionIdOf('crew~team', B)).toBe('crew~team');
    // Sessions keep their machine-independent keys.
    expect(sessionKey('x-1', A)).toBe(`${A}:x-1`);
  });

  it('pinned on A, synced to B: the same crew pinned there, in the same order as the agents', () => {
    const clock = new HybridClock(A, () => 1_000);
    let layout: SidebarLayout = { pinned: [], folders: [], loose: [] };
    layout = placeSession(layout, { sessionId: 'x-1', place: 'pinned' }) as SidebarLayout;
    layout = placeSession(layout, crewPinInput('team', true)) as SidebarLayout;
    const after = recordsAfter(EMPTY_RECORDS, layout, () => clock.next());
    const wire = JSON.parse(JSON.stringify(toWire(after.changes, A)));
    expect(wire.places.map((p: { key: string }) => p.key)).toEqual([`${A}:x-1`, 'crew~team']);
    const onB = fromWire(wire, B);
    expect(onB.dropped).toBe(0);
    expect(layoutFromRecords(mergeRecords(EMPTY_RECORDS, onB.changes).records).pinned).toEqual([`r~${A}~x-1`, 'crew~team']);
  });

  it('a malformed crew key is dropped like any malformed place', () => {
    const clock = new HybridClock(A, () => 1_000);
    const layout = placeSession({ pinned: [], folders: [], loose: [] }, crewPinInput('team', true)) as SidebarLayout;
    const wire = JSON.parse(JSON.stringify(toWire(recordsAfter(EMPTY_RECORDS, layout, () => clock.next()).changes, A)));
    expect(fromWire(wire, B).dropped).toBe(0);
    wire.places[0].key = 'crew~a b';
    expect(fromWire(wire, B).dropped).toBe(1);
  });
});

describe('the Pinned list', () => {
  const mobile = crew('m', [roster('a', { status: 'working' }), roster('b', { status: 'needs-you' }), roster('c', { archived: true })], 1, 1);

  it('keeps the layout order: agents and crews mixed, by pin time; closed agents, unknown ids and unknown crews left out', () => {
    const sessions = [session('s1'), session('s2', { closedAt: '2026-10-28T10:00:00Z' }), session('s3')];
    const entries = pinnedEntries(['s3', 'crew~m', 's2', 'crew~gone', 'nope', 's1'], sessions, [mobile], new Map());
    expect(entries.map((entry) => `${entry.kind}:${entry.id}`)).toEqual(['agent:s3', 'crew:crew~m', 'agent:s1']);
  });

  it("a crew's teammates in its order, archived ones hidden (counted), each with its status and Needs-you count", () => {
    const needs = needsByAgent([{ agent: { sessionId: 's-b' } }, { agent: { sessionId: 's-b' } }, { agent: { sessionId: null } }, { agent: null }]);
    const pinned = pinnedCrewOf(mobile, needs);
    expect(pinned.mates.map((mate) => [mate.name, mate.status, mate.needs, mate.sessionRef])).toEqual([
      ['Role a', 'working', 0, 's-a'],
      ['Role b', 'needs', 2, 's-b'],
    ]);
    expect(pinned).toMatchObject({ teamId: 'm', name: 'Crew m', working: 1, needs: 1, archived: 1 });
    expect(pinnedCrewLine(pinned)).toBe('1 working');
    expect(pinnedCrewLine({ working: 0 })).toBe('');
    expect(pinnedCrewLabel(pinned)).toBe('Crew m, crew, 1 working, 1 needs you');
  });

  it('a teammate\'s status follows its live session, not the roster read at load time (offline / paused / Needs you still win)', () => {
    // The roster is read again only on teamChanged, so it says idle while the agent works.
    expect(mateStatus({ status: 'idle' }, 0, { status: 'run' })).toBe('working');
    expect(mateStatus({ status: 'working' }, 0, { status: 'idle' })).toBe('idle');
    expect(mateStatus({ status: 'working' }, 0, { status: 'done' })).toBe('done');
    expect(mateStatus({ status: 'idle' }, 2, { status: 'run' })).toBe('needs');
    expect(mateStatus({ status: 'offline' }, 0, { status: 'run' })).toBe('offline');
    expect(mateStatus({ status: 'paused' }, 0, { status: 'run' })).toBe('paused');
    expect(mateStatus({ status: 'working' }, 0, undefined)).toBe('working');
    const live = pinnedCrewOf(mobile, new Map(), new Map([['s-a', { status: 'idle' as const }], ['s-b', { status: 'run' as const }]]));
    expect(live.mates.map((mate) => [mate.name, mate.status])).toEqual([['Role a', 'idle'], ['Role b', 'working']]);
    expect(live.working).toBe(1);
  });

  it('archived count from the roster when the server sends none; an all-archived crew shows no teammate', () => {
    const all = pinnedCrewOf(crew('x', [roster('a', { archived: true }), roster('b', { archived: true })]), new Map());
    expect(all.mates).toEqual([]);
    expect(all.archived).toBe(2);
  });
});

describe('Pin to sidebar / Unpin', () => {
  it('pins at the end (pin time), Undo of an Unpin at its old index; unpin takes it out of the layout', () => {
    expect(crewPinInput('m', true)).toEqual({ sessionId: 'crew~m', place: 'pinned' });
    expect(crewPinInput('m', true, 2)).toEqual({ sessionId: 'crew~m', place: 'pinned', index: 2 });
    expect(crewPinInput('m', true, -1)).toEqual({ sessionId: 'crew~m', place: 'pinned' });
    expect(crewPinInput('m', false)).toEqual({ sessionId: 'crew~m', place: 'loose' });
    let layout: SidebarLayout = { pinned: ['s1'], folders: [], loose: [] };
    layout = placeSession(layout, crewPinInput('m', true)) as SidebarLayout;
    layout = placeSession(layout, crewPinInput('n', true)) as SidebarLayout;
    expect(layout.pinned).toEqual(['s1', 'crew~m', 'crew~n']);
    expect(isCrewPinned(layout.pinned, 'm')).toBe(true);
    layout = placeSession(layout, crewPinInput('m', false)) as SidebarLayout;
    expect(layout).toEqual({ pinned: ['s1', 'crew~n'], folders: [], loose: [] });
    expect(isCrewPinned(layout.pinned, 'm')).toBe(false);
  });
});

describe('expanded pinned crews (per browser)', () => {
  it('reads what was stored, anything unreadable is none, and opens / closes one', () => {
    expect(readOpenCrews(null)).toEqual([]);
    expect(readOpenCrews('nope')).toEqual([]);
    expect(readOpenCrews('{"a":1}')).toEqual([]);
    expect(readOpenCrews('["m", 3, "n"]')).toEqual(['m', 'n']);
    expect(setCrewOpen(['m'], 'n', true)).toEqual(['m', 'n']);
    expect(setCrewOpen(['m', 'n'], 'm', false)).toEqual(['n']);
    expect(setCrewOpen(['m'], 'm', true)).toEqual(['m']);
  });
});
