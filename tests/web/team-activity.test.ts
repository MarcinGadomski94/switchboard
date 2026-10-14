import { describe, expect, it } from 'vitest';
import type { TeamActivityKind, TeamActivityRecord } from '../../src/core/team.ts';
import { activityClock, activityVariant, chipNames, clockRange, groupActivity, groupLabel, newSince, newestAt, stripActor } from '../../src/web/team/activity.ts';

/** D100 follow-up 2026-10-14 · the Team page's activity redesign (`src/web/team/activity.ts`, `docs/team.md` → *Activity*). */

let n = 0;
function entry(at: string, kind: TeamActivityKind, memberId: string | null, text: string): TeamActivityRecord {
  n += 1;
  return { id: `a${n}`, teamId: 't1', at, kind, memberId, text };
}

const NOW = new Date(2026, 9, 14, 12, 0);
const local = (h: number, m: number, day = 14) => new Date(2026, 9, day, h, m).toISOString();

describe('stripActor: no name twice', () => {
  it('drops a leading "<actor>\'s ", "<actor>: " or "<actor> " from older stored texts', () => {
    expect(stripActor("Tech debt handler's new charter was accepted", 'Tech debt handler')).toBe('new charter was accepted');
    expect(stripActor('Tech debt handler proposed a new charter: it waits in Needs you', 'Tech debt handler')).toBe('proposed a new charter: it waits in Needs you');
    expect(stripActor('Tracker: Board triaged: 3 new.', 'Tracker')).toBe('Board triaged: 3 new.');
    expect(stripActor('Tracker paused', 'Tracker')).toBe('paused');
  });
  it('leaves actor-less texts, other names and prefixes of longer words alone', () => {
    expect(stripActor('new charter accepted', 'Tracker')).toBe('new charter accepted');
    expect(stripActor('Adopted board as Tracker', 'Tracker')).toBe('Adopted board as Tracker');
    expect(stripActor('Trackers sync', 'Tracker')).toBe('Trackers sync');
    expect(stripActor('Tracker ', 'Tracker')).toBe('Tracker ');
    expect(stripActor('anything', '')).toBe('anything');
  });
});

describe('activityVariant', () => {
  it('splits the stored kinds finer by their text (old and new phrasing)', () => {
    expect(activityVariant('update', 'new charter accepted')).toBe('charter-accepted');
    expect(activityVariant('update', "Tracker's new charter was accepted (with your edits)")).toBe('charter-accepted');
    expect(activityVariant('update', 'proposed a new charter — waiting in Needs you')).toBe('charter-proposed');
    expect(activityVariant('update', 'charter proposal dismissed')).toBe('charter-dismissed');
    expect(activityVariant('update', 'asked to draft a specific charter from its own session')).toBe('charter-asked');
    expect(activityVariant('update', 'settings changed')).toBe('settings');
    expect(activityVariant('update', 'moved to team Growth')).toBe('team-move');
    expect(activityVariant('handoff', 'finished: Fix the test.')).toBe('finished');
    expect(activityVariant('handoff', 'handed off to Developer: PROJ-14')).toBe('handoff');
    expect(activityVariant('approval', 'request approved: Resume')).toBe('approved');
    expect(activityVariant('approval', 'Declined: Resume')).toBe('declined');
    expect(activityVariant('access', 'GitHub revoked')).toBe('access-revoked');
    expect(activityVariant('pause', 'paused')).toBe('pause');
  });
});

describe('groupActivity', () => {
  it('a run of 4 charter acceptances by different members within minutes is one group', () => {
    const feed = [
      entry(local(9, 13), 'update', 'm1', 'new charter accepted'),
      entry(local(9, 13), 'update', 'm2', 'new charter accepted'),
      entry(local(9, 12), 'update', 'm3', "C's new charter was accepted"),
      entry(local(9, 12), 'update', 'm4', 'new charter accepted'),
      entry(local(9, 10), 'update', 'm1', 'proposed a new charter — waiting in Needs you'),
    ];
    const rows = groupActivity(feed);
    expect(rows.map((r) => r.type)).toEqual(['group', 'entry']);
    const group = rows[0];
    if (group?.type !== 'group') throw new Error('expected a group');
    expect(group.variant).toBe('charter-accepted');
    expect(group.entries.map((e) => e.memberId)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(groupLabel(group.variant, group.entries.length)).toBe('4 new charters accepted');
    expect(clockRange(group.entries[3]!.at, group.entries[0]!.at, NOW)).toBe('09:12–09:13');
  });
  it('a single entry, a gap over the window, a repeated member or a member-less entry ends the run', () => {
    const gap = groupActivity([entry(local(9, 30), 'pause', 'm1', 'paused'), entry(local(9, 20), 'pause', 'm2', 'paused')]);
    expect(gap.map((r) => r.type)).toEqual(['entry', 'entry']);
    const repeat = groupActivity([entry(local(9, 30), 'report', 'm1', 'a'), entry(local(9, 30), 'report', 'm1', 'b'), entry(local(9, 29), 'report', 'm2', 'c')]);
    expect(repeat.map((r) => (r.type === 'group' ? r.entries.length : 1))).toEqual([1, 2]);
    const team = groupActivity([entry(local(9, 30), 'team', null, 'renamed to A'), entry(local(9, 30), 'team', null, 'renamed to B')]);
    expect(team.map((r) => r.type)).toEqual(['entry', 'entry']);
    expect(groupActivity([entry(local(9, 30), 'pause', 'm1', 'paused')]).map((r) => r.type)).toEqual(['entry']);
    expect(groupActivity([])).toEqual([]);
  });
});

describe('times, chips and the new-count', () => {
  it('today "09:13", yesterday "yesterday 18:40", older "12 Oct 18:40"', () => {
    expect(activityClock(local(9, 13), NOW)).toBe('09:13');
    expect(activityClock(local(18, 40, 13), NOW)).toBe('yesterday 18:40');
    expect(activityClock(local(18, 40, 12), NOW)).toBe('12 Oct 18:40');
    expect(activityClock('nope', NOW)).toBe('');
    expect(clockRange(local(9, 12), local(9, 12), NOW)).toBe('09:12');
    expect(clockRange(local(18, 40, 13), local(18, 42, 13), NOW)).toBe('yesterday 18:40–18:42');
  });
  it('chips: the first two names, then +N', () => {
    expect(chipNames(['Tech debt handler', 'Marketing delivery tracking', 'C', 'D'])).toEqual({ names: ['Tech debt handler', 'Marketing delivery tracking'], more: 2 });
    expect(chipNames(['A', 'B'])).toEqual({ names: ['A', 'B'], more: 0 });
  });
  it('counts the entries newer than the seen mark; none before any mark', () => {
    const feed = [entry('2026-10-14T09:15:00.000Z', 'pause', 'm1', 'paused'), entry('2026-10-14T09:14:00.000Z', 'pause', 'm2', 'paused'), entry('2026-10-14T09:10:00.000Z', 'pause', 'm3', 'paused')];
    expect(newSince(feed, '2026-10-14T09:12:00.000Z')).toBe(2);
    expect(newSince(feed, '2026-10-14T09:15:00.000Z')).toBe(0);
    expect(newSince(feed, null)).toBe(0);
    expect(newestAt(feed)).toBe('2026-10-14T09:15:00.000Z');
    expect(newestAt([])).toBeNull();
  });
});
