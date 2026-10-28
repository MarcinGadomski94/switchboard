import { describe, expect, it } from 'vitest';
import type { TeamActivityRecord, TeamHandoff, TeamMember, TeamRosterEntry, TeamSummary } from '../../src/core/team.ts';
import {
  activityRows,
  ARCHIVED_HREF,
  activityText,
  archivedLine,
  budgetMeter,
  checkBudget,
  computerChoices,
  crewHref,
  crewInitials,
  crewLine,
  crewQuery,
  crewStats,
  dropCrew,
  handoffRows,
  moveComputerReason,
  moveCrew,
  moveCrewReason,
  openChatReason,
  orderedCrews,
  rhythmText,
  teammateStatus,
  undoOrder,
  v2ModelText,
} from '../../src/web/v2/crews/crew-model.ts';
import { CREW_WORDS } from '../../src/web/v2/glossary.ts';

/**
 * D131 · lane P · the Crews pages' pure rules (`src/web/v2/crews/crew-model.ts`): a crew's counts
 * and computers, the crews' order (drag, Move up / down), Undo of a move to another crew, a
 * teammate's status and budget meter, the deep link from Needs you, the move-to-computer choices.
 */

function roster(id: string, patch: Partial<TeamRosterEntry> = {}): TeamRosterEntry {
  return { id, name: `Role ${id}`, status: 'idle', sessionRef: `s-${id}`, machineName: 'Acme-MacBook', local: true, current: null, turnStartedAt: null, lastActivityAt: null, ...patch };
}

function crew(id: string, entries: readonly TeamRosterEntry[], needsYou = 0): TeamSummary {
  return { id, name: `Crew ${id}`, order: 0, members: entries.length, needsYou, roster: entries };
}

function member(id: string, patch: Partial<TeamMember> = {}): TeamMember {
  return {
    id,
    teamId: 'team',
    name: `Role ${id}`,
    charter: { owns: '', produces: '', neverDoes: '' },
    charterDraft: null,
    templateId: null,
    machineId: 'self',
    sessionId: `s-${id}`,
    workplace: { folders: [] },
    provider: null,
    model: null,
    effort: null,
    rhythm: { loops: [], onHandoff: false },
    budget: { dailyPct: null, profileId: null },
    gates: ['outward-facing'],
    paused: false,
    pausedLoops: [],
    pausedBy: null,
    cliLoops: [],
    originalPlace: { place: 'none', folderId: null, index: null },
    access: [],
    order: 0,
    createdAt: '2026-10-25T08:00:00.000Z',
    updatedAt: '2026-10-25T08:00:00.000Z',
    status: 'idle',
    sessionRef: `s-${id}`,
    sessionTitle: null,
    machineName: 'Acme-MacBook',
    local: true,
    cliLoopsUnmanaged: false,
    usedTodayPct: null,
    ...patch,
  };
}

describe('a crew', () => {
  it('counts its teammates, who works, who needs you and its computers', () => {
    const stats = crewStats(crew('c', [roster('a', { status: 'working' }), roster('b', { status: 'needs-you', machineName: 'Studio-PC', local: false }), roster('c', { status: 'working', machineName: 'Studio-PC', local: false })], 1));
    expect(stats).toEqual({ members: 3, working: 2, needs: 1, computers: [{ name: 'Acme-MacBook', local: true }, { name: 'Studio-PC', local: false }], archived: 0 });
    expect(crewLine(stats)).toBe('3 teammates · 2 working');
    expect(crewStats({ members: 0, needsYou: 0 })).toEqual({ members: 0, working: 0, needs: 0, computers: [], archived: 0 });
  });

  it('2026-10-27 (D137 follow-up): archived teammates leave its counts, its computers and its line', () => {
    const entries = [roster('a', { status: 'working' }), roster('b', { status: 'offline', machineName: 'Studio-PC', local: false, archived: true }), roster('c', { status: 'offline', archived: true })];
    const stats = crewStats({ ...crew('c', entries, 0), archived: 2 });
    expect(stats).toEqual({ members: 1, working: 1, needs: 0, computers: [{ name: 'Acme-MacBook', local: true }], archived: 2 });
    expect(crewLine(stats)).toBe('1 teammate · 1 working');
    expect(archivedLine(stats.archived)).toBe('2 archived teammates');
    expect(archivedLine(1)).toBe('1 archived teammate');
    expect(archivedLine(0)).toBeNull();
    expect(ARCHIVED_HREF).toBe('/agents?show=closed');
    // An answer without the count (only the flags): counted from the roster.
    expect(crewStats(crew('c', entries, 0))).toMatchObject({ members: 1, archived: 2 });
    // Every teammate archived: the crew is still there, with none shown.
    const gone = crewStats({ ...crew('d', [roster('x', { archived: true })]), archived: 1 });
    expect(gone).toEqual({ members: 0, working: 0, needs: 0, computers: [], archived: 1 });
    expect(CREW_WORDS.showInArchived).toBe('Show in Archived');
  });

  it('initials for its avatar', () => {
    expect(crewInitials('Acme Mobile')).toBe('AM');
    expect(crewInitials('core')).toBe('C');
    expect(crewInitials('  ')).toBe('?');
  });

  it('words', () => {
    expect(CREW_WORDS.inOrder(0)).toBe('1st in your order');
    expect(CREW_WORDS.teammates(1)).toBe('1 teammate');
    expect(CREW_WORDS.movedTo('Developer', 'Acme Mobile')).toBe('Moved Developer to Acme Mobile. Synced everywhere.');
  });
});

describe('the crews’ order', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('Move up / Move down, and why not at the ends', () => {
    expect(moveCrew(ids, 'b', -1)).toEqual(['b', 'a', 'c', 'd']);
    expect(moveCrew(ids, 'b', 1)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveCrew(ids, 'a', -1)).toBeNull();
    expect(moveCrewReason(ids, 'a', -1)).toBe('Already first.');
    expect(moveCrewReason(ids, 'd', 1)).toBe('Already last.');
    expect(moveCrewReason(ids, 'b', 1)).toBeNull();
  });

  it('a drop takes the target’s place', () => {
    expect(dropCrew(ids, 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
    expect(dropCrew(ids, 'd', 'a')).toEqual(['d', 'a', 'b', 'c']);
    expect(dropCrew(ids, 'b', 'b')).toBeNull();
    expect(dropCrew(ids, 'x', 'b')).toBeNull();
  });

  it('the pending order wins while it saves', () => {
    const crews = ids.map((id) => ({ id }));
    expect(orderedCrews(crews, ['c', 'a', 'b', 'd']).map((entry) => entry.id)).toEqual(['c', 'a', 'b', 'd']);
    expect(orderedCrews(crews, null).map((entry) => entry.id)).toEqual(ids);
  });

  it('Undo of a move to another crew puts the teammate back in its place', () => {
    // It left from the middle; the server put it back at the end.
    expect(undoOrder(['x', 'm', 'y'], ['x', 'y', 'm'])).toEqual(['x', 'm', 'y']);
    // Someone joined meanwhile: kept after the others.
    expect(undoOrder(['x', 'm', 'y'], ['x', 'y', 'n', 'm'])).toEqual(['x', 'm', 'y', 'n']);
    expect(undoOrder(['x', 'm'], ['x', 'm'])).toBeNull();
  });
});

describe('a teammate', () => {
  it('needs you also while Needs-you items of it wait; paused and offline win', () => {
    expect(teammateStatus(member('a'), [])).toBe('idle');
    expect(teammateStatus(member('a'), [{ memberId: 'a' }])).toBe('needs');
    expect(teammateStatus(member('a', { status: 'working' }), [])).toBe('working');
    expect(teammateStatus(member('a', { status: 'paused' }), [{ memberId: 'a' }])).toBe('paused');
    expect(teammateStatus(member('a', { status: 'offline' }), [{ memberId: 'a' }])).toBe('offline');
  });

  it('its rhythm in plain words', () => {
    expect(rhythmText(member('a'))).toBe('On request');
    expect(rhythmText(member('a', { rhythm: { loops: [], onHandoff: true } }))).toBe('Picks up hand-offs');
    expect(rhythmText(member('a', { rhythm: { loops: [{ loopId: 'l', label: null, prompt: 'p', scheduleText: 'daily' }], onHandoff: true } }))).toBe('Picks up hand-offs · 1 routine');
  });

  it('its budget meter', () => {
    expect(budgetMeter(member('a'))).toBeNull();
    expect(budgetMeter(member('a', { budget: { dailyPct: 20, profileId: null } }))).toEqual({ fill: 0, text: '20% of the account a day', over: false });
    expect(budgetMeter(member('a', { budget: { dailyPct: 20, profileId: null }, usedTodayPct: 10 }))).toEqual({ fill: 50, text: '10% of 20% today', over: false });
    expect(budgetMeter(member('a', { budget: { dailyPct: 20, profileId: null }, usedTodayPct: 30 }))).toEqual({ fill: 100, text: '30% of 20% today', over: true });
  });

  it('the budget field', () => {
    expect(checkBudget('')).toEqual({ ok: true, dailyPct: null });
    expect(checkBudget('25%')).toEqual({ ok: true, dailyPct: 25 });
    expect(checkBudget('0').ok).toBe(false);
    expect(checkBudget('101').ok).toBe(false);
    expect(checkBudget('2.5').ok).toBe(false);
  });
});

describe('the deep link', () => {
  it('Needs you’s Add key opens the teammate’s Access tab', () => {
    expect(crewQuery('?member=m1&tab=access')).toEqual({ member: 'm1', tab: 'access' });
    expect(crewQuery('member=m1')).toEqual({ member: 'm1', tab: 'overview' });
    expect(crewQuery('')).toEqual({ member: null, tab: 'overview' });
    expect(crewHref('team', 'm1', 'access')).toBe('/crews/team?member=m1&tab=access');
    expect(crewHref('team', 'm1')).toBe('/crews/team?member=m1');
    expect(crewHref('a b')).toBe('/crews/a%20b');
  });
});

describe('moving to a computer', () => {
  const self = { id: 'mac', name: 'Acme-MacBook' };
  const machines = [
    { id: 'pc', name: 'Studio-PC', state: 'online' as const },
    { id: 'old', name: 'Old-PC', state: 'offline' as const },
    { id: 'lap', name: 'Laptop', state: 'reconnecting' as const },
  ];

  it('lists this computer and the paired ones; offline ones are disabled with the reason', () => {
    const choices = computerChoices(member('a'), self, machines);
    expect(choices.map((choice) => [choice.name, choice.current, choice.disabledReason])).toEqual([
      ['Acme-MacBook', true, null],
      ['Studio-PC', false, null],
      ['Old-PC', false, 'Offline · can’t move there now.'],
      ['Laptop', false, 'Reconnecting… can’t move there now.'],
    ]);
    expect(computerChoices(member('a', { local: false, machineId: 'pc' }), self, machines).find((choice) => choice.current)?.name).toBe('Studio-PC');
  });

  it('the menu entry is off while its computer is offline, with nowhere to go, or while it works', () => {
    expect(moveComputerReason(member('a', { status: 'offline', machineName: 'Studio-PC' }), machines)).toBe('Studio-PC is offline; it can move once it reconnects.');
    expect(moveComputerReason(member('a'), [])).toBe('Pair another computer first (Settings › Computers).');
    expect(moveComputerReason(member('a', { status: 'working' }), machines)).toBe('It is working; it moves once its current reply is done.');
    expect(moveComputerReason(member('a'), machines)).toBeNull();
  });
});

describe('the lists', () => {
  it('activity rows: the actor and the text without it', () => {
    const activity: TeamActivityRecord[] = [
      { id: '1', teamId: 'team', at: '2026-10-25T09:00:00.000Z', kind: 'pause', memberId: 'a', text: 'Role a paused' },
      { id: '2', teamId: 'team', at: '2026-10-25T08:00:00.000Z', kind: 'team', memberId: null, text: 'renamed to Core' },
    ];
    expect(activityRows(activity, [member('a')])).toEqual([
      { id: '1', at: '2026-10-25T09:00:00.000Z', who: 'Role a', text: 'paused' },
      { id: '2', at: '2026-10-25T08:00:00.000Z', who: 'Crew', text: 'renamed to Core' },
    ]);
  });

  it('activity lines and the model line use v2 words, not the classic ones', () => {
    expect(activityText('adopted from session acme-web-lead')).toBe('joined from agent acme-web-lead');
    expect(activityText('team Acme mobile created')).toBe('crew Acme mobile created');
    expect(activityText('moved to team Acme web')).toBe('moved to crew Acme web');
    expect(activityText('joined from team Acme web')).toBe('joined from crew Acme web');
    expect(activityText('returned to the sessions list')).toBe('returned to the agents list');
    expect(activityText('over its daily budget — loops paused')).toBe('over its daily budget — routines paused');
    expect(activityText('started as a new member')).toBe('started as a new teammate');
    expect(activityText('new charter accepted (with your edits)')).toBe('new job description accepted (with your edits)');
    expect(activityText('charter proposal dismissed')).toBe('job description proposal dismissed');
    expect(activityText('handed off to Reviewer: moved to team charter for PROJ-123')).toBe('handed off to Reviewer: moved to team charter for PROJ-123');
    expect(v2ModelText('the session’s model')).toBe('the agent’s model');
    expect(v2ModelText('Sonnet 5.5 · high')).toBe('Sonnet 5.5 · high');
  });

  it('hand-off rows: open ones first, from you or a teammate', () => {
    const base = { teamId: 'team', expected: '', links: [], todoId: null, notifiedAt: null, planRef: null, updatedAt: '' };
    const handoffs: TeamHandoff[] = [
      { ...base, id: 'h1', fromMemberId: 'a', toMemberId: 'b', brief: 'Done one', state: 'done', createdAt: '2026-10-25T10:00:00.000Z' },
      { ...base, id: 'h2', fromMemberId: null, toMemberId: 'a', brief: 'Open one', state: 'open', createdAt: '2026-10-25T08:00:00.000Z' },
    ];
    expect(handoffRows(handoffs, [member('a'), member('b')]).map((row) => [row.id, row.from, row.to])).toEqual([
      ['h2', 'You', 'Role a'],
      ['h1', 'Role a', 'Role b'],
    ]);
  });
});

describe('openChatReason (Fix after 2.0, 2.4.5: the card opens the teammate’s chat)', () => {
  it('opens for a shown teammate, offline computer or not', () => {
    expect(openChatReason({ name: 'Reviewer' })).toBeNull();
    expect(openChatReason({ name: 'Reviewer', archived: false })).toBeNull();
  });
  it('is off for an archived teammate, with the restore reason', () => {
    expect(openChatReason({ name: 'Reviewer', archived: true })).toBe("Reviewer's session is archived: restore it first");
  });
});
