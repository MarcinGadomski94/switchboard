import { describe, expect, it } from 'vitest';
import type { SystemInfo } from '../../src/core/api.ts';
import type { Machine } from '../../src/core/peers.ts';
import { PLAN_ITEM_STATES } from '../../src/core/plans.ts';
import { SESSION_STATUSES } from '../../src/core/model.ts';
import { colorFor, initials } from '../../src/web/v2/components/avatar-model.ts';
import { ICON_NAMES } from '../../src/web/v2/components/icon-paths.ts';
import { placeBelow } from '../../src/web/v2/components/place.ts';
import {
  ANSWER,
  NEEDS_FILTER_OF,
  NEEDS_KINDS,
  NEEDS_KIND_LOOK,
  RAIL_LABELS,
  SERVER_ACTION_LABELS,
  STATUS,
  TERMS,
  V2_STATUSES,
  actionLabel,
  computerProblem,
  computerStateToV2,
  planItemStateToV2,
  sessionStatusToV2,
  teammateStatusToV2,
} from '../../src/web/v2/glossary.ts';
import { agentLine, agentStatusOf } from '../../src/web/v2/shared/agent-line.ts';
import { clock, elapsed, timeAgo } from '../../src/web/v2/shared/time.ts';
import { type KeyLike, shellKeyOf, shortcutList } from '../../src/web/v2/shell/shortcuts.ts';
import { formatBytes, railCounts, statusPill, usageTone } from '../../src/web/v2/shell/status-model.ts';

import { fromInbox } from '../../src/web/v2/shared/needs-you-model.ts';

describe('D131 · the glossary: one place for the v2 words', () => {
  it('uses the plain names the brief and the prototype chose', () => {
    expect(TERMS.agent.one).toBe('Agent');
    expect(TERMS.helper.one).toBe('Helper');
    expect(TERMS.task.one).toBe('Task');
    expect(TERMS.project.one).toBe('Project');
    expect(TERMS.crew.many).toBe('Crews');
    expect(TERMS.teammate.one).toBe('Teammate');
    expect(TERMS.result.many).toBe('Results');
    expect(TERMS.notes.many).toBe('Notes');
    expect(TERMS.routine.one).toBe('Routine');
    expect(TERMS.codeProject.one).toBe('Code project');
    expect(TERMS.changeRequest.one).toBe('Change request');
    expect(TERMS.automaticTests.one).toBe('Automatic tests');
    expect(TERMS.computer.one).toBe('Computer');
    expect(TERMS.phone.one).toBe('Phone');
    expect(TERMS.backgroundApp.many).toBe('Background apps');
    expect(TERMS.aiEngine.one).toBe('AI engine');
    expect(TERMS.connections.many).toBe('Connections');
    expect(Object.values(RAIL_LABELS)).toEqual(['Home', 'Agents', 'Projects', 'Crews', 'Results', 'Tasks', 'Settings']);
    expect(actionLabel('plan-merge', 'Merge')).toBe('Combine');
    expect(actionLabel('open-session', 'Open session')).toBe('Open chat');
    expect(actionLabel('something-new', 'Something new')).toBe('Something new');
    expect(SERVER_ACTION_LABELS['retry-run']).toBe('Try again');
    expect(ANSWER.chosen(2)).toBe('2 chosen · kept as a draft');
  });

  it('every status has an icon, a word and a colour (never colour alone), and every icon exists', () => {
    for (const status of V2_STATUSES) {
      const look = STATUS[status];
      expect(look.label.length, status).toBeGreaterThan(0);
      expect(look.tone, status).toBeTruthy();
      expect(look.icon === 'pulse' || ICON_NAMES.includes(look.icon as never), `${status}: ${look.icon}`).toBe(true);
    }
    for (const kind of NEEDS_KINDS) {
      expect(ICON_NAMES.includes(NEEDS_KIND_LOOK[kind].icon as never), kind).toBe(true);
      expect(NEEDS_FILTER_OF[kind], kind).toBeTruthy();
    }
  });

  it('maps every server status code to a v2 status', () => {
    expect(SESSION_STATUSES.map(sessionStatusToV2)).toEqual(['needs', 'working', 'done', 'stopped', 'idle', 'paused']);
    const plan = Object.fromEntries(PLAN_ITEM_STATES.map((state) => [state, planItemStateToV2(state)]));
    expect(plan).toEqual({ waiting: 'queued', ready: 'queued', running: 'working', question: 'needs', stopped: 'stopped', 'needs-you': 'needs', 'ready-to-merge': 'ready', 'to-confirm': 'ready', done: 'done', blocked: 'stopped' });
    expect((['working', 'needs-you', 'idle', 'paused', 'offline'] as const).map(teammateStatusToV2)).toEqual(['working', 'needs', 'idle', 'paused', 'offline']);
    expect((['online', 'reconnecting', 'offline', 'auth-failed', 'no-address', null] as const).map(computerStateToV2)).toEqual(['online', 'reconnecting', 'offline', 'offline', 'offline', 'online']);
    expect(computerProblem('auth-failed')).toMatch(/Pair it again/);
    expect(computerProblem('online')).toBeNull();
  });
});

describe('D131 · component helpers', () => {
  it('avatars: two initials and a stable colour per name', () => {
    expect(initials('Mobile banner PROJ-140')).toBe('MB');
    expect(initials('Planner')).toBe('PL');
    expect(initials('  ')).toBe('?');
    expect(colorFor('Acme')).toBe(colorFor('Acme'));
    expect(colorFor('Acme')).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('a floating box stays inside the window, flipping above its anchor when needed', () => {
    const viewport = { width: 1000, height: 800 };
    expect(placeBelow({ top: 10, bottom: 50, left: 900, right: 980 }, { width: 400, height: 300 }, viewport, 'end')).toEqual({ top: 56, left: 580 });
    expect(placeBelow({ top: 10, bottom: 50, left: 900, right: 980 }, { width: 400, height: 300 }, viewport, 'start')).toEqual({ top: 56, left: 592 });
    expect(placeBelow({ top: 700, bottom: 740, left: 10, right: 50 }, { width: 200, height: 300 }, viewport)).toEqual({ top: 394, left: 10 });
  });
});

describe('D131 · the shell: status pill, rail counts, shortcuts', () => {
  const machine = (id: string, name: string, state: Machine['state'], extra: Partial<Machine> = {}): Machine => ({ id, name, address: null, state, lastError: null, lastSeenAt: '2026-10-25T09:12:00.000Z', pairedAt: '2026-10-01T00:00:00.000Z', ...extra });

  it('the pill: the active account’s usage, this computer’s power, the computers; the popover rows', () => {
    const system = {
      cli: 'claude',
      cliVersion: '2',
      signedIn: true,
      ghSignedIn: true,
      cpu: 34,
      ramUsed: 18.2 * 1024 ** 3,
      ramTotal: 32 * 1024 ** 3,
      processes: 2,
      power: { kind: 'battery', percent: 64, minutesLeft: 130, at: '2026-10-25T12:00:00.000Z' },
      trackedProcesses: { count: 3, rssBytes: 1.9 * 1024 ** 3 },
      accountUsage: [
        { cli: 'claude', profileId: 'work', name: 'Work', active: true, pct: 72, exhaustedUntil: null, windows: [{ key: 'session', label: '5h', pct: 72, resetsAt: null }, { key: 'week', label: 'Week', pct: 48, resetsAt: null }] },
        { cli: 'claude', profileId: 'personal', name: 'Personal', active: false, pct: 100, exhaustedUntil: '2099-01-01T14:05:00.000Z', windows: [] },
      ],
    } as unknown as SystemInfo;
    const pill = statusPill(system, [machine('studio', 'Studio-PC', 'online', { power: { kind: 'estimated', watts: 210, at: '2026-10-25T12:00:00.000Z' } })], 'Acme-MacBook', Date.parse('2026-10-25T12:00:00.000Z'));
    expect(pill.usage).toMatchObject({ label: 'Work 72%', pct: 72, tone: 'green' });
    expect(pill.power?.text).toContain('64%');
    expect(pill.computers).toMatchObject({ text: '2 online' });
    expect(pill.backgroundApps).toBe('3 background apps · 1.9 GB');
    expect(pill.accounts.map((a) => [a.name, a.badge?.text ?? null, a.session, a.week])).toEqual([
      ['Work', 'In use', 72, 48],
      ['Personal', 'Out until ' + pill.accounts[1]?.badge?.text.slice('Out until '.length), null, null],
    ]);
    expect(pill.computerRows.map((row) => [row.name, row.self, row.state])).toEqual([
      ['Acme-MacBook', true, 'online'],
      ['Studio-PC', false, 'online'],
    ]);
    expect(pill.computerRows[0]?.detail).toBe('CPU 34% · RAM 18.2/32 GB · 3 background apps · 1.9 GB');
    expect(pill.computerRows[1]?.power).toContain('210 W');
    expect(pill.away).toEqual([]);
    const offline = statusPill(system, [machine('studio', 'Studio-PC', 'offline')], 'Acme-MacBook');
    expect(offline.computers).toMatchObject({ text: '1 offline', icon: 'offline' });
    expect(offline.away[0]).toMatchObject({ name: 'Studio-PC', state: 'offline' });
    expect(offline.away[0]?.detail).toMatch(/^Offline since \d\d:\d\d · Reconnects automatically\.$/);
    expect(statusPill(system, [machine('studio', 'Studio-PC', 'reconnecting')], 'A').computers).toMatchObject({ text: 'Reconnecting', tone: 'amber' });
    expect(statusPill(null, [], 'A')).toMatchObject({ usage: null, power: null, backgroundApps: null });
    expect(usageTone(95, false)).toBe('amber');
    expect(usageTone(10, true)).toBe('red');
    expect(formatBytes(412 * 1024 ** 2)).toBe('412 MB');
  });

  it('rail counts: Home all, Agents the agents’, Projects the steps’, Crews the teammates’', () => {
    const items = [
      fromInbox({ id: 'a', kind: 'questions', sessionId: 's1', source: 's', status: 'need', title: '', label: '', detail: '', createdAt: 'x', branches: [], questions: [] }),
      fromInbox({ id: 'b', kind: 'system', sessionId: 's2', source: 's', status: 'need', title: '', label: 'Ready to merge', detail: '', createdAt: 'x', branches: [], route: '/plans/p', actions: [{ id: 'plan-merge', label: 'Merge' }] }),
      { ...fromInbox({ id: 'c', kind: 'permission', sessionId: 's3', source: 's', status: 'need', title: '', label: '', detail: '', createdAt: 'x', branches: [] }), crew: { id: 't', name: 'Acme Core', teammate: 'Developer', memberId: 'm' } },
      fromInbox({ id: 'd', kind: 'system', sessionId: null, source: 'update', status: 'need', title: '', label: 'Update available', detail: '', createdAt: 'x', branches: [] }),
    ];
    expect(railCounts(items)).toEqual({ home: 4, agents: 1, projects: 1, crews: 1 });
    // Fix after 2.0: a teammate's untagged item counts for Crews, not Agents.
    expect(railCounts(items, new Set(['s1']))).toEqual({ home: 4, agents: 0, projects: 1, crews: 2 });
  });

  it('shortcuts: ⌘K, ⌘⇧F, ⌘., ⌘\\ and ? (not while typing)', () => {
    const mod = /Mac|iPhone|iPad|iPod/.test(globalThis.navigator?.platform ?? '') ? { metaKey: true, ctrlKey: false } : { metaKey: false, ctrlKey: true };
    const key = (k: string, extra: Partial<KeyLike> = {}) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...extra });
    expect(shellKeyOf(key('k', mod), false)).toBe('palette');
    expect(shellKeyOf(key('k', mod), true)).toBe('palette');
    expect(shellKeyOf(key('F', { ...mod, shiftKey: true }), true)).toBe('search');
    expect(shellKeyOf(key('.', mod), false)).toBe('side-panel');
    expect(shellKeyOf(key('\\', mod), false)).toBe('folder-tree');
    expect(shellKeyOf(key('?', { shiftKey: true }), false)).toBe('shortcuts');
    expect(shellKeyOf(key('?', { shiftKey: true }), true)).toBeNull();
    expect(shellKeyOf(key('k'), false)).toBeNull();
    expect(shortcutList().map((line) => line.what)).toEqual([
      'Command palette and quick search',
      'Search everything, every computer',
      'Hide or show the agent’s details panel',
      'Hide or show the folder tree in Agents',
      'Stop the agent you’re looking at',
      'Send',
      'Answer the focused question card',
      'Move the focused agent to a folder or crew',
      'This list',
    ]);
  });

  it('agent rows: the status and the activity line', () => {
    const session = { status: 'run' as const, lastActivityAt: '2026-10-25T11:35:00.000Z', turnWait: null };
    expect(agentStatusOf(session)).toBe('working');
    expect(agentStatusOf(session, { ask: 'Which quarter?' })).toBe('needs');
    expect(agentStatusOf({ ...session, status: 'done' }, { askStatus: 'ready' })).toBe('ready');
    const now = Date.parse('2026-10-25T12:00:00.000Z');
    expect(agentLine({ ...session, status: 'done' }, null, {}, now)).toEqual({ text: 'Done 25 min ago', time: '', tone: 'green' });
    expect(agentLine(session, null, { ask: 'Which quarter?' }, now)).toEqual({ text: '“Which quarter?”', time: '', tone: 'amber' });
    expect(agentLine({ ...session, status: 'need', turnWait: { status: 'waiting_for_you', ask: 'Approve?', source: 'declared', at: 'x' } } as never, null, {}, now).text).toBe('“Approve?”');
    expect(agentLine({ ...session, status: 'fail' }, null, {}, now)).toMatchObject({ text: 'Stopped', tone: 'red' });
  });

  it('times in v2 words', () => {
    const now = Date.parse('2026-10-25T12:00:00.000Z');
    expect(timeAgo('2026-10-25T11:59:40.000Z', now)).toBe('just now');
    expect(timeAgo('2026-10-25T11:56:00.000Z', now)).toBe('4 min ago');
    expect(timeAgo('2026-10-25T09:00:00.000Z', now)).toBe('3h ago');
    expect(timeAgo('2026-10-22T12:00:00.000Z', now)).toBe('3d ago');
    expect(timeAgo(null, now)).toBe('');
    expect(clock('not a date')).toBe('');
    expect(elapsed(42_000)).toBe('0:42');
    expect(elapsed(3_723_000)).toBe('1:02:03');
  });
});
