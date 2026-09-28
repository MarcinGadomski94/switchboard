import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Solution, SolutionGroup, SystemInfo } from '../../src/core/api.ts';
import {
  WIZARD_STEPS,
  checkRows,
  nextLabel,
  notificationState,
  railItems,
  scanRows,
  stepPosition,
} from '../../src/web/modals/setup-wizard.ts';
import { REPO_ROOT } from '../helpers/net.ts';

/** The wizard's rules and copy (M5.3) against the prototype's `WZ`, `wzSteps`, `wzChecks`, `scan` and `notif`. */
const PROTOTYPE = path.join(REPO_ROOT, 'docs', 'handoff', 'prototype', 'Switchboard App.dc.html');

const INFO: SystemInfo = {
  cli: 'C:\\Users\\dev\\.local\\bin\\claude.exe',
  cliVersion: '2.1.283',
  signedIn: true,
  ghSignedIn: true,
  cpu: 38,
  ramUsed: 1,
  ramTotal: 2,
  processes: 9,
};

function solution(name: string, relativePath: string, rule: Solution['rule']): Solution {
  return {
    name,
    path: `/ws/${relativePath}`,
    relativePath,
    type: 'Web',
    status: 'idle',
    rule,
    phase: '',
    changes: '',
    flag: '',
    conflict: false,
    conflictSessions: [],
    branches: [],
    ledger: null,
    artifacts: [],
    codebaseMemory: 'unknown',
  };
}

describe('setup wizard model (M5.3)', () => {
  it('steps, titles and texts are the prototype’s WZ, verbatim, except step 2 (D14: “Add your first folder”)', async () => {
    const source = await readFile(PROTOTYPE, 'utf8');
    const match = /const WZ = (\[\[.*?\]\]);/.exec(source);
    expect(match).not.toBeNull();
    const wz = JSON.parse((match?.[1] ?? '[]').replace(/'/g, '"')) as string[][];
    const steps = WIZARD_STEPS.map((s) => [s.label, s.title, s.text]);
    expect(steps.filter((_, i) => i !== 1)).toEqual(wz.filter((_, i) => i !== 1));
    expect(wz[1]?.[0]).toBe('Workspace root');
    expect(steps[1]).toEqual([
      'Add your first folder',
      'Add your first folder',
      'A workspace (the folder that holds your router AGENTS.md) or a git repository. Each session picks its folder when it starts. You can skip this and add folders later in Settings → Folders.',
    ]);
    expect(stepPosition(0)).toBe('Step 1 of 5');
    expect(stepPosition(4)).toBe('Step 5 of 5');
    expect([0, 1, 2, 3, 4].map(nextLabel)).toEqual(['Continue', 'Continue', 'Continue', 'Continue', 'Finish']);
  });

  it('the rail: ✓ before the current step, its number from it on (prototype wzSteps)', () => {
    expect(railItems(0).map((r) => [r.mark, r.state])).toEqual([
      ['1', 'current'],
      ['2', 'todo'],
      ['3', 'todo'],
      ['4', 'todo'],
      ['5', 'todo'],
    ]);
    expect(railItems(2).map((r) => [r.mark, r.state])).toEqual([
      ['✓', 'done'],
      ['✓', 'done'],
      ['3', 'current'],
      ['4', 'todo'],
      ['5', 'todo'],
    ]);
  });

  it('step 1 rows: passing CLI and gh rows as in the prototype; failing rows say what failed', () => {
    expect(checkRows(INFO)).toEqual([
      { ok: true, label: 'Claude Code CLI found', detail: 'C:\\Users\\dev\\.local\\bin\\claude.exe' },
      { ok: true, label: 'Signed in', detail: 'claude auth status · the login stays with Claude Code' },
      { ok: true, label: 'GitHub CLI signed in', detail: 'gh auth status · used to detect merged PRs' },
    ]);
    expect(checkRows({ ...INFO, signedIn: false, ghSignedIn: false }).map((r) => [r.ok, r.label])).toEqual([
      [true, 'Claude Code CLI found'],
      [false, 'Not signed in'],
      [false, 'GitHub CLI not signed in'],
    ]);
    const missing = checkRows({ ...INFO, cli: null, cliVersion: null, signedIn: false });
    expect(missing[0]).toEqual({ ok: false, label: 'Claude Code CLI not found', detail: 'install Claude Code or set SWITCHBOARD_CLAUDE_BIN' });
    expect(missing[1]).toEqual({ ok: false, label: 'Not signed in', detail: 'claude auth status needs the CLI' });
  });

  it('scan rows: one per top folder, the read-only group split back, three names + “, …”, the strictest rule', () => {
    const groups: SolutionGroup[] = [
      {
        folder: 'microfrontends/',
        note: '',
        rule: 'editable',
        solutions: ['a-front', 'b-front', 'c-front', 'd-front'].map((n) => solution(n, `microfrontends/${n}`, 'editable')),
      },
      { folder: 'mobile/', note: '', rule: 'editable', solutions: [solution('mobile', 'mobile', 'editable')] },
      { folder: 'other/', note: 'on request only', rule: 'on-request', solutions: [solution('it-dashboard', 'other/it-dashboard', 'on-request')] },
      {
        folder: 'read-only',
        // As the scanner sends it: solutions sorted by name, the folders in the note in the router's order.
        note: 'deprecated/ · infrastructure/ · never edited',
        rule: 'read-only',
        solutions: [
          solution('infrastructure', 'infrastructure', 'read-only'),
          solution('mobile', 'deprecated/mobile', 'read-only'),
          solution('old-front', 'deprecated/microfrontends/old-front', 'read-only'),
        ],
      },
    ];
    expect(scanRows(groups)).toEqual([
      { folder: 'microfrontends/', count: 4, examples: 'a-front, b-front, c-front, …', rule: 'editable', restricted: false },
      { folder: 'mobile/', count: 1, examples: 'mobile', rule: 'editable', restricted: false },
      { folder: 'other/', count: 1, examples: 'it-dashboard', rule: 'on request only', restricted: true },
      { folder: 'deprecated/', count: 2, examples: 'mobile, old-front', rule: 'read-only', restricted: true },
      { folder: 'infrastructure/', count: 1, examples: 'infrastructure', rule: 'read-only', restricted: true },
    ]);
    expect(scanRows([])).toEqual([]);
  });

  it('notification permission copy and tone (prototype notif)', () => {
    expect(notificationState('granted')).toEqual({ text: '✓ allowed', tone: 'done' });
    expect(notificationState('denied')).toEqual({ text: '✕ blocked in browser settings', tone: 'fail' });
    expect(notificationState('default')).toEqual({ text: 'not asked yet', tone: 'muted' });
    expect(notificationState('unsupported')).toEqual({ text: 'not supported here', tone: 'muted' });
  });
});
