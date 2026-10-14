import { describe, expect, it } from 'vitest';
import {
  EMPTY_USAGE,
  EXAMPLE_PRICES,
  type InsightReading,
  type InsightsInput,
  type InsightsQuery,
  type MergeDecisionRow,
  type PlanOutcomeRow,
  type TodoActualRow,
  type TurnRollupRow,
  accuracyBucket,
  buildInsights,
  insightsQueryString,
  median,
  parseInsightsQuery,
  parsePriceTable,
  priceFor,
  readPriceTable,
  resultInsightFields,
  resultModel,
  resultTokenSplit,
  usageCost,
  windowForecast,
} from '../../src/core/insights.ts';

/**
 * D108 · the Insights numbers against a hand-computed fixture world (`docs/insights.md`).
 * Every expected value below is worked out by hand in the comments, never by the code under test.
 */

const NOW = new Date('2026-10-14T12:00:00.000Z');
const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-4-5';
const SPLIT = { input: 1_000, output: 10_000, cacheWrite: 20_000, cacheRead: 200_000, unsplit: 0 };

function turn(partial: Partial<TurnRollupRow> & Pick<TurnRollupRow, 'day' | 'sessionId' | 'model'>): TurnRollupRow {
  return { provider: 'claude', profileId: 'default-claude', folder: '/work/acme', kind: 'session', turns: 0, errorTurns: 0, tokens: 0, usage: EMPTY_USAGE, durationMs: 0, reverts: 0, redos: 0, ...partial };
}

function todo(partial: Partial<TodoActualRow> & Pick<TodoActualRow, 'todoId' | 'model'>): TodoActualRow {
  return {
    sessionId: 's1',
    runSessionId: null,
    folder: '/work/acme',
    title: partial.todoId,
    priority: 'low',
    estimateMinutes: null,
    actualMs: 0,
    actualTokens: 231_000 - 200_000,
    usage: SPLIT,
    provider: 'claude',
    profileId: 'default-claude',
    completedAt: '2026-10-13T10:00:00.000Z',
    reopens: 0,
    ...partial,
  };
}

const MIN = 60_000;

const TURNS: TurnRollupRow[] = [
  turn({ day: '2026-10-12', sessionId: 's1', model: OPUS, turns: 4, tokens: 40_000, durationMs: 240_000, reverts: 1 }),
  turn({ day: '2026-10-13', sessionId: 's2', model: HAIKU, profileId: 'p2', folder: '/work/docs', turns: 6, tokens: 12_000, durationMs: 120_000 }),
  turn({ day: '2026-10-13', sessionId: 's1', model: OPUS, turns: 2, tokens: 20_000, durationMs: 60_000, reverts: 1, redos: 1 }),
  // Outside the 7-day period (2026-10-08 … 2026-10-14).
  turn({ day: '2026-10-01', sessionId: 's1', model: OPUS, turns: 100, tokens: 1_000_000, durationMs: 1 }),
  // A chat (D106): counted apart.
  turn({ day: '2026-10-14', sessionId: 'c1', model: OPUS, kind: 'chat', turns: 3, tokens: 3_000, durationMs: 30_000 }),
];

const TODOS: TodoActualRow[] = [
  // Opus, low priority, estimated 20 min: 10 / 30 / 50 min → ratios 0.5, 1.5, 2.5; t2 reopened once.
  todo({ todoId: 't1', model: OPUS, estimateMinutes: 20, actualMs: 10 * MIN }),
  todo({ todoId: 't2', model: OPUS, estimateMinutes: 20, actualMs: 30 * MIN, reopens: 1 }),
  todo({ todoId: 't3', model: OPUS, estimateMinutes: 20, actualMs: 50 * MIN }),
  // Haiku, low priority, estimated 10 min: 4 / 10 / 6 min → ratios 0.4, 1.0, 0.6.
  todo({ todoId: 'h1', model: HAIKU, estimateMinutes: 10, actualMs: 4 * MIN, folder: '/work/docs', profileId: 'p2' }),
  todo({ todoId: 'h2', model: HAIKU, estimateMinutes: 10, actualMs: 10 * MIN, folder: '/work/docs', profileId: 'p2' }),
  todo({ todoId: 'h3', model: HAIKU, estimateMinutes: 10, actualMs: 6 * MIN, folder: '/work/docs', profileId: 'p2' }),
  // A model without a price row; an Opus item recorded before 1.20 (only D78's total: unsplit).
  todo({ todoId: 'u1', model: 'mystery-model', actualMs: MIN, actualTokens: 5_000, usage: { ...EMPTY_USAGE, unsplit: 5_000 } }),
  todo({ todoId: 'u2', model: OPUS, priority: null, actualMs: MIN, actualTokens: 10_000, usage: { ...EMPTY_USAGE, unsplit: 10_000 } }),
  // Completed before the period.
  todo({ todoId: 'old', model: OPUS, estimateMinutes: 5, actualMs: 100 * MIN, completedAt: '2026-10-01T10:00:00.000Z' }),
];

const PLANS: PlanOutcomeRow[] = [
  { itemId: 'p-a', outcome: 'merged', at: '2026-10-13T09:00:00.000Z', provider: 'claude', model: OPUS, profileId: 'default-claude', folder: '/work/acme' },
  { itemId: 'p-b', outcome: 'merged', at: '2026-10-13T09:00:00.000Z', provider: 'claude', model: OPUS, profileId: 'default-claude', folder: '/work/acme' },
  { itemId: 'p-c', outcome: 'failed', at: '2026-10-13T09:00:00.000Z', provider: 'claude', model: OPUS, profileId: 'default-claude', folder: '/work/acme' },
  { itemId: 'p-d', outcome: 'merged', at: '2026-10-13T09:00:00.000Z', provider: 'claude', model: HAIKU, profileId: 'p2', folder: '/work/docs' },
  { itemId: 'p-e', outcome: 'blocked', at: '2026-10-13T09:00:00.000Z', provider: 'claude', model: HAIKU, profileId: 'p2', folder: '/work/docs' },
];

const DECISIONS: MergeDecisionRow[] = [
  { itemId: 'p-a', decision: 'sent-back', at: '2026-10-12T09:00:00.000Z', provider: 'claude', model: OPUS, profileId: 'default-claude', folder: '/work/acme' },
  { itemId: 'p-a', decision: 'sent-back', at: '2026-10-12T10:00:00.000Z', provider: 'claude', model: OPUS, profileId: 'default-claude', folder: '/work/acme' },
  { itemId: 'p-a', decision: 'merged', at: '2026-10-13T09:00:00.000Z', provider: 'claude', model: OPUS, profileId: 'default-claude', folder: '/work/acme' },
];

function reading(at: string, five: [number, string] | null, week: [number, string] | null, profileId = 'default-claude'): InsightReading {
  return { profileId, receivedAt: at, fiveHourPct: five?.[0] ?? null, fiveHourResetsAt: five?.[1] ?? null, sevenDayPct: week?.[0] ?? null, sevenDayResetsAt: week?.[1] ?? null };
}

const FIVE_RESET = '2026-10-14T14:00:00.000Z';
const WEEK_RESET = '2026-10-16T14:00:00.000Z';
const READINGS: InsightReading[] = [
  // An earlier 5-hour window (its reset is not the current one): left out.
  reading('2026-10-14T08:00:00.000Z', [90, '2026-10-14T09:00:00.000Z'], null),
  reading('2026-10-13T12:00:00.000Z', null, [38, WEEK_RESET]),
  reading('2026-10-14T00:00:00.000Z', null, [50, WEEK_RESET]),
  reading('2026-10-14T11:00:00.000Z', [20, FIVE_RESET], null),
  reading('2026-10-14T11:30:00.000Z', [30, FIVE_RESET], null),
  reading('2026-10-14T12:00:00.000Z', [40, FIVE_RESET], [62, WEEK_RESET]),
  reading('2026-10-14T11:55:00.000Z', [10, FIVE_RESET], [10, WEEK_RESET], 'p2'),
];

function query(partial: Partial<InsightsQuery> = {}): InsightsQuery {
  return { period: '7d', from: '2026-10-08', to: '2026-10-14', folder: null, cli: null, model: null, account: null, ...partial };
}

function input(partial: Partial<InsightsInput> = {}): InsightsInput {
  return {
    query: query(),
    now: NOW,
    turns: TURNS,
    todos: TODOS,
    plans: PLANS,
    mergeDecisions: DECISIONS,
    readings: READINGS,
    accounts: [
      { id: 'default-claude', cli: 'claude', name: 'Work', credits: '€12.40 left of €50', onCredits: false },
      { id: 'p2', cli: 'claude', name: 'Private', credits: null, onCredits: false },
    ],
    sessionTitles: new Map([
      ['s1', 'Acme upload'],
      ['s2', 'Docs'],
    ]),
    prices: EXAMPLE_PRICES,
    accountNames: new Map([
      ['default-claude', 'Work'],
      ['p2', 'Private'],
    ]),
    backfill: { done: true, percent: 100 },
    ...partial,
  };
}

describe('D108 · the query', () => {
  it('presets are whole UTC days ending today; custom needs a valid range', () => {
    const at = new Date('2026-10-14T23:30:00.000Z');
    expect(parseInsightsQuery({}, at)).toEqual({ ok: true, query: query({ period: '30d', from: '2026-09-15' }) });
    expect(parseInsightsQuery({ period: '7d' }, at)).toEqual({ ok: true, query: query() });
    expect(parseInsightsQuery({ period: '90d', folder: 'none', model: 'none', cli: 'claude', account: 'all' }, at)).toEqual({ ok: true, query: query({ period: '90d', from: '2026-07-17', folder: '', model: '', cli: 'claude' }) });
    expect(parseInsightsQuery({ period: 'custom', from: '2026-10-01', to: '2026-10-03' }, at)).toEqual({ ok: true, query: query({ period: 'custom', from: '2026-10-01', to: '2026-10-03' }) });
    expect(parseInsightsQuery({ period: 'custom', from: '2026-10-05', to: '2026-10-03' }, at)).toMatchObject({ ok: false, errors: [{ field: 'from' }] });
    expect(parseInsightsQuery({ period: 'custom', from: '2026-02-30', to: '2026-10-03' }, at)).toMatchObject({ ok: false, errors: [{ field: 'from' }] });
    expect(parseInsightsQuery({ period: 'custom', from: '2025-01-01', to: '2026-10-03' }, at)).toMatchObject({ ok: false, errors: [{ field: 'to' }] });
    expect(parseInsightsQuery({ period: '1y' }, at)).toMatchObject({ ok: false, errors: [{ field: 'period' }] });
    expect(insightsQueryString(query({ folder: '', model: OPUS }))).toBe(`period=7d&folder=none&model=${OPUS}`);
  });
});

describe('D108 · tokens, models and prices', () => {
  it('reads the split and the reported model from a result line', () => {
    const raw = {
      usage: { input_tokens: 18, cache_creation_input_tokens: 34_071, cache_read_input_tokens: 62_285, output_tokens: 473 },
      modelUsage: { 'claude-haiku-4-5-20251001': { outputTokens: 12, canonicalModel: 'claude-haiku-4-5' }, 'claude-opus-5-5': { outputTokens: 461 } },
    };
    expect(resultTokenSplit(raw)).toEqual({ input: 18, output: 473, cacheWrite: 34_071, cacheRead: 62_285 });
    // The main model has the most output tokens.
    expect(resultModel(raw)).toBe(OPUS);
    expect(resultModel({ modelUsage: { 'claude-haiku-4-5-20251001': { outputTokens: 3 } } })).toBe(HAIKU);
    expect(resultInsightFields({})).toEqual({});
    expect(resultInsightFields({ usage: { input_tokens: 0 } })).toEqual({});
  });

  it('prices: first matching row, per 1M tokens; unsplit tokens at the input rate', () => {
    const opus = priceFor(EXAMPLE_PRICES, OPUS);
    expect(opus).toEqual({ match: 'opus', input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 });
    expect(priceFor(EXAMPLE_PRICES, 'mystery-model')).toBeNull();
    expect(priceFor(EXAMPLE_PRICES, '')).toBeNull();
    // 1,000 × 4 + 10,000 × 20 + 20,000 × 5 + 200,000 × 0.2 = 344,000 → 0.344.
    expect(usageCost(SPLIT, opus!)).toBeCloseTo(0.344, 10);
    // 10,000 unsplit × 4 = 40,000 → 0.04.
    expect(usageCost({ ...EMPTY_USAGE, unsplit: 10_000 }, opus!)).toBeCloseTo(0.04, 10);
  });

  it('validates an edited price table; a broken stored one reads as the examples', () => {
    expect(parsePriceTable({ currency: 'EUR', models: [{ match: 'opus', input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }] })).toEqual({
      ok: true,
      table: { currency: 'EUR', example: false, models: [{ match: 'opus', input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }] },
    });
    expect(parsePriceTable({ currency: '', models: [{ match: '', input: -1, output: 'x', cacheWrite: 0, cacheRead: 0 }] })).toMatchObject({
      ok: false,
      errors: [{ field: 'insights.prices.currency' }, { field: 'insights.prices.models[0].match' }, { field: 'insights.prices.models[0].input' }, { field: 'insights.prices.models[0].output' }],
    });
    expect(readPriceTable('nonsense')).toBe(EXAMPLE_PRICES);
    expect(EXAMPLE_PRICES.example).toBe(true);
  });

  it('median and buckets', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect([0.49, 0.5, 0.99, 1, 1.99, 2, 9].map(accuracyBucket)).toEqual(['under-half', 'half-to-one', 'half-to-one', 'one-to-two', 'one-to-two', 'over-two', 'over-two']);
  });
});

describe('D108 · the answer on the fixture world', () => {
  const answer = buildInsights(input());

  it('time and tokens: totals, per folder / session / model, the trend, chats apart', () => {
    // Sessions only, in the period: 4 + 6 + 2 turns; 40k + 12k + 20k tokens; 240 + 120 + 60 s.
    expect(answer.time.totals).toEqual({ turns: 12, tokens: 72_000, durationMs: 420_000, tokensPerTurn: 6_000, sessions: 2 });
    expect(answer.time.byFolder).toEqual([
      { key: '/work/acme', label: 'acme', turns: 6, tokens: 60_000, durationMs: 300_000, tokensPerTurn: 10_000 },
      { key: '/work/docs', label: 'docs', turns: 6, tokens: 12_000, durationMs: 120_000, tokensPerTurn: 2_000 },
    ]);
    expect(answer.time.bySession.map((row) => [row.label, row.tokens])).toEqual([
      ['Acme upload', 60_000],
      ['Docs', 12_000],
    ]);
    expect(answer.time.byModel.map((row) => [row.key, row.turns, row.tokensPerTurn])).toEqual([
      [OPUS, 6, 10_000],
      [HAIKU, 6, 2_000],
    ]);
    // 7 days; 10-12: 40k / 4; 10-13: 32k / 8; the rest empty.
    expect(answer.time.trend.map((p) => [p.day, p.turns, p.tokensPerTurn])).toEqual([
      ['2026-10-08', 0, null],
      ['2026-10-09', 0, null],
      ['2026-10-10', 0, null],
      ['2026-10-11', 0, null],
      ['2026-10-12', 4, 10_000],
      ['2026-10-13', 8, 4_000],
      ['2026-10-14', 0, null],
    ]);
    expect(answer.time.chats).toEqual({ turns: 3, tokens: 3_000, durationMs: 30_000 });
  });

  it('estimate accuracy: buckets and medians, overall and per model', () => {
    // Ratios 0.5, 1.5, 2.5, 0.4, 1.0, 0.6 → sorted 0.4 0.5 0.6 | 1.0 1.5 2.5 → median (0.6 + 1.0) / 2 = 0.8.
    expect(answer.estimates.count).toBe(6);
    expect(answer.estimates.median).toBeCloseTo(0.8, 10);
    expect(answer.estimates.buckets.map((b) => [b.key, b.count])).toEqual([
      ['under-half', 1],
      ['half-to-one', 2],
      ['one-to-two', 2],
      ['over-two', 1],
    ]);
    const opus = answer.estimates.byModel.find((g) => g.key === OPUS);
    const haiku = answer.estimates.byModel.find((g) => g.key === HAIKU);
    expect(opus?.median).toBeCloseTo(1.5, 10);
    expect(haiku?.median).toBeCloseTo(0.6, 10);
    expect(answer.estimates.byFolder.map((g) => [g.label, g.count])).toEqual([
      ['acme', 3],
      ['docs', 3],
    ]);
  });

  it('outcomes and rework per model', () => {
    const opus = answer.outcomes.byModel.find((row) => row.model === OPUS);
    const haiku = answer.outcomes.byModel.find((row) => row.model === HAIKU);
    expect(answer.outcomes.plansOn).toBe(true);
    // Opus: t1, t2, t3, u2 done; t2 reopened → 1 / 4.
    expect(opus?.todos).toEqual({ done: 4, reopened: 1, reopenRate: 0.25 });
    // Plans: 2 merged, 1 failed → 2 / 3; decisions: 1 merged, 2 sent back → 2 / 3.
    expect(opus?.plans).toEqual({ merged: 2, failed: 1, blocked: 0, mergeRate: 2 / 3, decisions: { merged: 1, sentBack: 2, failed: 0 }, sendBackRate: 2 / 3 });
    // Reverts: 6 turns, 2 reverts, 1 Redo → (2 − 1) / 6 × 100.
    expect(opus?.reverts.turns).toBe(6);
    expect(opus?.reverts.per100Turns).toBeCloseTo(100 / 6, 10);
    expect(haiku?.todos).toEqual({ done: 3, reopened: 0, reopenRate: 0 });
    expect(haiku?.plans).toMatchObject({ merged: 1, blocked: 1, mergeRate: 0.5, sendBackRate: null });
    expect(haiku?.reverts).toEqual({ turns: 6, reverts: 0, redos: 0, per100Turns: 0 });
    // Plans off: no plan part at all.
    expect(buildInsights(input({ plans: null })).outcomes.byModel.every((row) => row.plans === null)).toBe(true);
  });

  it('cost per todo: totals, median, lower bound, the most expensive first', () => {
    // Opus 3 × 0.344 + Haiku 3 × 0.0096 (100 + 5,000 + 2,500 + 2,000 = 9,600 → 0.0096) + u2 0.04 = 1.1008; u1 unpriced.
    expect(answer.cost.todos).toBe(8);
    expect(answer.cost.priced).toBe(7);
    expect(answer.cost.total).toBeCloseTo(1.1008, 10);
    expect(answer.cost.average).toBeCloseTo(1.1008 / 7, 10);
    // 0.0096 ×3, 0.04, 0.344 ×3 → the 4th of 7.
    expect(answer.cost.median).toBeCloseTo(0.04, 10);
    expect(answer.cost.lowerBound).toBe(true);
    expect(answer.cost.example).toBe(true);
    expect(answer.cost.currency).toBe('USD');
    expect(answer.cost.top.slice(0, 3).map((c) => [c.todoId, Number(c.cost?.toFixed(4))])).toEqual([
      ['t1', 0.344],
      ['t2', 0.344],
      ['t3', 0.344],
    ]);
    expect(answer.cost.byModel.find((row) => row.model === 'mystery-model')).toMatchObject({ todos: 1, priced: 0, total: 0, median: null });
  });

  it('usage forecast per account', () => {
    const work = answer.forecast.find((f) => f.profileId === 'default-claude');
    // 5 h: 20 → 30 → 40 % over an hour = 20 %/h; full at 12:00 + 60 / 20 h = 15:00, after the 14:00 reset → holds at 40 + 2 × 20 = 80 %.
    expect(work?.windows[0]).toEqual({ window: 'five_hour', pct: 40, resetsAt: FIVE_RESET, pctPerHour: 20, readings: 3, verdict: 'holds', fullAt: null, atReset: 80 });
    // Week: 38 → 50 → 62 % over 24 h = 1 %/h; full at 12:00 + 38 h = 16 Oct 02:00, before the 14:00 reset.
    expect(work?.windows[1]).toMatchObject({ window: 'seven_day', pct: 62, pctPerHour: 1, readings: 3, verdict: 'fills', fullAt: '2026-10-16T02:00:00.000Z' });
    expect(work?.credits).toBe('€12.40 left of €50');
    const priv = answer.forecast.find((f) => f.profileId === 'p2');
    expect(priv?.windows.map((w) => [w.verdict, w.readings])).toEqual([
      ['unknown', 1],
      ['unknown', 1],
    ]);
  });

  it('forecast edge cases: full, flat, a reset in the past', () => {
    const r = (at: string, pct: number, reset = FIVE_RESET): InsightReading => reading(at, [pct, reset], null);
    expect(windowForecast([r('2026-10-14T11:00:00.000Z', 100)], 'five_hour', NOW).verdict).toBe('full');
    expect(windowForecast([r('2026-10-14T11:00:00.000Z', 50), r('2026-10-14T11:50:00.000Z', 50)], 'five_hour', NOW)).toMatchObject({ verdict: 'flat', pctPerHour: 0, atReset: 50 });
    expect(windowForecast([r('2026-10-14T11:00:00.000Z', 50, '2026-10-14T11:30:00.000Z')], 'five_hour', NOW).verdict).toBe('unknown');
    // Two readings only 5 minutes apart: too short a span.
    expect(windowForecast([r('2026-10-14T11:55:00.000Z', 50), r('2026-10-14T12:00:00.000Z', 52)], 'five_hour', NOW)).toMatchObject({ verdict: 'unknown', readings: 2 });
  });

  it('suggested routing rules: Haiku over Opus for low-priority todos ≤ 30 min', () => {
    // Haiku median 0.0096, Opus median 0.344 → share 0.0279 → "1/36"; Haiku 0 / 3 reopened ≤ Opus 1 / 3.
    expect(answer.suggestions).toEqual([
      {
        id: `low|at-most|${HAIKU}`,
        text: `${HAIKU} finished 3 low-priority todos estimated ≤ 30 min with 0 reopened, at 1/36 the cost of ${OPUS} (3 todos, 1 reopened).`,
        evidence: { cheap: { model: HAIKU, todos: 3, reopened: 0, medianCost: expect.closeTo(0.0096, 10) }, expensive: { model: OPUS, todos: 3, reopened: 1, medianCost: expect.closeTo(0.344, 10) }, currency: 'USD' },
        rule: { priority: 'low', estimate: { kind: 'at-most', minutes: 30 }, provider: 'claude', model: HAIKU },
      },
    ]);
    // A cheaper model that was reopened more often is never suggested.
    const reworked = TODOS.map((t) => (t.model === HAIKU ? { ...t, reopens: 1 } : t));
    expect(buildInsights(input({ todos: reworked })).suggestions).toEqual([]);
  });

  it('filters scope every section; the options come from the whole period', () => {
    const haiku = buildInsights(input({ query: query({ model: HAIKU }) }));
    expect(haiku.time.totals).toMatchObject({ turns: 6, tokens: 12_000 });
    expect(haiku.cost.todos).toBe(3);
    expect(haiku.options.models).toEqual([OPUS, HAIKU, 'mystery-model'].sort());
    const docs = buildInsights(input({ query: query({ folder: '/work/docs' }) }));
    expect(docs.time.byFolder.map((row) => row.key)).toEqual(['/work/docs']);
    const p2 = buildInsights(input({ query: query({ account: 'p2' }) }));
    expect(p2.forecast.map((f) => f.profileId)).toEqual(['p2']);
    expect(p2.options.accounts).toEqual([
      { id: 'default-claude', name: 'Work' },
      { id: 'p2', name: 'Private' },
    ]);
  });
});
