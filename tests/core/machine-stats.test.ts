import { describe, expect, it } from 'vitest';
import { readMachineStats } from '../../src/core/machine-stats.ts';

/** D162 (`docs/peers.md` → *A paired computer's CPU and RAM*): a paired computer's `machineStats`, read defensively. */

const AT = '2026-11-11T10:00:00.000Z';
const GB = 1024 ** 3;

describe('D162 readMachineStats', () => {
  it('takes a sound reading and keeps exactly its four fields', () => {
    expect(readMachineStats({ cpu: 23, ramUsed: 18 * GB, ramTotal: 32 * GB, at: AT, extra: 'x' })).toEqual({ cpu: 23, ramUsed: 18 * GB, ramTotal: 32 * GB, at: AT });
    expect(readMachineStats({ cpu: 0, ramUsed: 0, ramTotal: 1, at: AT })).toEqual({ cpu: 0, ramUsed: 0, ramTotal: 1, at: AT });
    // A little over the total (the sender's rounding) is capped at the total.
    expect(readMachineStats({ cpu: 100, ramUsed: 33 * GB, ramTotal: 32 * GB, at: AT })?.ramUsed).toBe(32 * GB);
  });

  it('refuses anything that is not a reading', () => {
    for (const bad of [
      null,
      'x',
      [],
      { cpu: 23, ramUsed: 1, ramTotal: 2 },
      { cpu: 23, ramUsed: 1, ramTotal: 2, at: 'not a time' },
      { cpu: '23', ramUsed: 1, ramTotal: 2, at: AT },
      { cpu: 101, ramUsed: 1, ramTotal: 2, at: AT },
      { cpu: -1, ramUsed: 1, ramTotal: 2, at: AT },
      { cpu: Number.NaN, ramUsed: 1, ramTotal: 2, at: AT },
      { cpu: 5, ramUsed: -1, ramTotal: 2, at: AT },
      { cpu: 5, ramUsed: 1, ramTotal: 0, at: AT },
      { cpu: 5, ramUsed: 3 * GB, ramTotal: 2 * GB, at: AT },
      { cpu: 5, ramUsed: 1, ramTotal: Number.POSITIVE_INFINITY, at: AT },
    ]) {
      expect(readMachineStats(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
