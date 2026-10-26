import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UsageAnswer, UsageRows } from '../../../src/core/usage-breakdown.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { openStore, storeFile, type Store } from '../../../src/server/db/store.ts';
import { UsageTurnsBackfill } from '../../../src/server/insights/turns-backfill.ts';
import { UsageService } from '../../../src/server/insights/usage.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D134 · `GET /api/insights/usage` (+ `/rows`) on a real app and store, with seeded per-turn data
 * across two accounts and their windows: alignment, ranking, groups, the subagent roll-up from
 * the CLI's cumulative `modelUsage`, the estimate, the log and its CSV, 422s; the per-turn
 * backfill of the last 8 days; a paired machine's rows merged.
 */

const PORT = 4677;
const HOST = `127.0.0.1:${PORT}`;
let tmp = '';
let store: Store;
let app: FastifyInstance;
let token = '';
const MIN = 60_000;

beforeEach(async () => {
  tmp = await makeTempDir('api-insights-usage');
  store = await openTempStore(path.join(tmp, 'data'));
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: path.join(tmp, 'data') }, platform: 'linux', home: tmp, cwd: tmp });
  app = await buildApp({ config: { ...base, port: PORT }, token, store, webRoot: tmp });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await store.close();
  await removeTempDir(tmp);
});

function call(method: InjectOptions['method'], url: string) {
  return app.inject({ method, url, headers: { host: HOST, cookie: `sb_token=${token}` } });
}

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number): string => new Date(Date.now() + ms).toISOString();

function result(output: number, model: string, modelTotals?: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }>) {
  return { type: 'result', subtype: 'success', isError: false, durationMs: 5_000, tokens: output + 100, usage: { input: 100, output, cacheWrite: 0, cacheRead: 5_000 }, model, ...(modelTotals ? { modelTotals } : {}) };
}

/**
 * Two accounts: the Default (5-hour window started 2 h ago, 50 % used) and "Acme Pro" (started
 * 30 min ago, 10 %). `acme` (Default) has two turns in its window (the second with a subagent)
 * and one 3 h ago (outside); `docs` (Pro) one turn 10 min ago and one 1 h ago (outside its window).
 */
async function seed(): Promise<{ acme: string; docs: string }> {
  const pro = await store.profiles.create({ cli: 'claude', name: 'Acme Pro', dir: '/tmp/acme-pro', builtin: false, enabled: true, shareSettings: false, exhaustedUntil: null, exhaustedWindow: null, exhaustedText: null } as Parameters<Store['profiles']['create']>[0]);
  await store.usage.add({ source: 'rate_limit_event', profileId: 'default-claude', fiveHourPct: 50, fiveHourResetsAt: ahead(3 * 3_600_000), sevenDayPct: 30, sevenDayResetsAt: ahead(3 * 86_400_000), raw: {} });
  await store.usage.add({ source: 'rate_limit_event', profileId: pro.id, fiveHourPct: 10, fiveHourResetsAt: ahead(4.5 * 3_600_000), sevenDayPct: 5, sevenDayResetsAt: ahead(6 * 86_400_000), raw: {} });
  const acme = await store.sessions.create({ name: 'acme', title: 'Acme upload', claudeSessionId: 'c-acme', root: '/work/acme', model: 'opus' } as Parameters<Store['sessions']['create']>[0]);
  const docs = await store.sessions.create({ name: 'docs', title: 'Acme docs', claudeSessionId: 'c-docs', root: '/work/docs', profileId: pro.id } as Parameters<Store['sessions']['create']>[0]);
  const opus = (input: number, output: number, cacheWrite: number, cacheRead: number) => ({ input, output, cacheWrite, cacheRead });
  // acme: the first turn ever (a fresh session), no agents: totals = its own usage.
  await store.events.append({ sessionId: acme.id, kind: 'ok', label: 'Done', ts: ago(180 * MIN), payload: result(900, 'claude-opus-5-5', { 'claude-opus-5-5': opus(100, 900, 0, 5_000) }) });
  await store.events.append({ sessionId: acme.id, kind: 'ok', label: 'Done', ts: ago(90 * MIN), payload: result(1_900, 'claude-opus-5-5', { 'claude-opus-5-5': opus(200, 2_800, 0, 10_000) }) });
  // A haiku subagent: 50 in / 3,000 out / 1,000 cache writes / 20,000 cache reads beyond the turn's own usage.
  await store.events.append({
    sessionId: acme.id,
    kind: 'ok',
    label: 'Done',
    ts: ago(20 * MIN),
    payload: result(2_900, 'claude-opus-5-5', { 'claude-opus-5-5': opus(300, 5_700, 0, 15_000), 'claude-haiku-4-5': opus(50, 3_000, 1_000, 20_000) }),
  });
  await store.events.append({ sessionId: docs.id, kind: 'ok', label: 'Done', ts: ago(60 * MIN), payload: result(9_900, 'claude-sonnet-4-5') });
  await store.events.append({ sessionId: docs.id, kind: 'ok', label: 'Done', ts: ago(10 * MIN), payload: result(4_900, 'claude-sonnet-4-5') });
  return { acme: acme.id, docs: docs.id };
}

describe('D134 · GET /api/insights/usage', () => {
  it('ranks the sessions of each account’s own 5-hour window, the subagent tokens rolled up', async () => {
    const { acme, docs } = await seed();
    const response = await call('GET', '/api/insights/usage?period=5h');
    expect(response.statusCode).toBe(200);
    const body = response.json<UsageAnswer>();
    expect(body.spans.map((s) => [s.name, s.pct])).toEqual([
      ['Default', 50],
      ['Acme Pro', 10],
    ]);
    // acme: 2 turns in the Default's window (2,000 + 3,000) + the subagent (4,050); docs: 1 turn (5,000).
    expect(body.rows.map((r) => [r.sessionId, r.total.tokens, r.turns])).toEqual([
      [acme, 2_000 + 3_000 + 4_050, 2],
      [docs, 5_000, 1],
    ]);
    const top = body.rows[0];
    expect(top?.agents).toMatchObject({ tokens: 4_050, cacheRead: 20_000 });
    expect(top?.models).toEqual(['claude-opus-5-5', 'claude-haiku-4-5']);
    expect(top?.share).toBeCloseTo(9_050 / 14_050);
    expect(top?.estimate).toBeNull();
    expect(body.totals).toMatchObject({ tokens: 14_050, turns: 3, sessions: 2, agentTokens: 4_050 });
    expect(body.log.rows.map((r) => r.sessionId)).toEqual([docs, acme, acme]);
    expect(body.machines.scope).toBe('all');
  });

  it('one account: its window, shares of its tokens, and the labelled estimate', async () => {
    const { acme } = await seed();
    const body = (await call('GET', '/api/insights/usage?period=5h&account=default-claude')).json<UsageAnswer>();
    expect(body.shareOf).toBe('account');
    expect(body.rows.map((r) => [r.sessionId, r.share])).toEqual([[acme, 1]]);
    expect(body.estimate).toEqual({ available: true, window: '5h', pct: 50 });
    expect(body.rows[0]?.estimate).toEqual({ pct: 50, window: '5h' });
  });

  it('groups, the week, the log of one group, paging and the CSV', async () => {
    const { acme } = await seed();
    const byModel = (await call('GET', '/api/insights/usage?period=week&groupBy=model')).json<UsageAnswer>();
    expect(byModel.rows.map((r) => r.key)).toEqual(['claude-sonnet-4-5', 'claude-opus-5-5', 'claude-haiku-4-5']);
    expect(byModel.totals.turns).toBe(5);
    const paged = (await call('GET', `/api/insights/usage?period=week&group=${acme}&groupBy=session&pageSize=2&page=1`)).json<UsageAnswer>();
    expect(paged.log).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(paged.log.rows).toHaveLength(1);
    const csv = await call('GET', '/api/insights/usage?period=week&format=csv');
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('switchboard-usage-week.csv');
    expect(csv.body.trim().split('\r\n')).toHaveLength(6);
  });

  it('refuses bad parameters (422)', async () => {
    const response = await call('GET', '/api/insights/usage?period=30d&groupBy=x&machine=m2&format=xml');
    expect(response.statusCode).toBe(422);
    expect(response.json<{ errors: Array<{ field: string }> }>().errors.map((e) => e.field)).toEqual(['period', 'groupBy', 'machine', 'format']);
    expect((await call('GET', `/api/insights/usage/rows?from=${ago(10 * 86_400_000)}&to=${ago(0)}`)).statusCode).toBe(422);
  });

  it('answers a machine’s rows (the peer pull)', async () => {
    await seed();
    const response = await call('GET', `/api/insights/usage/rows?from=${encodeURIComponent(ago(5 * 3_600_000))}&to=${encodeURIComponent(ago(0))}`);
    expect(response.statusCode).toBe(200);
    const rows = response.json<UsageRows>();
    expect(rows.turns).toHaveLength(5);
    expect(rows.accounts.map((a) => a.name)).toEqual(['Default', 'Acme Pro']);
    expect(Object.values(rows.sessionTitles).sort()).toEqual(['Acme docs', 'Acme upload']);
  });
});

describe('D134 · the per-turn backfill and a paired machine', () => {
  it('adds the turns of the last 8 days written before 0050, once', async () => {
    const dataDir = path.join(tmp, 'backfill');
    let s = await openTempStore(dataDir);
    const session = await s.sessions.create({ name: 'old', claudeSessionId: 'c-old', root: '/work/acme' } as Parameters<Store['sessions']['create']>[0]);
    await s.events.append({ sessionId: session.id, kind: 'ok', label: 'Done', ts: ago(10 * 86_400_000), payload: result(1_000, 'claude-opus-5-5') });
    await s.events.append({ sessionId: session.id, kind: 'ok', label: 'Done', ts: ago(2 * 86_400_000), payload: result(2_000, 'claude-opus-5-5') });
    await s.events.append({ sessionId: session.id, kind: 'text', label: 'hi', ts: ago(86_400_000), payload: { type: 'assistant-text', text: 'hi' } });
    await s.events.append({ sessionId: session.id, kind: 'ok', label: 'Done', ts: ago(3_600_000), payload: result(3_000, 'claude-opus-5-5') });
    // As if these were written before 0050.
    s.db.prepare('DELETE FROM insight_turns').run();
    s.db.prepare("UPDATE insight_state SET value = (SELECT CAST(MAX(id) AS TEXT) FROM events) WHERE key = 'turns.upto'").run();
    await s.close();
    s = await openStore(storeFile(dataDir));
    try {
      const backfill = new UsageTurnsBackfill(s, { batch: 1 });
      expect(backfill.progress().done).toBe(false);
      expect(backfill.runToEnd()).toEqual({ done: true, percent: 100 });
      expect(s.db.prepare('SELECT output_tokens FROM insight_turns ORDER BY event_id').all().map((r) => r['output_tokens'])).toEqual([2_000, 3_000]);
      // Again: nothing twice.
      expect(new UsageTurnsBackfill(s).runToEnd().done).toBe(true);
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM insight_turns').get()?.['n']).toBe(2);
    } finally {
      await s.close();
    }
  });

  it('merges a paired machine’s rows (identity-merged account, the computer per row)', async () => {
    await seed();
    const now = Date.now();
    const peerRows: UsageRows = {
      turns: [
        {
          eventId: 1,
          ts: new Date(now - 5 * MIN).toISOString(),
          sessionId: 'x1',
          provider: 'claude',
          model: 'claude-opus-5-5',
          profileId: 'p-studio',
          folder: '/work/acme',
          kind: 'session',
          usage: { input: 0, output: 20_000, cacheWrite: 0, cacheRead: 0, unsplit: 0 },
          agents: {},
          durationMs: 1,
        },
      ],
      accounts: [{ id: 'p-studio', cli: 'claude', name: 'Default', identity: 'claude:dev@acme.test', fiveHour: { pct: 55, resetsAt: new Date(now + 3 * 3_600_000).toISOString() }, week: null, receivedAt: new Date(now).toISOString() }],
      sessionTitles: { x1: 'Studio work' },
      sessionKinds: {},
      accountNames: { 'p-studio': 'Default' },
    };
    const service = new UsageService({
      store,
      backfill: { progress: () => ({ done: true, percent: 100 }) },
      accounts: {
        usageOf: async (record) => (record.id === 'default-claude' ? { fiveHourPct: 50, fiveHourResetsAt: new Date(now + 3 * 3_600_000).toISOString(), sevenDayPct: 30, sevenDayResetsAt: null, receivedAt: new Date(now - MIN).toISOString() } : null),
        identityOf: async (id) => (id === 'default-claude' ? 'claude:dev@acme.test' : null),
      },
      peers: {
        machines: async () => [{ id: 'm2', name: 'Studio', state: 'online' }] as never,
        fanOutGet: async () => [{ machine: { id: 'm2', name: 'Studio', state: 'online' }, body: JSON.parse(JSON.stringify(peerRows)), reason: null }] as never,
      },
    });
    const query = { period: '5h' as const, account: 'default-claude', groupBy: 'session' as const, from: null, group: null, page: 0, pageSize: 50 };
    const first = await service.answer(query, { scope: 'all', peers: 'cached' });
    expect(first.machines.pending.map((m) => m.name)).toEqual(['Studio']);
    const merged = await service.answer(query, { scope: 'all', peers: 'wait' });
    expect(merged.machines.included.map((m) => m.name)).toEqual(['This machine', 'Studio']);
    expect(merged.rows[0]).toMatchObject({ sessionId: 'r~m2~x1', label: 'Studio work (Studio)', machine: { id: 'm2', name: 'Studio' } });
    // The Studio reading is newer: its 55 % drives the estimate.
    expect(merged.estimate).toMatchObject({ available: true, pct: 55 });
  });
});
