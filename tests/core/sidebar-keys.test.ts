import { describe, expect, it } from 'vitest';
import { HybridClock, NO_CLOCK, formatClock, isClock, parseClock } from '../../src/core/hlc.ts';
import { isOrderKey, keyBetween, keysBetween, longestIncreasing, rekeyGroup } from '../../src/core/sidebar-keys.ts';

/** D71 oracle: order keys (src/core/sidebar-keys.ts) and the hybrid clock (src/core/hlc.ts). */

describe('order keys', () => {
  it('a key between two keys, or past either end; never ending in 0', () => {
    const cases: Array<[string | null, string | null]> = [
      [null, null],
      [null, '1'],
      [null, '01'],
      ['5', '6'],
      ['5', '51'],
      ['5z', '6'],
      ['z', null],
      ['000000i', '000001i'],
      ['a', 'a1'],
    ];
    for (const [before, after] of cases) {
      const key = keyBetween(before, after);
      expect(isOrderKey(key), `${before} ${after} → ${key}`).toBe(true);
      if (before !== null) expect(key > before, `${before} < ${key}`).toBe(true);
      if (after !== null) expect(key < after, `${key} < ${after}`).toBe(true);
    }
    expect(() => keyBetween('6', '5')).toThrow();
    expect(() => keyBetween('5', '5')).toThrow();
  });

  it('a thousand inserts at the same place stay ordered and short', () => {
    let low: string | null = null;
    const high = 'i';
    for (let i = 0; i < 1000; i++) {
      const key = keyBetween(low, high);
      expect(key < high && (low === null || key > low)).toBe(true);
      low = key;
    }
    expect((low as string).length).toBeLessThan(1000);
    let last = 'a';
    for (let i = 0; i < 1000; i++) last = keyBetween(last, null);
    expect(last.length).toBeLessThan(40);
  });

  it('several keys between two are spread (increasing, logarithmic length)', () => {
    const keys = keysBetween('a', 'b', 100);
    expect(keys).toHaveLength(100);
    expect([...keys].sort()).toEqual(keys);
    expect(keys.every((k) => k > 'a' && k < 'b' && isOrderKey(k))).toBe(true);
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(10);
  });

  it('a re-ordered group keeps the keys of a longest increasing run and re-keys only the rest', () => {
    expect([...longestIncreasing(['b', 'c', 'a', 'd', null, 'e'])].sort()).toEqual([0, 1, 3, 5]);
    const keys: Record<string, string> = { A: '1', B: '2', C: '3' };
    // A moved to the end: only A changes.
    let result = rekeyGroup(['B', 'C', 'A'], (id) => keys[id] ?? null);
    expect([...result.changed]).toEqual(['A']);
    expect((result.keys.get('A') as string) > '3').toBe(true);
    // C moved to the front: only C changes (not A and B).
    result = rekeyGroup(['C', 'A', 'B'], (id) => keys[id] ?? null);
    expect([...result.changed]).toEqual(['C']);
    expect((result.keys.get('C') as string) < '1').toBe(true);
    // A new one in the middle.
    result = rekeyGroup(['A', 'N', 'B', 'C'], (id) => keys[id] ?? null);
    expect([...result.changed]).toEqual(['N']);
    const n = result.keys.get('N') as string;
    expect(n > '1' && n < '2').toBe(true);
  });
});

describe('hybrid clock', () => {
  it('writes increasing clocks, also within one millisecond and when the wall clock goes back', () => {
    let wall = 1_000;
    const clock = new HybridClock('node-a', () => wall);
    const a = clock.next();
    const b = clock.next();
    wall = 500;
    const c = clock.next();
    expect(a < b && b < c).toBe(true);
    expect(parseClock(a)).toEqual({ ms: 1000, counter: 0, node: 'node-a' });
    expect(parseClock(b)).toEqual({ ms: 1000, counter: 1, node: 'node-a' });
    expect(isClock(a) && isClock(NO_CLOCK)).toBe(true);
    expect(NO_CLOCK < a).toBe(true);
  });

  it("after seeing a peer's later clock, the next one is later than it; machines tie-break by id", () => {
    const clock = new HybridClock('a', () => 1_000);
    const theirs = formatClock({ ms: 5_000, counter: 3, node: 'b' });
    clock.observe(theirs);
    const next = clock.next();
    expect(next > theirs).toBe(true);
    expect(formatClock({ ms: 1, counter: 0, node: 'b' }) > formatClock({ ms: 1, counter: 0, node: 'a' })).toBe(true);
  });
});

describe('order keys: prepending stays short too', () => {
  it('a thousand keys each before the last', () => {
    let first = 'i';
    for (let i = 0; i < 1000; i++) {
      const key = keyBetween(null, first);
      expect(key < first && isOrderKey(key)).toBe(true);
      first = key;
    }
    expect(first.length).toBeLessThan(70);
  });
});
