/**
 * `node tools/bench/insights.ts [--runs <n>] [--todos <n>] [--out <file.json>]`: D108's Insights
 * benchmark (`docs/insights.md` → *Performance*) on the D95 bench world
 * (`tools/bench/world.ts`: ≈31,800 events in 5 sessions, 2,000 usage readings), plus `--todos`
 * completed todos (default 400) spread over 90 days. The world is made to look like an
 * **upgrade**: its events are written before the rollup existed (0045's boundary moved to the
 * newest event, nothing rolled up), so the rollup fills through the startup backfill. Test
 * port (`SWITCHBOARD_TEST_PORTS`), throwaway data, fake CLIs only.
 *
 * Measures:
 * 1. **during the backfill**: `GET /api/insights?period=30d` while it runs (p50 / p95), and
 *    the wall time until `backfill.done`;
 * 2. **cold**: each query's first answer once the rollup is full (computed, not cached);
 * 3. **warm**: the same queries `--runs` times (the 30 s cache);
 * 4. **recomputed**: each query after a price change (the cache's stamp changes, so the answer is
 *    computed again), up to 10 times.
 */
import { parseArgs } from 'node:util';
import { EXAMPLE_PRICES, type InsightsAnswer } from '../../src/core/insights.ts';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { transaction } from '../../src/server/db/database.ts';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import { removeTempDir } from '../../tests/helpers/net.ts';
import { startServer } from '../../tests/helpers/server-process.ts';
import globalSetup from '../../tests/e2e/global-setup.ts';
import { chromium } from '@playwright/test';
import { type BenchClient, clientFor, makeBenchWorld } from './server.ts';

function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return Number((sorted[at] ?? 0).toFixed(1));
}

function stats(values: readonly number[]): { p50: number; p95: number; max: number; n: number } {
  return { p50: quantile(values, 0.5), p95: quantile(values, 0.95), max: quantile(values, 1), n: values.length };
}

const QUERIES: ReadonlyArray<readonly [string, string]> = [
  ['7 days', 'period=7d'],
  ['30 days', 'period=30d'],
  ['90 days', 'period=90d'],
  ['90 days, one model', 'period=90d&model=claude-haiku-4-5'],
  ['custom 60 days', 'period=custom&from=2026-08-01&to=2026-09-29'],
];

/** Adds `count` completed todos over the last 90 days (three models, priorities, estimates, splits). */
async function seedTodos(dataDir: string, sessionIds: readonly string[], count: number): Promise<void> {
  const store = await openStore(storeFile(dataDir));
  try {
    const models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'];
    const priorities = ['urgent', 'high', 'medium', 'low'];
    const insert = store.db.prepare(
      `INSERT INTO todo_actuals (todo_id, session_id, folder, title, estimate_minutes, actual_ms, actual_tokens, completed_at, run_session_id, priority, provider, model, profile_id, usage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'claude', ?, 'default-claude', ?)`,
    );
    const reopen = store.db.prepare('INSERT INTO todo_reopens (todo_id, session_id, reopened_at) VALUES (?, ?, ?)');
    const now = Date.now();
    transaction(store.db, () => {
      for (let i = 0; i < count; i += 1) {
        const session = sessionIds[i % sessionIds.length] as string;
        const estimate = [10, 20, 30, 45, 60, 90][i % 6] as number;
        const actualMs = Math.round(estimate * 60_000 * (0.3 + ((i * 37) % 100) / 40));
        const output = 2_000 + ((i * 131) % 20_000);
        const usage = { input: 500 + (i % 50), output, cacheWrite: 10_000 + ((i * 17) % 30_000), cacheRead: 100_000 + ((i * 7) % 400_000), unsplit: 0 };
        const at = new Date(now - ((i * 7_919_000) % (89 * 86_400_000))).toISOString();
        insert.run(`bench-todo-${i}`, session, null, `Bench todo ${i}`, estimate, actualMs, usage.input + usage.output + usage.cacheWrite, at, priorities[i % 4] as string, models[i % 3] as string, JSON.stringify(usage));
        if (i % 9 === 0) reopen.run(`bench-todo-${i}`, session, at);
      }
    });
    // The upgrade: every event is older than the rollup (0045's boundary at the newest one, nothing rolled up yet).
    const max = Number(store.db.prepare('SELECT MAX(id) AS n FROM events').get()?.['n'] ?? 0);
    store.db.exec('DELETE FROM insight_turns_daily');
    store.db.prepare("UPDATE insight_state SET value = ? WHERE key = 'events.upto'").run(String(max));
    store.db.prepare("UPDATE insight_state SET value = '0' WHERE key = 'events.done'").run();
  } finally {
    await store.close();
  }
}

/** `PUT /api/settings` (the bench client has GET / POST only). */
async function putSettings(client: BenchClient, token: string, body: unknown): Promise<void> {
  const response = await fetch(`${client.baseUrl}/api/settings`, { method: 'PUT', headers: { cookie: `sb_token=${token}`, origin: client.baseUrl, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`PUT /api/settings: HTTP ${response.status}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { runs: { type: 'string', default: '30' }, todos: { type: 'string', default: '400' }, out: { type: 'string' }, browser: { type: 'boolean', default: false }, 'no-build': { type: 'boolean', default: false } } });
  if (values.browser && !values['no-build']) await globalSetup();
  const runs = Math.max(1, Number(values.runs));
  const world = await makeBenchWorld('bench-insights');
  const events = [...world.sizes.values()].reduce((sum, size) => sum + size.events, 0);
  await seedTodos(world.dataDir, [world.bigSessionId, ...world.mediumSessionIds], Number(values.todos));
  console.log(`world: ${events} events in ${world.sizes.size} sessions, ${values.todos} completed todos`);
  const report: Record<string, unknown> = { events, todos: Number(values.todos) };
  const started = performance.now();
  const server = await startServer(world.env, 60_000);
  try {
    const client: BenchClient = await clientFor(world, server);
    const token = (await readFile(path.join(world.dataDir, 'sb_token'), 'utf8')).trim();
    report['startMs'] = Number((performance.now() - started).toFixed(0));

    // 1 · During the backfill.
    const during: number[] = [];
    const backfillStart = performance.now();
    let done = false;
    let percent = 0;
    while (!done && performance.now() - backfillStart < 300_000) {
      const answer = await client.get('/api/insights?period=30d');
      if (answer.status !== 200) throw new Error(`HTTP ${answer.status}: ${JSON.stringify(answer.body)}`);
      during.push(answer.ms);
      const body = answer.body as InsightsAnswer;
      done = body.backfill.done;
      percent = body.backfill.percent;
      if (!done) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const backfillMs = performance.now() - backfillStart;
    report['backfill'] = { wallMs: Number(backfillMs.toFixed(0)), done, percent, requestsDuring: stats(during) };
    console.log(`backfill: ${done ? 'done' : `not done (${percent}%)`} ${backfillMs.toFixed(0)} ms after the server answered (its 2 s start delay included); /api/insights meanwhile ${JSON.stringify(stats(during))}`);

    // D97's search backfill runs at startup too: measure once it is finished, so the numbers are Insights' own.
    for (let i = 0; i < 600; i += 1) {
      const search = await client.get('/api/search?q=upload&limit=1');
      if ((search.body as { indexing?: { done?: boolean } }).indexing?.done === true) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const rows: Record<string, unknown> = {};
    const cold: number[] = [];
    const warm: number[] = [];
    const recomputed: number[] = [];
    let bump = 0;
    for (const [label, query] of QUERIES) {
      const first = await client.get(`/api/insights?${query}`);
      if (first.status !== 200) throw new Error(`${query}: HTTP ${first.status}`);
      cold.push(first.ms);
      const body = first.body as InsightsAnswer;
      const warmTimes: number[] = [];
      for (let i = 0; i < runs; i += 1) warmTimes.push((await client.get(`/api/insights?${query}`)).ms);
      warm.push(...warmTimes);
      // Recompute: a changed price table changes the cache's stamp, so each call computes the answer again.
      const again: number[] = [];
      for (let i = 0; i < Math.min(runs, 10); i += 1) {
        bump += 1;
        await putSettings(client, token, { 'insights.prices': { ...EXAMPLE_PRICES, models: EXAMPLE_PRICES.models.map((row) => ({ ...row, input: row.input + bump / 1e6 })) } });
        const answer = await client.get(`/api/insights?${query}`);
        again.push(answer.ms);
      }
      recomputed.push(...again);
      rows[label] = { cold: Number(first.ms.toFixed(1)), warm: stats(warmTimes), recomputed: stats(again), bytes: first.bytes, turns: body.time.totals.turns, todos: body.cost.todos };
      console.log(`  ${label.padEnd(22)} cold ${first.ms.toFixed(1).padStart(6)} ms  warm p50 ${String(quantile(warmTimes, 0.5)).padStart(5)} ms  recomputed p50 ${String(quantile(again, 0.5)).padStart(6)} / p95 ${String(quantile(again, 0.95)).padStart(6)} ms  ${(first.bytes / 1024).toFixed(1)} KB  (${body.time.totals.turns} turns, ${body.cost.todos} todos)`);
    }
    report['queries'] = rows;
    report['overall'] = { cold: stats(cold), warm: stats(warm), recomputed: stats(recomputed) };
    console.log(`overall: cold ${JSON.stringify(stats(cold))} · warm ${JSON.stringify(stats(warm))} · recomputed ${JSON.stringify(stats(recomputed))}`);

    // 5 · The page in a browser (`--browser`): load until every section shows, and a filter change until its numbers show.
    if (values.browser) {
      const browser = await chromium.launch();
      try {
        const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
        await page.goto(`${server.baseUrl}/inbox`);
        const loads: number[] = [];
        const changes: number[] = [];
        for (let i = 0; i < 5; i += 1) {
          bump += 1;
          await putSettings(client, token, { 'insights.prices': { ...EXAMPLE_PRICES, models: EXAMPLE_PRICES.models.map((row) => ({ ...row, input: row.input + bump / 1e6 })) } });
          const start = performance.now();
          await page.goto(`${server.baseUrl}/insights?period=30d`);
          await page.getByTestId('insights-suggestions').waitFor();
          loads.push(performance.now() - start);
          const before = await page.getByTestId('tile-cost-total').textContent();
          const changeStart = performance.now();
          await page.getByTestId('filter-period').selectOption(i % 2 === 0 ? '90d' : '7d');
          await page.waitForFunction((text) => document.querySelector('[data-testid="tile-cost-total"]')?.textContent !== text, before);
          changes.push(performance.now() - changeStart);
        }
        report['browser'] = { load: stats(loads), filterChange: stats(changes) };
        console.log(`browser (1366 × 900): page load until every section shows ${JSON.stringify(stats(loads))} · a period change until its numbers show ${JSON.stringify(stats(changes))}`);
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.stop();
    await removeTempDir(world.tmp);
  }
  if (values.out) await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
