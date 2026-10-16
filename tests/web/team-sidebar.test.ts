import { describe, expect, it } from 'vitest';
import type { BackgroundTask, SessionActivity } from '../../src/core/api.ts';
import { pendingSubagentCount, waitingOnSubagents } from '../../src/core/derive/background.ts';
import { type TeamRosterEntry, memberStatus } from '../../src/core/team.ts';
import { cardWorkLine, subagentsWaitText } from '../../src/web/team/model.ts';
import { ROSTER_GLYPH, SUBAGENTS_GLYPH, collapsedSummary, hasDuration, itemLabel, rosterGlyph, rosterLine, rosterTitle, shortDuration } from '../../src/web/team/sidebar-roster.ts';

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

describe('waiting on subagents (2026-10-16)', () => {
  const task = (patch: Partial<BackgroundTask>): BackgroundTask => ({ id: 't', toolUseId: 'u', kind: 'agent', summary: 's', startedAt: ago(25 * MIN), github: false, ...patch });
  const background = (tasks: BackgroundTask[]): SessionActivity => ({
    turnStartedAt: tasks[0]?.startedAt ?? ago(0),
    state: 'background',
    since: tasks[0]?.startedAt ?? ago(0),
    tool: null,
    summary: null,
    thinkingTokens: null,
    agents: {},
    background: tasks,
  });

  it('counts async agents one each, a workflow by its agents not done (one while unknown); shells, monitors and wake-ups are no subagents', () => {
    expect(pendingSubagentCount([task({}), task({ id: 'w', kind: 'workflow' })])).toBe(2);
    expect(pendingSubagentCount([task({ kind: 'workflow', workflow: { runId: 'r', doneCount: 3, agentCount: 7, phase: null } })])).toBe(4);
    expect(pendingSubagentCount([task({ kind: 'bash' }), task({ kind: 'monitor' }), task({ kind: 'wakeup' }), task({ kind: 'task' })])).toBe(0);
  });

  it('is a background wait with a subagent pending only (a running turn is not a wait)', () => {
    expect(waitingOnSubagents(background([task({ startedAt: ago(10 * MIN) }), task({ id: 'b', kind: 'bash', startedAt: ago(40 * MIN) }), task({ id: 'c', startedAt: ago(25 * MIN) })]))).toEqual({ count: 2, since: ago(25 * MIN) });
    expect(waitingOnSubagents(background([task({ kind: 'bash' })]))).toBeNull();
    expect(waitingOnSubagents({ ...background([task({})]), state: 'thinking' })).toBeNull();
    expect(waitingOnSubagents(null)).toBeNull();
  });

  it('a member is working while its subagents work, even when its session reads done / idle (an older machine)', () => {
    expect(memberStatus({ reachable: true, sessionStatus: 'done', paused: false, subagents: 3 })).toBe('working');
    expect(memberStatus({ reachable: true, sessionStatus: 'idle', paused: false, subagents: 1 })).toBe('working');
    expect(memberStatus({ reachable: true, sessionStatus: 'done', paused: false, subagents: 0 })).toBe('idle');
    expect(memberStatus({ reachable: true, sessionStatus: 'done', paused: true, subagents: 2 })).toBe('paused');
    expect(memberStatus({ reachable: true, sessionStatus: 'need', paused: false, subagents: 2 })).toBe('needs-you');
    expect(memberStatus({ reachable: false, sessionStatus: 'run', paused: false, subagents: 2 })).toBe('offline');
  });

  it('the sidebar row: ◐, "3 subagents · 25m" (since the oldest started), "waiting on 3 subagents" in the tooltip', () => {
    const waiting = entry({ status: 'working', subagents: 3, turnStartedAt: ago(25 * MIN), current: { key: 'PROJ-14', title: 'x' } });
    expect(rosterLine(waiting, NOW)).toBe('3 subagents · 25m');
    expect(rosterLine(entry({ status: 'working', subagents: 1, turnStartedAt: ago(2 * MIN) }), NOW)).toBe('1 subagent · 2m');
    expect(rosterGlyph(waiting)).toBe(SUBAGENTS_GLYPH);
    expect(rosterGlyph(entry({ status: 'working' }))).toBe('●');
    expect(rosterTitle(waiting)).toBe('Builder · waiting on 3 subagents');
  });

  it('the Team card: "Waiting on 3 subagents" from the live activity, else from the member', () => {
    const text = () => 'activity words';
    const member = { status: 'working' as const, pausedBy: null, machineName: 'Studio' };
    expect(subagentsWaitText(1)).toBe('Waiting on 1 subagent');
    expect(cardWorkLine(member, background([task({}), task({ id: 'b' }), task({ id: 'c' })]), null, text)).toBe('Waiting on 3 subagents');
    expect(cardWorkLine({ ...member, subagents: 2 }, null, null, text)).toBe('Waiting on 2 subagents');
    // A turn runs (it reads as before), and idle members keep their idle line.
    expect(cardWorkLine({ ...member, subagents: 2 }, { ...background([task({})]), state: 'thinking' }, null, text)).toBe('activity words');
    expect(cardWorkLine({ ...member, status: 'idle' }, null, null, text)).toBe('Idle: waiting for a hand-off or its next loop');
  });
});
