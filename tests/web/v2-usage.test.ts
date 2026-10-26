import { describe, expect, it } from 'vitest';
import type { UsageChart } from '../../src/core/usage-breakdown.ts';
import { estimateText, isUsageView, parseUsageAddress, pillUsageHref, shareText, stackColumns, usageAddress, usageApiQuery, usageCsvHref } from '../../src/web/v2/insights/usage-model.ts';

/** D134 · v2 Insights → Usage: the address, the API query, the pill's link, the shares and the estimate's words, the stacked chart. */
describe('D134 · v2 usage model', () => {
  it('reads and writes the address (defaults left out)', () => {
    expect(isUsageView('?view=usage')).toBe(true);
    expect(isUsageView('?range=week')).toBe(false);
    const filters = parseUsageAddress('?view=usage&period=week&account=p1&groupBy=model&group=claude-opus-5-5&page=2&computer=local');
    expect(filters).toEqual({ period: 'week', account: 'p1', groupBy: 'model', group: 'claude-opus-5-5', page: 2, computer: 'local' });
    expect(usageAddress(filters)).toBe('/insights?view=usage&period=week&account=p1&groupBy=model&group=claude-opus-5-5&page=2&computer=local');
    expect(parseUsageAddress('?view=usage&period=year&groupBy=x&page=-1')).toEqual({ period: '5h', account: null, groupBy: 'session', group: null, page: 0, computer: null });
    expect(usageAddress(parseUsageAddress('?view=usage'))).toBe('/insights?view=usage');
  });

  it('asks the API (today from the browser’s midnight) and builds the CSV link', () => {
    const now = new Date(2026, 9, 26, 15, 30);
    expect(usageApiQuery(parseUsageAddress('?view=usage&account=p1'), now)).toBe('period=5h&account=p1');
    const midnight = new Date(2026, 9, 26).toISOString();
    expect(usageApiQuery(parseUsageAddress('?view=usage&period=today'), now)).toBe(`period=today&from=${encodeURIComponent(midnight)}`);
    expect(usageCsvHref(parseUsageAddress('?view=usage&page=3'), now)).toBe('/api/insights/usage?period=5h&format=csv&machine=all&peers=wait');
    expect(usageCsvHref(parseUsageAddress('?view=usage&computer=m2'), now)).toBe('/api/machines/m2/api/insights/usage?period=5h&format=csv&machine=local');
  });

  it('the pill opens the account’s current 5-hour window (an unknown account: its CLI’s Default)', () => {
    expect(pillUsageHref('p1')).toBe('/insights?view=usage&account=p1');
    expect(pillUsageHref('cli:claude')).toBe('/insights?view=usage&account=default-claude');
  });

  it('words shares and labels the estimate as one', () => {
    expect(shareText(0)).toBe('0%');
    expect(shareText(0.004)).toBe('<1%');
    expect(shareText(0.346)).toBe('35%');
    expect(estimateText({ pct: 12.4, window: '5h' })).toBe('≈ 12% of the 5-hour limit');
    expect(estimateText({ pct: 0.3, window: 'week' })).toBe('≈ <1% of the weekly limit');
  });

  it('stacks the columns bottom-up, relative to the tallest', () => {
    const chart: UsageChart = {
      buckets: ['2026-10-26T10:00:00.000Z', '2026-10-26T10:30:00.000Z'],
      bucketMs: 1_800_000,
      start: '2026-10-26T10:00:00.000Z',
      end: '2026-10-26T11:00:00.000Z',
      series: [
        { key: 'a', label: 'A', values: [300, 100], other: false },
        { key: '__other__', label: 'Everything else', values: [100, 0], other: true },
      ],
    };
    const { columns, max } = stackColumns(chart);
    expect(max).toBe(400);
    expect(columns[0]?.segments).toEqual([
      { series: 0, y: 25, h: 75, value: 300 },
      { series: 1, y: 0, h: 25, value: 100 },
    ]);
    expect(columns[1]?.segments).toEqual([{ series: 0, y: 75, h: 25, value: 100 }]);
  });
});
