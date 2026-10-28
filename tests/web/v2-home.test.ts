import { describe, expect, it } from 'vitest';
import type { ArtifactListItem, InboxItem, SessionActivity, SessionListItem } from '../../src/core/api.ts';
import type { SessionPr } from '../../src/core/ci.ts';
import { followUpOf } from '../../src/web/v2/shared/answer-model.ts';
import type { NeedsItem } from '../../src/web/v2/shared/needs-you-model.ts';
import {
  DONE_LIMIT,
  canStartFrom,
  dateLine,
  doneToday,
  greeting,
  helpersOf,
  isToday,
  needsSummary,
  readStartPrefs,
  startBody,
  startFolder,
  testsLine,
  topNeeds,
  workSummary,
  workingNow,
} from '../../src/web/v2/home/home-model.ts';
import { applyFilter, crewChips, isPageFilter, kindCounts, matchesFilter, stepIndex } from '../../src/web/v2/needs-you/needs-filter.ts';

/**
 * D131 · lane H: Home's section selection and sorting (Working now, Done today,
 * the top of Needs you), the start box's folder / model / body, and the Needs-you
 * page's filters (`src/web/v2/home/home-model.ts`, `src/web/v2/needs-you/needs-filter.ts`).
 */

// Local noon on 25 October 2026: "today" is that local day, whatever the time zone.
const NOW = new Date(2026, 9, 25, 12, 0, 0).getTime();
const at = (hours: number, minutes = 0, day = 25): string => new Date(2026, 9, day, hours, minutes).toISOString();

function session(id: string, extra: Partial<SessionListItem> = {}): SessionListItem {
  return { id, name: id, title: null, status: 'idle', createdAt: at(8), lastActivityAt: at(9), kind: 'session', closedAt: null, activity: null, ...extra } as unknown as SessionListItem;
}

function item(key: string, extra: Partial<NeedsItem> = {}): NeedsItem {
  return { key, id: key, source: 'inbox', kind: 'question', title: key, text: '', createdAt: at(10), agent: null, crew: null, computer: null, actions: [], ...extra };
}

function artifact(id: string, updatedAt: string, extra: Partial<ArtifactListItem> = {}): ArtifactListItem {
  return { id, sessionId: 's1', title: `${id}.md`, kind: 'markdown', language: null, versions: 1, size: 10, createdAt: updatedAt, updatedAt, sessionName: 's1', sessionTitle: 'Docs cleanup', folder: null, folderPath: null, ...extra } as unknown as ArtifactListItem;
}

describe('Home · Working now', () => {
  it('lists the running agents on every computer, newest activity first; not conversations, closed or idle ones', () => {
    const list = [
      session('older', { status: 'run', lastActivityAt: at(9) }),
      session('idle', { status: 'idle', lastActivityAt: at(11) }),
      session('chat', { status: 'run', kind: 'chat', lastActivityAt: at(11, 30) }),
      session('closed', { status: 'run', closedAt: at(11), lastActivityAt: at(11, 40) }),
      session('peer', { status: 'run', lastActivityAt: at(11, 50), machine: { id: 'studio', name: 'Studio-PC', state: 'offline' } }),
      session('newest', { status: 'run', lastActivityAt: null, createdAt: at(11, 55) }),
    ];
    expect(workingNow(list).map((s) => s.id)).toEqual(['newest', 'peer', 'older']);
  });

  it('counts the helpers working now (the live agents besides the main one)', () => {
    const agent = { state: 'tool', since: at(10), startedAt: at(10), tool: 'Bash', summary: 'npm test' } as const;
    const activity = { agents: { main: agent, a1: agent, a2: agent } } as unknown as SessionActivity;
    expect(helpersOf(activity)).toBe(2);
    expect(helpersOf({ agents: { main: agent } } as unknown as SessionActivity)).toBe(0);
    expect(helpersOf(null)).toBe(0);
  });
});

describe('Home · Done today', () => {
  it('finished agents and results of today, newest first, with the agent’s Ready-for-approval item', () => {
    const ready = item('inbox:r1', { kind: 'ready', agent: { sessionId: 'waits', name: 'Waits' } });
    const rows = doneToday(
      [
        session('done-today', { status: 'done', lastActivityAt: at(11) }),
        session('done-yesterday', { status: 'done', lastActivityAt: at(23, 0, 24) }),
        session('closed-done', { status: 'done', lastActivityAt: at(10), closedAt: at(10) }),
        session('working', { status: 'run', lastActivityAt: at(11, 30) }),
        session('waits', { status: 'idle', lastActivityAt: at(9) }),
        session('chat-done', { status: 'done', kind: 'chat', lastActivityAt: at(11, 45) }),
      ],
      [artifact('notes', at(11, 15)), artifact('old', at(10, 0, 20))],
      [ready, item('inbox:q1', { agent: { sessionId: 'done-today', name: 'x' } })],
      NOW,
    );
    expect(rows.map((row) => row.key)).toEqual(['result::notes', 'agent:done-today', 'agent:closed-done', 'agent:waits']);
    const waits = rows.find((row) => row.key === 'agent:waits');
    expect(waits?.type === 'agent' ? waits.ready?.key : null).toBe('inbox:r1');
    const doneRow = rows.find((row) => row.key === 'agent:done-today');
    expect(doneRow?.type === 'agent' ? doneRow.ready : 'x').toBeNull();
  });

  it('“today” is the local day', () => {
    expect(isToday(at(0, 1), NOW)).toBe(true);
    expect(isToday(at(23, 59, 24), NOW)).toBe(false);
    expect(isToday(null, NOW)).toBe(false);
    expect(DONE_LIMIT).toBe(5);
  });

  it('says what the change request’s automatic tests did', () => {
    const pr = (extra: Partial<SessionPr>): SessionPr => ({ worktreeId: 'w', repo: 'acme', branch: 'b', number: 42, url: null, state: 'OPEN', checks: 'green', summary: null, review: 'APPROVED', ready: true, attempts: 0, maxAttempts: 3, stopped: null, checkedAt: null, ...extra }) as SessionPr;
    expect(testsLine([pr({})])).toEqual({ text: 'Change request #42 · automatic tests passed', tone: 'green' });
    expect(testsLine([pr({ checks: 'red' })])?.text).toBe('Change request #42 · automatic tests failed');
    expect(testsLine([pr({ checks: 'pending' })])?.text).toBe('Change request #42 · automatic tests running');
    expect(testsLine([pr({ state: 'MERGED' })])?.text).toBe('Change request #42 · combined');
    expect(testsLine([])).toBeNull();
    expect(testsLine(undefined)).toBeNull();
  });
});

describe('Home · Needs you and the header', () => {
  it('shows the first N of the queue and says when there are more', () => {
    const items = ['a', 'b', 'c', 'd'].map((k) => item(k));
    expect(topNeeds(items, 3)).toMatchObject({ total: 4, more: true });
    expect(topNeeds(items, 3).shown.map((i) => i.key)).toEqual(['a', 'b', 'c']);
    expect(topNeeds(items.slice(0, 3), 3)).toMatchObject({ total: 3, more: false });
    expect(topNeeds([], 3)).toMatchObject({ shown: [], total: 0, more: false });
  });

  it('greets by the hour and sums up', () => {
    expect(greeting(new Date(2026, 9, 25, 8).getTime())).toBe('Good morning');
    expect(greeting(NOW)).toBe('Good afternoon');
    expect(greeting(new Date(2026, 9, 25, 21).getTime())).toBe('Good evening');
    expect(greeting(new Date(2026, 9, 25, 3).getTime())).toBe('Good evening');
    expect(dateLine(NOW, 'en-GB')).toBe('Sunday 25 October');
    expect(needsSummary(0)).toBe('Nothing needs you');
    expect(needsSummary(1)).toBe('1 thing needs you');
    expect(needsSummary(7)).toBe('7 things need you');
    expect(workSummary(2, 3)).toBe('2 working · 3 done today');
  });
});

describe('Home · the start box', () => {
  const folders = [
    { id: 'f-default', isDefault: true, lastUsedAt: null },
    { id: 'f-old', isDefault: false, lastUsedAt: at(8) },
    { id: 'f-last', isDefault: false, lastUsedAt: at(11) },
  ];

  it('opens on the folder this browser last started in, else the one last used, else the default', () => {
    expect(startFolder(folders, 'f-old')).toBe('f-old');
    expect(startFolder(folders, 'gone')).toBe('f-last');
    expect(startFolder(folders, null)).toBe('f-last');
    expect(startFolder([{ id: 'a', isDefault: false, lastUsedAt: null }, { id: 'b', isDefault: true, lastUsedAt: null }], null)).toBe('b');
    expect(startFolder([], null)).toBeNull();
  });

  it('reads the remembered prefs (this computer by default; a Smart / Fast stored before 2.4.7 is ignored)', () => {
    expect(readStartPrefs(null)).toEqual({ folders: {}, machine: null });
    expect(readStartPrefs('not json')).toEqual({ folders: {}, machine: null });
    expect(readStartPrefs(JSON.stringify({ folders: { local: 'f1', bad: 3 }, speed: 'fast', machine: 'studio' }))).toEqual({ folders: { local: 'f1' }, machine: 'studio' });
  });

  it('sends the simple start body: the text as the task and title, a free name, the folder and the model', () => {
    const body = startBody('  Fix the login timeout on the checkout page  ', 'f1', { model: 'opus', effort: 'high' }, ['fix-the-login-timeout-on-the-checkout-page']);
    expect(body).toMatchObject({ simple: true, task: 'Fix the login timeout on the checkout page', folder: 'f1', worktrees: false, title: 'Fix the login timeout on the checkout page', model: 'opus', effort: 'high' });
    expect(startBody('Hi', null, { model: null, effort: null }, [])).toMatchObject({ model: null, effort: null });
    expect(body.name).not.toBe('fix-the-login-timeout-on-the-checkout-page');
    expect(startBody('Hi', null, null, [])).not.toHaveProperty('model');
    expect(startBody('Hi', null, null, [])).not.toHaveProperty('folder');
    expect(canStartFrom('  ')).toBe(false);
    expect(canStartFrom('go')).toBe(true);
  });
});

describe('Needs you · filters', () => {
  const crew = (id: string | null, name: string) => ({ id, name, teammate: 'Reviewer', memberId: 'm1' });
  const items = [
    item('q', { kind: 'question' }),
    item('m', { kind: 'multi' }),
    item('a', { kind: 'approval', crew: crew('t-core', 'Acme Core') }),
    item('r', { kind: 'ready' }),
    item('n', { kind: 'note' }),
    item('j', { kind: 'jd', crew: crew('t-mob', 'Acme Mobile') }),
    item('k', { kind: 'ask', crew: crew('t-core', 'Acme Core') }),
    item('s', { kind: 'stopped' }),
    item('al', { kind: 'alert' }),
    item('ro', { kind: 'routine' }),
    item('p', { kind: 'pick' }),
    item('ac', { kind: 'access', crew: crew('t-mob', 'Acme Mobile') }),
  ];

  it('groups every kind under one chip and counts them', () => {
    expect(kindCounts(items)).toEqual({ all: 12, question: 2, approval: 1, ready: 1, setup: 4, ask: 1, stopped: 3 });
    expect(applyFilter(items, 'question').map((i) => i.key)).toEqual(['q', 'm']);
    expect(applyFilter(items, 'setup').map((i) => i.key)).toEqual(['n', 'j', 'p', 'ac']);
    expect(applyFilter(items, 'stopped').map((i) => i.key)).toEqual(['s', 'al', 'ro']);
    expect(applyFilter(items, 'all')).toHaveLength(12);
  });

  it('one chip per crew, by name; a crew filter shows only its items; the chosen crew’s chip stays at 0', () => {
    expect(crewChips(items)).toEqual([
      { filter: 'crew:t-core', label: 'Acme Core', count: 2 },
      { filter: 'crew:t-mob', label: 'Acme Mobile', count: 2 },
    ]);
    expect(applyFilter(items, 'crew:t-mob').map((i) => i.key)).toEqual(['j', 'ac']);
    expect(matchesFilter(item('x'), 'crew:t-core')).toBe(false);
    expect(crewChips([], 'crew:t-core')).toEqual([{ filter: 'crew:t-core', label: 't-core', count: 0 }]);
    // A crew tag without an id (an Inbox item's team role) goes by its name.
    expect(crewChips([item('y', { crew: crew(null, 'Acme Web') })])).toEqual([{ filter: 'crew:Acme Web', label: 'Acme Web', count: 1 }]);
  });

  it('takes a known filter from the address, and steps between cards with wrap-around', () => {
    expect(isPageFilter('question')).toBe(true);
    expect(isPageFilter('crew:t-core')).toBe(true);
    expect(isPageFilter('crew:')).toBe(false);
    expect(isPageFilter('bogus')).toBe(false);
    expect(isPageFilter(null)).toBe(false);
    expect(stepIndex(-1, 1, 3)).toBe(0);
    expect(stepIndex(-1, -1, 3)).toBe(2);
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });
});

describe('AnswerCard · follow-ups (lane H)', () => {
  const system = (extra: Partial<InboxItem>): InboxItem => ({ id: 'i1', kind: 'system', sessionId: null, source: 'x', status: 'need', title: 't', label: 'l', detail: '', createdAt: at(10), branches: [], ...extra }) as InboxItem;

  it('“Fix it in a new agent” opens + New with the fix prefill; this computer’s “What’s new” goes to the updates', () => {
    const fix = item('inbox:f', { inbox: system({ prefill: { task: 'Fix the nightly check' } as never }), computer: { id: 'studio', name: 'Studio-PC', state: 'online' } });
    expect(followUpOf(fix, { type: 'server', actionId: 'open-fix-session' })).toEqual({ type: 'new-agent', prefill: { task: 'Fix the nightly check' }, machine: 'studio' });
    const update = item('inbox:u', { inbox: system({}) });
    expect(followUpOf(update, { type: 'server', actionId: 'whats-new' })).toEqual({ type: 'path', path: '/settings/updates' });
    expect(followUpOf({ ...update, computer: { id: 'studio', name: 'Studio-PC', state: 'online' } }, { type: 'server', actionId: 'whats-new' })).toBeNull();
    expect(followUpOf(update, { type: 'server', actionId: 'dismiss' })).toBeNull();
    expect(followUpOf(update, { type: 'not-waiting' })).toBeNull();
  });
});
