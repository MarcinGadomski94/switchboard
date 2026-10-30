import { describe, expect, it } from 'vitest';
import { bandOf, CALIBRATION_WINDOW, todoActualsLabel, todoActualsTotal, todoActualsTotalLabel, todoCalibration, tookText, type TodoActualSample } from '../../src/core/todo-actuals.ts';

/**
 * D147 oracle (`docs/todos.md` → *Actual vs. estimate*): the card's "took" is the working time
 * with the open time beside it, an item finished before D147 shows open time only, the group
 * totals follow, and calibration reports per estimate band from working-time items only.
 */

const MIN = 60_000;

function sample(estimateMinutes: number | null, workingMinutes: number | null, openMinutes = (workingMinutes ?? 0) * 3): TodoActualSample {
  return { estimateMinutes, actualMs: openMinutes * MIN, actualTokens: null, workingMs: workingMinutes === null ? null : workingMinutes * MIN };
}

describe('the card and the totals (D147)', () => {
  it('took = working time, the open time in brackets when it differs; open time only before D147', () => {
    expect(tookText(12 * MIN, (51 * 60 + 3) * MIN)).toBe('took 12m (open 51h 3m)');
    expect(tookText(12 * MIN, 12 * MIN)).toBe('took 12m');
    expect(tookText(null, 90 * MIN)).toBe('open 1h 30m');
    expect(todoActualsLabel({ state: 'done', actualMs: 120 * MIN, actualTokens: 41_000, workingMs: 12 * MIN })).toBe('took 12m (open 2h) · 41k tokens');
    expect(todoActualsLabel({ state: 'done', actualMs: 120 * MIN, actualTokens: null, workingMs: null })).toBe('open 2h');
    expect(todoActualsLabel({ state: 'in_progress', actualMs: 120 * MIN, actualTokens: null, workingMs: 5 * MIN })).toBe('');
  });

  it('group totals: est and both times of the working-time items; open time only when none has one', () => {
    const total = todoActualsTotal([sample(60, 30, 300), sample(null, 10, 20), sample(20, null, 500)]);
    expect(total.working).toEqual({ count: 2, ms: 40 * MIN, openMs: 320 * MIN, estimated: 1, estimateMinutes: 60, estimatedMs: 30 * MIN, estimatedOpenMs: 300 * MIN });
    expect(todoActualsTotalLabel(total)).toBe('est ~1h · took 30m (open 5h) (3 done)');
    expect(todoActualsTotalLabel(todoActualsTotal([sample(null, 10, 20)]))).toBe('took 10m (open 20m) (1 done)');
    // All before D147 (or an older peer without `working`).
    expect(todoActualsTotalLabel(todoActualsTotal([sample(20, null, 500)]))).toBe('est ~20m · open 8h 20m (1 done)');
    expect(todoActualsTotalLabel({ count: 1, estimated: 0, estimateMinutes: 0, estimatedActualMs: 0, actualMs: 5 * MIN, tokens: 2_000 })).toBe('open 5m · 2k tokens (1 done)');
  });
});

describe('calibration per band (D147)', () => {
  it('bands: ≤60 min, 61–240, >240', () => {
    expect([1, 60, 61, 240, 241, 10_080].map(bandOf)).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it('one line, per band, from working-time items only; "not enough data" under three in a band', () => {
    const samples = [sample(30, 18), sample(45, 27), sample(20, 12), sample(120, 156), sample(90, 117), sample(180, 234), sample(300, 100)];
    expect(todoCalibration(samples, 'this folder')).toBe('Calibration (last 7 finished, this folder): ≤1 h estimates took 0.6× · 1–4 h took 1.3× · >4 h: not enough data');
    expect(todoCalibration(samples.slice(0, 3), 'this session')).toBe('Calibration (last 3 finished, this session): ≤1 h estimates took 0.6× · 1–4 h: not enough data · >4 h: not enough data');
  });

  it('open-time-only and unestimated items are left out; nothing below three usable items, or with no band of three', () => {
    const old = Array.from({ length: 20 }, () => sample(30, null, 3000));
    expect(todoCalibration(old, 'this session')).toBeNull();
    expect(todoCalibration([...old, sample(30, 30), sample(null, 30), sample(30, 30)], 'this session')).toBeNull();
    // Three usable, one per band: nothing to tell.
    expect(todoCalibration([sample(30, 30), sample(120, 120), sample(300, 300)], 'this session')).toBeNull();
  });

  it(`looks at the newest ${CALIBRATION_WINDOW} usable items only`, () => {
    const newest = Array.from({ length: CALIBRATION_WINDOW }, () => sample(10, 20));
    const older = Array.from({ length: 10 }, () => sample(10, 1));
    expect(todoCalibration([...newest, ...older], 'this session')).toBe(`Calibration (last ${CALIBRATION_WINDOW} finished, this session): ≤1 h estimates took 2.0× · 1–4 h: not enough data · >4 h: not enough data`);
  });
});
