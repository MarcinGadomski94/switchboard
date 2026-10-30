import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXAMPLE_PRICES, type InsightsAnswer, utcDay } from '../../../src/core/insights.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D108 · `GET /api/insights` (contract → *Insights (D108)*) on a real app and store: the one
 * answer, its filters, 422s, and the prices from Settings (`insights.prices`).
 */

const PORT = 4876;
const HOST = `127.0.0.1:${PORT}`;
let tmp = '';
let store: Store;
let app: FastifyInstance;
let token = '';

beforeEach(async () => {
  tmp = await makeTempDir('api-insights');
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

function call(method: InjectOptions['method'], url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

async function seed(): Promise<void> {
  const s = await store.sessions.create({ name: 'acme', claudeSessionId: 'c-acme', root: '/work/acme' } as Parameters<Store['sessions']['create']>[0]);
  const ts = new Date().toISOString();
  const result = (tokens: number, model: string) => ({ type: 'result', isError: false, durationMs: 10_000, tokens, usage: { input: 0, output: tokens, cacheWrite: 0, cacheRead: 0 }, model });
  await store.events.append({ sessionId: s.id, kind: 'ok', label: 'Done', ts, payload: result(1_000, 'claude-opus-5-5') });
  await store.events.append({ sessionId: s.id, kind: 'ok', label: 'Done', ts, payload: result(3_000, 'claude-opus-5-5') });
  await store.events.append({ sessionId: s.id, kind: 'ok', label: 'Done', ts, payload: result(500, 'claude-haiku-4-5') });
  store.db
    .prepare("INSERT INTO todo_actuals (todo_id, session_id, folder, title, estimate_minutes, actual_ms, actual_tokens, completed_at, priority, provider, model, profile_id, usage, working_ms, measure) VALUES ('t1', ?, '/work/acme', 'Docs', 10, 1200000, 1000000, ?, 'low', 'claude', 'claude-opus-5-5', 'default-claude', ?, 1200000, 'working')")
    .run(s.id, ts, JSON.stringify({ input: 0, output: 1_000_000, cacheWrite: 0, cacheRead: 0, unsplit: 0 }));
}

describe('D108 · GET /api/insights', () => {
  it('D147: the accuracy uses the working time; a row with open time only is left out and counted', async () => {
    await seed();
    const s = (await store.sessions.list())[0];
    store.db
      .prepare("INSERT INTO todo_actuals (todo_id, session_id, folder, title, estimate_minutes, actual_ms, actual_tokens, completed_at, priority, provider, model, profile_id) VALUES ('old', ?, '/work/acme', 'Old', 10, 36000000, NULL, ?, 'low', 'claude', 'claude-opus-5-5', 'default-claude')")
      .run(s?.id ?? '', new Date().toISOString());
    const body = (await call('GET', '/api/insights?period=7d')).json<InsightsAnswer>();
    expect(body.estimates).toMatchObject({ count: 1, median: 2, openOnly: 1 });
    expect(body.estimates.open).toMatchObject({ count: 2 });
  });

  it('answers the whole page in one response, filtered', async () => {
    await seed();
    const response = await call('GET', '/api/insights?period=7d');
    expect(response.statusCode).toBe(200);
    const body = response.json<InsightsAnswer>();
    expect(body.query).toMatchObject({ period: '7d', to: utcDay(new Date()) });
    expect(body.time.totals).toMatchObject({ turns: 3, tokens: 4_500, sessions: 1 });
    expect(body.time.byModel.map((row) => [row.key, row.turns])).toEqual([
      ['claude-opus-5-5', 2],
      ['claude-haiku-4-5', 1],
    ]);
    expect(body.time.trend).toHaveLength(7);
    expect(body.options.models).toEqual(['claude-haiku-4-5', 'claude-opus-5-5']);
    expect(body.estimates).toMatchObject({ count: 1, median: 2 });
    // 1M output tokens at the example Opus price (20 / 1M) = 20.
    expect(body.cost).toMatchObject({ currency: 'USD', example: true, todos: 1, priced: 1, total: 20 });
    // D132: Plans is always on.
    expect(body.outcomes.plansOn).toBe(true);
    expect(body.backfill.done).toBe(true);
    // The default account appears in the forecast (no readings: unknown).
    expect(body.forecast.map((f) => [f.profileId, f.windows.map((w) => w.verdict)])).toEqual([['default-claude', ['unknown', 'unknown']]]);

    const haiku = (await call('GET', '/api/insights?period=30d&model=claude-haiku-4-5')).json<InsightsAnswer>();
    expect(haiku.time.totals).toMatchObject({ turns: 1, tokens: 500 });
    expect(haiku.cost.todos).toBe(0);
  });

  it('422 for a bad parameter', async () => {
    const response = await call('GET', '/api/insights?period=1y');
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'invalid', errors: [{ field: 'period' }] });
    expect((await call('GET', '/api/insights?period=custom&from=2026-10-05')).statusCode).toBe(422);
  });

  it('prices come from Settings: edited prices are used and no longer marked as examples', async () => {
    await seed();
    const prices = { currency: 'EUR', models: [{ match: 'opus', input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }] };
    const put = await call('PUT', '/api/settings', { 'insights.prices': prices });
    expect(put.statusCode).toBe(200);
    expect(put.json()['insights.prices']).toEqual({ ...prices, example: false });
    const body = (await call('GET', '/api/insights?period=7d')).json<InsightsAnswer>();
    expect(body.cost).toMatchObject({ currency: 'EUR', example: false, total: 5 });
    // A broken table is refused as a whole.
    const bad = await call('PUT', '/api/settings', { 'insights.prices': { currency: 'EUR', models: [{ match: 'opus', input: -1, output: 5, cacheWrite: 0, cacheRead: 0 }] } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: 'invalid', errors: [{ field: 'insights.prices.models[0].input' }] });
    // Back to the examples.
    expect((await call('PUT', '/api/settings', { 'insights.prices': EXAMPLE_PRICES })).json()['insights.prices']).toEqual(EXAMPLE_PRICES);
  });
});
