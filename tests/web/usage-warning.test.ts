import { describe, expect, it } from 'vitest';
import type { UsageWarning } from '../../src/core/api.ts';
import {
  type KeyValueStorage,
  SHOWN_WARNINGS_KEY,
  loadShownWarnings,
  saveShownWarnings,
  usageWarningKey,
  usageWarningToast,
  warningsToShow,
} from '../../src/web/toast/usage-warning.ts';

/** M9.2: the usage warning toast (src/web/toast/usage-warning.ts, docs/usage.md). */

const NOW = Date.parse('2026-09-27T21:52:00.000Z');
const FIVE: UsageWarning = { window: 'five_hour', pct: 91.4, threshold: 90, resetsAt: '2026-09-27T23:40:00.290Z', firedAt: '2026-09-27T21:50:00.000Z' };
const SEVEN: UsageWarning = { window: 'seven_day', pct: 90, threshold: 90, resetsAt: '2026-10-01T13:00:00.290Z', firedAt: '2026-09-27T21:50:00.000Z' };

class MapStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe('usage warning toast', () => {
  it('says which window reached what, when it resets, and that nothing is paused; no session to jump to', () => {
    expect(usageWarningToast(FIVE, NOW)).toEqual({
      id: 'usage-five_hour@2026-09-27T23:40:00.290Z',
      title: 'Max usage 91%',
      sub: '5-hour window',
      branch: '',
      text: 'Your Max 5-hour window reached 91% (warning at 90%). It resets in 1h48. Nothing is paused automatically.',
      sessionId: null,
    });
    expect(usageWarningToast(SEVEN, NOW)).toMatchObject({ title: 'Max usage 90%', sub: 'weekly limit' });
  });

  it('one toast per window and reset: shown ones and ones whose window already reset are skipped', () => {
    expect(warningsToShow([FIVE, SEVEN], new Set(), NOW)).toEqual([FIVE, SEVEN]);
    expect(warningsToShow([FIVE, SEVEN], new Set([usageWarningKey(FIVE)]), NOW)).toEqual([SEVEN]);
    expect(warningsToShow([FIVE], new Set(), Date.parse(FIVE.resetsAt))).toEqual([]);
    expect(warningsToShow(undefined, new Set(), NOW)).toEqual([]);
    // The next five-hour window is a new warning.
    expect(warningsToShow([{ ...FIVE, resetsAt: '2026-09-28T04:40:00.000Z' }], new Set([usageWarningKey(FIVE)]), NOW)).toHaveLength(1);
  });

  it('remembers shown warnings in localStorage, tolerating missing, blocked or foreign storage', () => {
    const storage = new MapStorage();
    expect(loadShownWarnings(storage)).toEqual(new Set());
    saveShownWarnings(storage, new Set([usageWarningKey(FIVE), usageWarningKey(SEVEN)]));
    expect(JSON.parse(storage.getItem(SHOWN_WARNINGS_KEY) as string)).toEqual([usageWarningKey(FIVE), usageWarningKey(SEVEN)]);
    expect(loadShownWarnings(storage)).toEqual(new Set([usageWarningKey(FIVE), usageWarningKey(SEVEN)]));

    // Only the newest 20 keys are kept.
    saveShownWarnings(storage, new Set(Array.from({ length: 25 }, (_, i) => `five_hour@${i}`)));
    const kept = JSON.parse(storage.getItem(SHOWN_WARNINGS_KEY) as string) as string[];
    expect(kept).toHaveLength(20);
    expect(kept[0]).toBe('five_hour@5');

    storage.setItem(SHOWN_WARNINGS_KEY, '{not json');
    expect(loadShownWarnings(storage)).toEqual(new Set());
    storage.setItem(SHOWN_WARNINGS_KEY, JSON.stringify({ a: 1 }));
    expect(loadShownWarnings(storage)).toEqual(new Set());
    expect(loadShownWarnings(null)).toEqual(new Set());

    const blocked: KeyValueStorage = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        throw new Error('QuotaExceededError');
      },
    };
    expect(loadShownWarnings(blocked)).toEqual(new Set());
    expect(() => saveShownWarnings(blocked, new Set(['x']))).not.toThrow();
  });
});
