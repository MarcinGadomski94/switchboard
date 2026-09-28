import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Solution, SolutionGroup } from '../../src/core/api.ts';
import { cronLabel } from '../../src/core/cron-label.ts';
import { loadDemoData } from '../../src/server/demo/data.ts';
import {
  accountValue,
  cliRow,
  ghValue,
  notificationState,
  pollValue,
  repoCount,
  resolveSection,
  scanRows,
  scheduleColor,
  warnAtOptions,
} from '../../src/web/views/settings/model.ts';

const ROOT = path.join(path.sep, 'ws', 'work space');

function solution(name: string, relative: string, rule: Solution['rule'], type = 'Web'): Solution {
  return {
    name,
    path: path.join(ROOT, ...relative.split('/')),
    type,
    status: 'idle',
    rule,
    phase: '—',
    changes: '—',
    flag: '',
    conflict: false,
    branches: [],
  };
}

/** GET /api/solutions as the M6.1 scanner answers it (docs/solutions.md on lane/w1-solutions). */
const GROUPS: SolutionGroup[] = [
  {
    folder: 'microfrontends/',
    note: '',
    rule: 'editable',
    solutions: ['auth-front', 'learning-material-front', 'acme-app-front', 'workspace-front'].map((n) => solution(n, `microfrontends/${n}`, 'editable')),
  },
  { folder: 'mobile/', note: '', rule: 'editable', solutions: [solution('mobile', 'mobile', 'editable', 'Mobile')] },
  { folder: 'other/', note: 'on request only', rule: 'on-request', solutions: [solution('it-dashboard', 'other/it-dashboard', 'on-request', 'Other')] },
  {
    folder: 'read-only',
    note: 'deprecated/ · infrastructure/ · never edited',
    rule: 'read-only',
    solutions: [
      solution('infrastructure', 'infrastructure', 'read-only', 'Read-only'),
      solution('legacy-auth-microservice', 'deprecated/microservices/legacy-auth-microservice', 'read-only', 'Read-only'),
      solution('old-chat-front', 'deprecated/microfrontends/old-chat-front', 'read-only', 'Read-only'),
    ],
  },
];

describe('Settings model (M8.2)', () => {
  it('resolves the section of /settings[/:section]: Claude Code by default', () => {
    expect(resolveSection(null)).toBe('claude');
    expect(resolveSection('tools')).toBe('tools');
    expect(resolveSection('github')).toBe('github');
    expect(resolveSection('nope')).toBe('claude');
  });

  it('builds the scan table per top-level folder, splitting the read-only group back into its folders', () => {
    expect(scanRows(GROUPS, ROOT)).toEqual([
      { folder: 'microfrontends/', count: 4, examples: 'auth-front, learning-material-front, acme-app-front, …', rule: 'editable', ruleLabel: 'editable' },
      { folder: 'mobile/', count: 1, examples: 'mobile', rule: 'editable', ruleLabel: 'editable' },
      { folder: 'other/', count: 1, examples: 'it-dashboard', rule: 'on-request', ruleLabel: 'on request only' },
      { folder: 'deprecated/', count: 2, examples: 'legacy-auth-microservice, old-chat-front', rule: 'read-only', ruleLabel: 'read-only' },
      { folder: 'infrastructure/', count: 1, examples: 'infrastructure', rule: 'read-only', ruleLabel: 'read-only' },
    ]);
  });

  it('falls back to the group folder without a root or for paths outside it (Windows separators too)', () => {
    expect(scanRows(GROUPS, null).map((r) => [r.folder, r.count])).toEqual([
      ['microfrontends/', 4],
      ['mobile/', 1],
      ['other/', 1],
      ['read-only', 3],
    ]);
    const win: SolutionGroup[] = [
      { folder: 'nugets/', note: '', rule: 'editable', solutions: [{ ...solution('a-nuget', 'x', 'editable'), path: 'D:\\ws\\nugets\\a-nuget' }] },
    ];
    expect(scanRows(win, 'D:\\ws')[0]).toMatchObject({ folder: 'nugets/', count: 1 });
    expect(scanRows(win, 'D:\\other')[0]).toMatchObject({ folder: 'nugets/' });
    expect(scanRows([], ROOT)).toEqual([]);
  });

  it('never invents system values: unknown until /api/system answers', () => {
    expect(cliRow(null)).toEqual({ description: '—', value: 'unknown' });
    expect(accountValue(null)).toBe('unknown');
    expect(ghValue(null)).toBe('unknown');
    const system = { cli: '/usr/local/bin/claude', cliVersion: '2.1.283', signedIn: true, ghSignedIn: false, cpu: 1, ramUsed: 1, ramTotal: 2, processes: 0 };
    expect(cliRow(system)).toEqual({ description: '/usr/local/bin/claude', value: 'detected' });
    expect(cliRow({ ...system, cli: null })).toEqual({ description: '—', value: 'not found' });
    expect(accountValue(system)).toBe('signed in');
    expect(accountValue({ ...system, signedIn: false })).toBe('not signed in');
    expect(ghValue(system)).toBe('not signed in');
    expect(ghValue({ ...system, ghSignedIn: true })).toBe('✓ signed in');
  });

  it('counts repositories and formats the PR poll interval', () => {
    expect(repoCount(null)).toBe('unknown');
    expect(repoCount(GROUPS)).toBe('9 repos');
    expect(repoCount([GROUPS[1]!])).toBe('1 repo');
    expect(pollValue(5)).toBe('every 5 min');
    expect(pollValue(0)).toBe('unknown');
  });

  it('colors schedule dots like the prototype: paused idle, else the last run', () => {
    expect(scheduleColor({ paused: true, runs: [{ ts: '', result: 'fail', summary: null }] })).toBe('var(--status-idle)');
    expect(scheduleColor({ paused: false, runs: [{ ts: '', result: 'ok', summary: null }, { ts: '', result: 'fail', summary: null }] })).toBe('var(--status-fail)');
    expect(scheduleColor({ paused: false, runs: [{ ts: '', result: 'need', summary: null }] })).toBe('var(--status-need)');
    expect(scheduleColor({ paused: false, runs: [{ ts: '', result: 'running', summary: null }] })).toBe('var(--status-run)');
    expect(scheduleColor({ paused: false, runs: [{ ts: '', result: 'ok', summary: null }] })).toBe('var(--status-done)');
    expect(scheduleColor({ paused: false, runs: [] })).toBe('var(--status-idle)');
  });

  it('maps the notification permission to the prototype copy', () => {
    expect(notificationState('granted').text).toBe('✓ allowed');
    expect(notificationState('denied').text).toBe('✕ blocked in browser settings');
    expect(notificationState('default').text).toBe('not asked yet');
    expect(notificationState('unsupported').text).toBe('not supported here');
  });

  it('offers thresholds every 5% from 50%, plus a stored odd value', () => {
    expect(warnAtOptions(90)).toEqual([50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100]);
    expect(warnAtOptions(33)[0]).toBe(33);
    expect(warnAtOptions(92)).toContain(92);
  });
});

describe('cronLabel (M8.2)', () => {
  it("reads the prototype's four schedules as the prototype labels them", async () => {
    const { schedules } = await loadDemoData();
    expect(schedules.map((s) => cronLabel(s.cron))).toEqual(schedules.map((s) => s.cronLabel));
    expect(schedules.map((s) => s.cronLabel)).toEqual(['02:00 daily', 'every 4h', '08:30 weekdays', 'Mon 07:00']);
  });

  it('leaves every other expression as written', () => {
    expect(cronLabel('*/15 * * * *')).toBe('*/15 * * * *');
    expect(cronLabel('0 2 1 * *')).toBe('0 2 1 * *');
    expect(cronLabel('0 2 * * 1,3')).toBe('0 2 * * 1,3');
    expect(cronLabel('0 25 * * *')).toBe('0 25 * * *');
    expect(cronLabel('@daily')).toBe('@daily');
    expect(cronLabel(' 5 9 * * 0 ')).toBe('Sun 09:05');
    expect(cronLabel('0 9 * * 7')).toBe('Sun 09:00');
  });
});
