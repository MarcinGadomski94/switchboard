import { describe, expect, it } from 'vitest';
import { accessChanged, accessRows, accessSummary, knownComputers } from '../../src/web/v2/settings/access-model.ts';

/** D176 · the *Computers…* checklist (`docs/profiles.md` → *Admins and computer access*). */
const machines = { self: { id: 'pc', name: 'PC' }, machines: [{ id: 'mac', name: 'Mac Studio' }] } as never;
const others = [{ id: 'tp', name: 'ThinkPad', through: 'Mac Studio' }];

describe('D176 · knownComputers', () => {
  it('this computer, the paired ones, then the ones through a paired one (once)', () => {
    expect(knownComputers(machines, [...others, { id: 'mac', name: 'Mac Studio', through: 'x' }])).toEqual([
      { id: 'pc', name: 'PC', self: true, through: null },
      { id: 'mac', name: 'Mac Studio', self: false, through: null },
      { id: 'tp', name: 'ThinkPad', self: false, through: 'Mac Studio' },
    ]);
    expect(knownComputers(null, others)).toEqual([]);
  });
});

describe('D176 · accessRows / accessChanged / accessSummary', () => {
  const known = knownComputers(machines, others);

  it('a list set before the ThinkPad was in view: the ThinkPad is undecided and ticked (allowed now)', () => {
    const profile = { computers: ['pc'], decidedFor: ['pc', 'mac'] };
    const rows = accessRows(profile, known);
    expect(rows.map((row) => [row.id, row.checked, row.undecided])).toEqual([
      ['pc', true, false],
      ['mac', false, false],
      ['tp', true, true],
    ]);
    // Saving as shown decides for the ThinkPad: a change.
    expect(accessChanged(profile, rows, false, new Set(['pc', 'tp']))).toBe(true);
    expect(accessSummary(profile, known, 'this computer')).toEqual({ kind: 'not-on', names: ['Mac Studio'] });
  });

  it('every computer decided and nothing moved: no change; All computers → a change', () => {
    const profile = { computers: ['pc', 'tp'], decidedFor: ['pc', 'mac', 'tp'] };
    const rows = accessRows(profile, known);
    expect(rows.every((row) => !row.undecided)).toBe(true);
    expect(accessChanged(profile, rows, false, new Set(['pc', 'tp']))).toBe(false);
    expect(accessChanged(profile, rows, true, new Set())).toBe(true);
    expect(accessChanged({ computers: null, decidedFor: null }, accessRows({ computers: null, decidedFor: null }, known), true, new Set())).toBe(false);
  });

  it('a D173 list (no decidedFor): "Only …", and saving it records what it was decided for', () => {
    const profile = { computers: ['pc'], decidedFor: null };
    const rows = accessRows(profile, known);
    expect(rows.map((row) => row.checked)).toEqual([true, false, false]);
    expect(accessChanged(profile, rows, false, new Set(['pc']))).toBe(true);
    expect(accessSummary(profile, known, 'this computer')).toEqual({ kind: 'only', names: ['PC (this computer)'] });
  });

  it('nothing blocked among the decided ones: All computers', () => {
    expect(accessSummary({ computers: ['pc', 'mac'], decidedFor: ['pc', 'mac'] }, known, 'this computer')).toEqual({ kind: 'all', names: [] });
  });
});
