import { describe, expect, it } from 'vitest';
import { EMPTY_USAGE, EXAMPLE_PRICES, type InsightsMachines } from '../../src/core/insights.ts';
import {
  type UsageAccountRow,
  type UsageQuery,
  type UsageRows,
  type UsageTurnRow,
  accountSpan,
  agentTokensOfTurn,
  buildUsage,
  chartBucketMs,
  mergeUsageRows,
  parseUsageQuery,
  readUsageRows,
  resultModelTotals,
  usageLogCsv,
  usageReadRange,
} from '../../src/core/usage-breakdown.ts';

/**
 * D134 · Usage breakdown (`docs/insights.md` → *Usage breakdown*): the windows per account,
 * ranking and grouping, the subagent roll-up, the shares and the "≈ % of the limit" estimate.
 */

const NOW = new Date('2026-10-26T12:00:00.000Z');
const at = (minutesAgo: number): string => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
const MACHINES: InsightsMachines = { scope: 'local', included: [{ id: null, name: 'This machine' }], pending: [], missing: [] };

function account(id: string, name: string, fiveResetInMin: number | null, fivePct: number | null, weekResetInMin: number | null = 3 * 24 * 60, weekPct: number | null = 40): UsageAccountRow {
  const reset = (min: number | null): string | null => (min === null ? null : new Date(NOW.getTime() + min * 60_000).toISOString());
  return { id, cli: 'claude', name, identity: `claude:${id}@acme.test`, fiveHour: fiveResetInMin === null ? null : { pct: fivePct, resetsAt: reset(fiveResetInMin) }, week: { pct: weekPct, resetsAt: reset(weekResetInMin) }, receivedAt: at(1) };
}

let nextId = 1;
function turn(sessionId: string, profileId: string, minutesAgo: number, output: number, opts: Partial<UsageTurnRow> = {}): UsageTurnRow {
  return {
    eventId: nextId++,
    ts: at(minutesAgo),
    sessionId,
    provider: 'claude',
    model: 'claude-opus-5-5',
    profileId,
    folder: '/work/acme',
    kind: 'session',
    usage: { ...EMPTY_USAGE, input: 100, output, cacheRead: 10_000 },
    agents: {},
    durationMs: 1_000,
    ...opts,
  };
}

function query(patch: Partial<UsageQuery> = {}): UsageQuery {
  return { period: '5h', account: null, groupBy: 'session', from: null, group: null, page: 0, pageSize: 50, ...patch };
}

// Account A: 5-hour window resets in 2 h (started 3 h ago), 60 % used. Account B: resets in 4 h (started 1 h ago), 20 %.
const ROWS: UsageRows = {
  turns: [
    turn('s1', 'a', 30, 9_900), // A, in window: 10k
    turn('s1', 'a', 200, 4_900), // A, 200 min ago: in A's window (started 180 min ago)? no: outside
    turn('s2', 'a', 60, 4_900, { model: 'claude-haiku-4-5', agents: { 'claude-haiku-4-5': { input: 0, output: 5_000, cacheWrite: 0, cacheRead: 2_000 } } }), // A: 5k own + 5k agents
    turn('s3', 'b', 30, 19_900, { kind: 'chat' }), // B, in window: 20k
    turn('s3', 'b', 90, 9_900, { kind: 'chat' }), // B, 90 min ago: outside B's window (started 60 min ago)
  ],
  accounts: [account('a', 'Acme Max', 120, 60), account('b', 'Acme Pro', 240, 20)],
  sessionTitles: { s1: 'Upload flow', s2: 'Docs', s3: 'Ask about acme' },
  sessionKinds: { s3: 'conversation' },
  accountNames: { a: 'Acme Max', b: 'Acme Pro' },
};

describe('D134 · window alignment per account', () => {
  it('runs each window from its reset minus its length to now', () => {
    expect(accountSpan(account('a', 'A', 120, 60), '5h', NOW)).toMatchObject({ start: at(180), end: NOW.toISOString(), pct: 60, sinceReset: false });
    expect(accountSpan(account('a', 'A', 120, 60, 24 * 60, 33), 'week', NOW)).toMatchObject({ start: at(6 * 24 * 60), pct: 33 });
  });

  it('a passed reset counts from the reset (at most one window back), marked, without a %', () => {
    expect(accountSpan(account('a', 'A', -30, 90), '5h', NOW)).toMatchObject({ start: at(30), pct: null, sinceReset: true });
    expect(accountSpan(account('a', 'A', -600, 90), '5h', NOW)).toMatchObject({ start: at(300), sinceReset: true });
  });

  it('no reading → no window; today and 7 days are the same for everyone', () => {
    expect(accountSpan(account('a', 'A', null, null), '5h', NOW)).toBeNull();
    expect(accountSpan(null, 'today', NOW, '2026-10-25T22:00:00.000Z')).toMatchObject({ start: '2026-10-25T22:00:00.000Z' });
    expect(accountSpan(null, 'today', NOW)).toMatchObject({ start: '2026-10-26T00:00:00.000Z' });
    expect(accountSpan(null, '7d', NOW)).toMatchObject({ start: at(7 * 24 * 60) });
    expect(usageReadRange({ period: '5h', from: null }, NOW)).toEqual({ from: at(300), to: NOW.toISOString() });
  });

  it('filters each turn by its own account’s window', () => {
    const answer = buildUsage({ query: query(), now: NOW, rows: ROWS, prices: EXAMPLE_PRICES, machines: MACHINES, backfill: { done: true, percent: 100 } });
    expect(answer.spans.map((s) => [s.accountId, s.start])).toEqual([
      ['a', at(180)],
      ['b', at(60)],
    ]);
    expect(answer.totals.turns).toBe(3);
    expect(answer.totals.tokens).toBe(10_000 + 10_000 + 20_000);
    expect(answer.totals.cacheRead).toBe(30_000 + 2_000);
  });

  it('an account without a reading is named, not guessed', () => {
    const rows = { ...ROWS, accounts: [...ROWS.accounts, account('c', 'Acme Team', null, null)] };
    const answer = buildUsage({ query: query(), now: NOW, rows, prices: EXAMPLE_PRICES, machines: MACHINES, backfill: { done: true, percent: 100 } });
    expect(answer.unknownWindows).toEqual(['Acme Team']);
  });
});

describe('D134 · ranking, grouping and shares', () => {
  const build = (patch: Partial<UsageQuery>) => buildUsage({ query: query(patch), now: NOW, rows: ROWS, prices: EXAMPLE_PRICES, machines: MACHINES, backfill: { done: true, percent: 100 } });

  it('ranks sessions by tokens (cache reads apart) with shares of every recorded token', () => {
    const answer = build({});
    expect(answer.rows.map((r) => [r.label, r.total.tokens, r.share, r.turns])).toEqual([
      ['Ask about acme', 20_000, 0.5, 1],
      ['Docs', 10_000, 0.25, 1],
      ['Upload flow', 10_000, 0.25, 1],
    ]);
    expect(answer.shareOf).toBe('all');
    expect(answer.rows[0]).toMatchObject({ kind: 'conversation', sessionId: 's3', machine: { id: null } });
    expect(answer.rows.reduce((sum, r) => sum + r.share, 0)).toBeCloseTo(1);
  });

  it('groups by model (own replies and agents each to their model), account and kind', () => {
    expect(build({ groupBy: 'model' }).rows.map((r) => [r.key, r.total.tokens, r.turns])).toEqual([
      ['claude-opus-5-5', 30_000, 2],
      ['claude-haiku-4-5', 10_000, 1],
    ]);
    expect(build({ groupBy: 'account' }).rows.map((r) => [r.label, r.total.tokens])).toEqual([
      ['Acme Max', 20_000],
      ['Acme Pro', 20_000],
    ]);
    expect(build({ groupBy: 'kind' }).rows.map((r) => [r.label, r.total.tokens])).toEqual([
      ['Agent', 20_000],
      ['Conversation', 20_000],
    ]);
    expect(build({ groupBy: 'folder' }).rows.map((r) => [r.label, r.turns])).toEqual([['acme', 3]]);
  });

  it('one account: its window only, shares of its tokens', () => {
    const answer = build({ account: 'a' });
    expect(answer.shareOf).toBe('account');
    expect(answer.rows.map((r) => [r.label, r.share])).toEqual([
      ['Docs', 0.5],
      ['Upload flow', 0.5],
    ]);
  });

  it('costs at the Insights prices, per model', () => {
    const docs = build({}).rows.find((r) => r.key === 's2');
    // Haiku example prices: 0.10 in / 0.50 out / 0.01 cache read per 1M.
    const expected = (100 * 0.1 + 9_900 * 0.5 + 12_000 * 0.01) / 1_000_000;
    expect(docs?.cost).toBeCloseTo(expected, 10);
    expect(docs?.costPartial).toBe(false);
  });

  it('the stacked chart: top groups plus everything else, per bucket', () => {
    const answer = build({});
    expect(answer.chart.bucketMs).toBe(chartBucketMs(180 * 60_000));
    expect(answer.chart.series.map((s) => s.label)).toEqual(['Ask about acme', 'Docs', 'Upload flow']);
    expect(answer.chart.series.flatMap((s) => s.values).reduce((a, b) => a + b, 0)).toBe(40_000);
  });

  it('the log: newest first, of one group when asked, paged', () => {
    const all = build({ pageSize: 2 });
    expect(all.log.total).toBe(3);
    // Same time: the later turn (higher event id) first.
    expect(all.log.rows.map((r) => r.title)).toEqual(['Ask about acme', 'Upload flow']);
    expect(build({ pageSize: 2, page: 1 }).log.rows.map((r) => r.title)).toEqual(['Docs']);
    // Past the last page: the last page.
    expect(build({ pageSize: 2, page: 9 }).log.page).toBe(1);
    expect(build({ group: 's2' }).log.rows.map((r) => r.title)).toEqual(['Docs']);
    expect(build({ groupBy: 'model', group: 'claude-haiku-4-5' }).log.total).toBe(1);
    const csv = usageLogCsv(all.log.rows);
    expect(csv.split('\r\n')[0]).toBe('time,session,kind,models,input,output,cache_write,cache_read,unsplit,tokens,agent_tokens,account,computer,folder');
    expect(csv).toContain(',Ask about acme,conversation,claude-opus-5-5,100,19900,0,10000,0,20000,0,Acme Pro,This machine,/work/acme');
  });
});

describe('D134 · subagent roll-up', () => {
  it('the agents’ tokens count towards their session, with the per-model breakdown', () => {
    const answer = buildUsage({ query: query(), now: NOW, rows: ROWS, prices: EXAMPLE_PRICES, machines: MACHINES, backfill: { done: true, percent: 100 } });
    const docs = answer.rows.find((r) => r.key === 's2');
    expect(docs?.total.tokens).toBe(10_000);
    expect(docs?.agents).toMatchObject({ tokens: 5_000, cacheRead: 2_000 });
    expect(docs?.agentModels).toEqual([{ model: 'claude-haiku-4-5', tokens: 5_000, cacheRead: 2_000 }]);
    expect(answer.totals.agentTokens).toBe(5_000);
  });

  it('reads the CLI’s cumulative modelUsage (canonical names)', () => {
    const raw = { modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 36, outputTokens: 651, cacheReadInputTokens: 104_975, cacheCreationInputTokens: 32_244, canonicalModel: 'claude-haiku-4-5' }, empty: { contextWindow: 200_000 } } };
    expect(resultModelTotals(raw)).toEqual({ 'claude-haiku-4-5': { input: 36, output: 651, cacheWrite: 32_244, cacheRead: 104_975 } });
    expect(resultModelTotals({ modelUsage: { 'gpt-5': { contextWindow: 1 } } })).toBeNull();
  });

  // The figures of a real Claude Code turn with one subagent (`.spike/raw/subagent.ndjson`).
  const own = { input: 18, output: 343, cacheWrite: 32_244, cacheRead: 66_682 };
  const first = { 'claude-haiku-4-5': { input: 36, output: 651, cacheWrite: 32_244 + 2_269, cacheRead: 104_975 } };

  it('a fresh session’s first turn: everything beyond its own usage is its agents’', () => {
    expect(agentTokensOfTurn(first, null, own, 'claude-haiku-4-5', true)).toEqual({ 'claude-haiku-4-5': { input: 18, output: 308, cacheWrite: 2_269, cacheRead: 38_293 } });
  });

  it('no baseline and not fresh (a resumed or older session): nothing is attributed (never over-counts)', () => {
    expect(agentTokensOfTurn(first, null, own, 'claude-haiku-4-5', false)).toEqual({});
  });

  it('the growth since the previous turn minus the turn’s own usage; nothing without agents', () => {
    const next = { 'claude-haiku-4-5': { input: 36 + 10, output: 651 + 144, cacheWrite: 34_513 + 570, cacheRead: 104_975 + 48_970 } };
    expect(agentTokensOfTurn(next, first, { input: 10, output: 144, cacheWrite: 570, cacheRead: 48_970 }, 'claude-haiku-4-5', false)).toEqual({});
    // A subagent on another model shows up under that model.
    const withSonnet = { ...next, 'claude-sonnet-4-5': { input: 5, output: 500, cacheWrite: 1_000, cacheRead: 9_000 } };
    expect(agentTokensOfTurn(withSonnet, first, { input: 10, output: 144, cacheWrite: 570, cacheRead: 48_970 }, 'claude-haiku-4-5', false)).toEqual({ 'claude-sonnet-4-5': { input: 5, output: 500, cacheWrite: 1_000, cacheRead: 9_000 } });
  });

  it('a total that went down (the CLI counted afresh) counts from zero', () => {
    const restarted = { 'claude-haiku-4-5': { input: 20, output: 400, cacheWrite: 1_000, cacheRead: 20_000 } };
    expect(agentTokensOfTurn(restarted, first, { input: 10, output: 100, cacheWrite: 500, cacheRead: 10_000 }, 'claude-haiku-4-5', false)).toEqual({ 'claude-haiku-4-5': { input: 10, output: 300, cacheWrite: 500, cacheRead: 10_000 } });
  });
});

describe('D134 · the estimate', () => {
  it('only for one account in its own window: share × the window’s %', () => {
    const one = buildUsage({ query: query({ account: 'a' }), now: NOW, rows: ROWS, prices: EXAMPLE_PRICES, machines: MACHINES, backfill: { done: true, percent: 100 } });
    expect(one.estimate).toEqual({ available: true, window: '5h', pct: 60 });
    expect(one.rows.map((r) => r.estimate)).toEqual([
      { pct: 30, window: '5h' },
      { pct: 30, window: '5h' },
    ]);
    const week = buildUsage({ query: query({ account: 'a', period: 'week' }), now: NOW, rows: ROWS, prices: EXAMPLE_PRICES, machines: MACHINES, backfill: { done: true, percent: 100 } });
    expect(week.estimate).toMatchObject({ available: true, window: 'week', pct: 40 });
  });

  it('never across accounts, for today / 7 days, or once the window reset without a newer reading', () => {
    const base = { now: NOW, prices: EXAMPLE_PRICES, machines: MACHINES, backfill: { done: true, percent: 100 } };
    expect(buildUsage({ ...base, query: query(), rows: ROWS }).rows.every((r) => r.estimate === null)).toBe(true);
    expect(buildUsage({ ...base, query: query({ account: 'a', period: 'today' }), rows: ROWS }).estimate.available).toBe(false);
    const stale = { ...ROWS, accounts: [account('a', 'Acme Max', -10, 95)] };
    const answer = buildUsage({ ...base, query: query({ account: 'a' }), rows: stale });
    expect(answer.estimate.available).toBe(false);
    expect(answer.spans[0]?.sinceReset).toBe(true);
  });
});

describe('D134 · the query and merged machines', () => {
  it('parses and refuses', () => {
    expect(parseUsageQuery({}, NOW)).toEqual({ ok: true, query: query() });
    expect(parseUsageQuery({ period: 'today', from: '2026-10-25T22:00:00.000Z', groupBy: 'kind', page: '2', pageSize: '20' }, NOW)).toMatchObject({ ok: true, query: { period: 'today', groupBy: 'kind', from: '2026-10-25T22:00:00.000Z', page: 2, pageSize: 20 } });
    const bad = parseUsageQuery({ period: '30d', groupBy: 'colour', from: '2026-10-20T00:00:00Z', pageSize: '999' }, NOW);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.map((e) => e.field)).toEqual(['period', 'groupBy', 'from', 'pageSize']);
  });

  it('merges a paired machine: namespaced sessions, identity-merged accounts (newest window wins), the computer per row', () => {
    const peer: UsageRows = {
      turns: [{ ...turn('x1', 'pa', 20, 4_900), folder: '/work/acme' }],
      accounts: [{ ...account('pa', 'Max', 60, 75), identity: 'claude:a@acme.test', receivedAt: NOW.toISOString() }],
      sessionTitles: { x1: 'Studio work' },
      sessionKinds: { x1: 'plan' },
      accountNames: { pa: 'Max' },
    };
    const merged = mergeUsageRows([
      { machine: { id: null, name: 'This machine' }, rows: ROWS },
      { machine: { id: 'm2', name: 'Studio' }, rows: readUsageRows(JSON.parse(JSON.stringify(peer))) as UsageRows },
    ]);
    expect(merged.rows.accounts.map((a) => [a.id, a.fiveHour?.pct])).toEqual([
      ['a', 75],
      ['b', 20],
    ]);
    const remote = merged.rows.turns.find((t) => t.sessionId === 'r~m2~x1');
    expect(remote).toMatchObject({ profileId: 'a', folder: '/work/acme@@m2' });
    expect(merged.machineOf('r~m2~x1')).toEqual({ id: 'm2', name: 'Studio' });
    expect(merged.machineOf('s1')).toEqual({ id: null, name: 'This machine' });
    expect(merged.folderLabels.get('/work/acme@@m2')).toBe('acme · Studio');
    const answer = buildUsage({ query: query({ account: 'a' }), now: NOW, rows: merged.rows, machineOf: merged.machineOf, folderLabels: merged.folderLabels, prices: EXAMPLE_PRICES, machines: MACHINES, backfill: { done: true, percent: 100 } });
    const studio = answer.rows.find((r) => r.sessionId === 'r~m2~x1');
    expect(studio).toMatchObject({ label: 'Studio work (Studio)', kind: 'plan', machine: { id: 'm2', name: 'Studio' } });
    // The window comes from the newer reading (Studio's: resets in 60 min → started 240 min ago).
    expect(answer.spans[0]?.start).toBe(at(240));
  });
});
