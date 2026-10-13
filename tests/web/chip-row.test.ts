import { describe, expect, it } from 'vitest';
import { CHIP_ROWS_KEY, LESS_LABEL, foldChips, headerChips, loadChipsExpanded, moreLabel, saveChipsExpanded } from '../../src/web/views/session/chip-row.ts';

/** D104: the session header's chip row folds to one line (pure part). */
describe('headerChips', () => {
  const chips = [
    { k: 'work', v: 'feature-building', loop: false },
    { k: 'scope', v: 'a-front + b-microservice + c-func', loop: false },
    { k: 'ultracode', v: 'on', loop: true },
    { k: 'loop', v: '/loop', loop: true },
  ];

  it('puts the status chips first and splits the scope into one chip per solution (the first keyed)', () => {
    const items = headerChips(chips, ['a-front', 'b-microservice', 'c-func']);
    expect(items.map((c) => [c.k, c.v, c.scope])).toEqual([
      ['work', 'feature-building', false],
      ['ultracode', 'on', false],
      ['loop', '/loop', false],
      ['scope', 'a-front', true],
      [null, 'b-microservice', true],
      [null, 'c-func', true],
    ]);
    expect(new Set(items.map((c) => c.id)).size).toBe(items.length);
  });

  it('keeps a scope chip as it came when the solutions are not known (an older peer)', () => {
    expect(headerChips(chips, []).map((c) => `${c.k} ${c.v}`).at(-1)).toBe('scope a-front + b-microservice + c-func');
  });

  it('one solution renders exactly as before (`scope x`)', () => {
    expect(headerChips([{ k: 'scope', v: 'x', loop: false }], ['x'])).toEqual([{ id: 'scope x', k: 'scope', v: 'x', loop: false, scope: true }]);
  });
});

describe('foldChips', () => {
  const toggle = (hidden: number) => 80 + String(hidden).length * 7;

  it('changes nothing when every chip fits on one line', () => {
    expect(foldChips({ available: 320, gap: 6, widths: [100, 100, 100], toggleWidth: toggle })).toBeNull();
    expect(foldChips({ available: 312, gap: 6, widths: [100, 100, 100], toggleWidth: toggle })).toBeNull();
    expect(foldChips({ available: 0, gap: 6, widths: [], toggleWidth: toggle })).toBeNull();
  });

  it('shows the chips that fit before the "+N more" toggle', () => {
    // 100 + 6 + 100 + 6 + 87 = 299 ≤ 300; a third chip would not leave room for the toggle.
    expect(foldChips({ available: 300, gap: 6, widths: [100, 100, 100, 100], toggleWidth: toggle })).toBe(2);
    expect(foldChips({ available: 200, gap: 6, widths: [100, 100, 100, 100], toggleWidth: toggle })).toBe(1);
  });

  it('accounts for the toggle growing with the hidden count', () => {
    const widths = Array.from({ length: 15 }, () => 50);
    // 10 hidden → a two-digit toggle (94): 5 × 50 + 5 × 6 + 94 = 374.
    expect(foldChips({ available: 374, gap: 6, widths, toggleWidth: toggle })).toBe(5);
    expect(foldChips({ available: 373, gap: 6, widths, toggleWidth: toggle })).toBe(4);
  });

  it('always shows at least one chip (cut with … by the CSS); a single chip never folds', () => {
    expect(foldChips({ available: 50, gap: 6, widths: [400, 100], toggleWidth: toggle })).toBe(1);
    expect(foldChips({ available: 50, gap: 6, widths: [400], toggleWidth: toggle })).toBeNull();
  });
});

describe('labels and the remembered choice', () => {
  it('labels the toggle', () => {
    expect(moreLabel(12)).toBe('+12 more ▾');
    expect(LESS_LABEL).toBe('▴ less');
  });

  it('remembers per session, folded by default, and survives bad storage', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) };
    expect(loadChipsExpanded(storage, 's1')).toBe(false);
    saveChipsExpanded(storage, 's1', true);
    saveChipsExpanded(storage, 's2', false);
    expect(loadChipsExpanded(storage, 's1')).toBe(true);
    expect(loadChipsExpanded(storage, 's2')).toBe(false);
    map.set(CHIP_ROWS_KEY, '{nope');
    expect(loadChipsExpanded(storage, 's1')).toBe(false);
    expect(loadChipsExpanded(null, 's1')).toBe(false);
    const throwing = { getItem: () => null, setItem: () => { throw new Error('blocked'); } };
    expect(() => saveChipsExpanded(throwing, 's1', true)).not.toThrow();
  });

  it('keeps the newest 200 sessions', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) };
    for (let i = 0; i < 205; i++) saveChipsExpanded(storage, `s${i}`, true);
    expect(loadChipsExpanded(storage, 's0')).toBe(false);
    expect(loadChipsExpanded(storage, 's204')).toBe(true);
    expect(Object.keys(JSON.parse(map.get(CHIP_ROWS_KEY) ?? '{}'))).toHaveLength(200);
  });
});
