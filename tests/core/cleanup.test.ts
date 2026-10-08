import { describe, expect, it } from 'vitest';
import {
  type CleanupItem,
  ageText,
  closedSessionDaysOf,
  defaultSelection,
  hasSwitchboardBranchName,
  inRunOrder,
  missingConfirmations,
  neededConfirmations,
  parseClosedSessionDays,
  parseRunRequest,
  runRequestOf,
} from '../../src/core/cleanup.ts';

function item(id: string, group: CleanupItem['group'], confirm: CleanupItem['confirm'] = null, selected = confirm === null): CleanupItem {
  return { id, group, title: id, subtitle: '', reasons: [], sizeBytes: null, sizeCapped: false, lastChangeAt: null, removes: [id], keeps: [], warnings: [], confirm, selected, fingerprint: `f-${id}` };
}

describe('D84 · clean-up rules (core)', () => {
  it('Switchboard naming is session/… and todo/… with a name after the prefix', () => {
    expect(['session/a', 'todo/fix-1'].map(hasSwitchboardBranchName)).toEqual([true, true]);
    expect(['session/', 'feature/session/a', 'main', 'todos/x', 'switchboard/takeover/x'].map(hasSwitchboardBranchName)).toEqual([false, false, false, false, false]);
  });

  it('the closed-session limit: whole days 1–3650, default 30', () => {
    expect([1, 30, 3650].map(parseClosedSessionDays)).toEqual([1, 30, 3650]);
    expect([0, 3651, 1.5, '7', null].map(parseClosedSessionDays)).toEqual([null, null, null, null, null]);
    expect(closedSessionDaysOf(undefined)).toBe(30);
    expect(closedSessionDaysOf(12)).toBe(12);
  });

  it('a run body: at least one item, distinct ids, a known confirm', () => {
    expect(parseRunRequest({ items: [{ id: 'a', fingerprint: 'f', confirm: 'remote' }] })).toEqual({ ok: true, value: { items: [{ id: 'a', fingerprint: 'f', confirm: 'remote' }] } });
    expect(parseRunRequest(null)).toMatchObject({ ok: false, field: 'body' });
    expect(parseRunRequest({ items: [] })).toMatchObject({ ok: false, field: 'items' });
    expect(parseRunRequest({ items: [{ id: 'a' }] })).toMatchObject({ ok: false, field: 'items[0].fingerprint' });
    expect(parseRunRequest({ items: [{ id: 'a', fingerprint: 'f', confirm: 'all' }] })).toMatchObject({ ok: false, field: 'items[0].confirm' });
    expect(parseRunRequest({ items: [{ id: 'a', fingerprint: 'f' }, { id: 'a', fingerprint: 'f' }] })).toMatchObject({ ok: false, field: 'items[1].id' });
  });

  it('confirmations: never ticked by default; a selection without the right one is caught; a run body carries each item’s own', () => {
    const items = [item('r', 'remoteBranches', 'remote'), item('w', 'worktrees'), item('d', 'worktrees', 'uncommitted'), item('b', 'localBranches', 'unmerged')];
    expect([...defaultSelection(items)]).toEqual(['w']);
    expect(inRunOrder(items).map((entry) => entry.id)).toEqual(['w', 'd', 'b', 'r']);
    const all = new Set(['r', 'w', 'd', 'b']);
    expect([...neededConfirmations(items, all)].map(([kind, list]) => [kind, list.map((entry) => entry.id)])).toEqual([
      ['uncommitted', ['d']],
      ['unmerged', ['b']],
      ['remote', ['r']],
    ]);
    expect(runRequestOf(items, all).items).toEqual([
      { id: 'w', fingerprint: 'f-w' },
      { id: 'd', fingerprint: 'f-d', confirm: 'uncommitted' },
      { id: 'b', fingerprint: 'f-b', confirm: 'unmerged' },
      { id: 'r', fingerprint: 'f-r', confirm: 'remote' },
    ]);
    expect(missingConfirmations(items, [{ id: 'r', fingerprint: 'f-r' }, { id: 'b', fingerprint: 'f-b', confirm: 'remote' }, { id: 'w', fingerprint: 'f-w' }]).map((entry) => entry.id)).toEqual(['r', 'b']);
  });

  it('ages in days', () => {
    const now = Date.parse('2026-10-08T12:00:00Z');
    expect(ageText('2026-10-08T01:00:00Z', now)).toBe('today');
    expect(ageText('2026-10-07T11:00:00Z', now)).toBe('1 day ago');
    expect(ageText('2026-09-08T12:00:00Z', now)).toBe('30 days ago');
    expect(ageText(null, now)).toBe('');
  });
});
