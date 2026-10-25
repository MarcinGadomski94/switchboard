import { describe, expect, it } from 'vitest';
import type { OutcomeRow, PeriodCostRow } from '../../src/core/insights.ts';
import {
  accuracyBars,
  barsLabel,
  costBars,
  durationShort,
  estimateAccuracy,
  insightsAddress,
  insightsApiQuery,
  money,
  parseInsightsAddress,
  pct,
  rework,
  suggestionHref,
  tokenBars,
  tokensShort,
  trendApiQuery,
} from '../../src/web/v2/insights/insights-model.ts';

/** D131 · lane R · the v2 Insights page's pure model. */

const NOW = new Date('2026-10-25T12:00:00.000Z');
const DEFAULTS = { range: 'today', folder: null, cli: null, model: null, account: null, computer: null } as const;

describe('the address and the API query', () => {
  it('round-trips the range and every filter; defaults are left out', () => {
    expect(parseInsightsAddress('')).toEqual(DEFAULTS);
    const filters = { range: 'week', folder: '/work/acme', cli: 'claude', model: 'none', account: 'default-claude', computer: 'local' } as const;
    const path = insightsAddress(filters);
    expect(path).toBe('/insights?range=week&folder=%2Fwork%2Facme&engine=claude&model=none&account=default-claude&computer=local');
    expect(parseInsightsAddress(path.slice('/insights'.length))).toEqual(filters);
    expect(insightsAddress(DEFAULTS)).toBe('/insights');
    expect(parseInsightsAddress('?range=year&folder=all').range).toBe('today');
  });
  it('maps Today / This week / This month to the D108 periods', () => {
    expect(insightsApiQuery(DEFAULTS, NOW)).toBe('period=custom&from=2026-10-25&to=2026-10-25');
    expect(insightsApiQuery({ ...DEFAULTS, range: 'week', folder: 'none', model: 'opus' }, NOW)).toBe('period=7d&folder=none&model=opus');
    expect(insightsApiQuery({ ...DEFAULTS, range: 'month', cli: 'codex', account: 'a1' }, NOW)).toBe('period=30d&cli=codex&account=a1');
  });
  it('Today’s chart reads the last 7 days', () => {
    expect(trendApiQuery(DEFAULTS, NOW)).toBe('period=7d');
    expect(trendApiQuery({ ...DEFAULTS, range: 'month' }, NOW)).toBe('period=30d');
  });
});

describe('formats', () => {
  it('tokens, durations, money and shares', () => {
    expect([tokensShort(850), tokensShort(4_200), tokensShort(41_000), tokensShort(1_200_000)]).toEqual(['850', '4.2k', '41k', '1.2M']);
    expect([durationShort(0), durationShort(20_000), durationShort(42 * 60_000), durationShort(400 * 60_000), durationShort(120 * 60_000)]).toEqual(['0m', '<1m', '42m', '6h 40m', '2h']);
    expect(money(8.4, 'EUR')).toBe('~€8.40');
    expect(money(0.0096, 'USD', false)).toBe('$0.0096');
    expect(money(null, 'USD')).toBe('—');
    expect([pct(0.82), pct(null)]).toEqual(['82%', '—']);
  });
});

describe('numbers', () => {
  it('estimate accuracy = tasks within half to twice their estimate', () => {
    const buckets = [
      { key: 'under-half', label: '< 0.5×', count: 1 },
      { key: 'half-to-one', label: '0.5–1×', count: 2 },
      { key: 'one-to-two', label: '1–2×', count: 2 },
      { key: 'over-two', label: '> 2×', count: 1 },
    ] as const;
    expect(estimateAccuracy({ count: 6, buckets })).toBeCloseTo(4 / 6);
    expect(estimateAccuracy({ count: 0, buckets })).toBeNull();
    expect(accuracyBars({ buckets }).map((b) => [b.label, b.valueText, b.width])).toEqual([
      ['< 0.5× the estimate', '1', 50],
      ['0.5–1× the estimate', '2', 100],
      ['1–2× the estimate', '2', 100],
      ['> 2× the estimate', '1', 50],
    ]);
  });
  it('rework sums reopened tasks and sent-back changes', () => {
    const row = (done: number, reopened: number, sentBack: number): OutcomeRow => ({
      model: 'm',
      label: 'm',
      todos: { done, reopened, reopenRate: null },
      plans: { merged: 0, failed: 0, blocked: 0, mergeRate: null, decisions: { merged: 0, sentBack, failed: 0 }, sendBackRate: null },
      reverts: { turns: 0, reverts: 0, redos: 0, per100Turns: null },
    });
    expect(rework([row(3, 1, 2), { ...row(3, 0, 0), plans: null }])).toEqual({ rate: 1 / 6, reopened: 1, done: 6, sentBack: 2 });
    expect(rework([]).rate).toBeNull();
  });
});

describe('charts', () => {
  it('tokens per day: heights against the tallest, the last bar is today', () => {
    const bars = tokenBars(
      [
        { day: '2026-10-23', tokens: 500_000 },
        { day: '2026-10-24', tokens: 0 },
        { day: '2026-10-25', tokens: 1_000_000 },
      ],
      '2026-10-25',
    );
    expect(bars.map((b) => [b.label, b.height, b.last])).toEqual([
      ['Fri', 50, false],
      ['Sat', 0, false],
      ['Today', 100, true],
    ]);
    expect(barsLabel('Tokens per day', bars)).toBe('Tokens per day: Fri 500k, Sat 0, Today 1M');
  });
  it('where the cost went: the top three folders, then everything else', () => {
    const row = (key: string, cost: number | null): PeriodCostRow => ({ key, label: key, cost, lowerBound: false, unpricedTokens: 0 });
    const bars = costBars([row('a', 1), row('b', 3.6), row('c', 2.1), row('d', 1.2), row('e', 0.3), row('f', null)], 'EUR');
    expect(bars.map((b) => [b.label, b.valueText, b.width])).toEqual([
      ['b', '€3.60', 100],
      ['c', '€2.10', 58.3],
      ['d', '€1.20', 33.3],
      ['Everything else', '€1.30', 36.1],
    ]);
    expect(costBars([], 'EUR')).toEqual([]);
  });
  it('the suggestion opens the v2 Advanced page with the rule pre-filled', () => {
    const href = suggestionHref({ rule: { match: { priority: 'low' }, provider: 'claude', model: 'haiku' } as never });
    expect(href.startsWith('/settings/advanced/sessions?suggestRule=')).toBe(true);
  });
});
