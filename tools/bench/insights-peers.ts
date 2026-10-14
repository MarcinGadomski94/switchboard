/**
 * `node tools/bench/insights-peers.ts [--runs <n>]`: D108's merged-machines benchmark
 * (`docs/insights.md` → *Performance*). Two real Switchboard processes on test ports, paired
 * over loopback (`tests/helpers/peers.ts`), each seeded with a bench-sized rollup (90 days × 20
 * sessions × 3 models ≈ 5,400 rows) and 400 completed todos. On B, `GET /api/insights?period=90d`:
 *
 * 1. **peer reachable**: the page's first request (`peers=cached`: B's own numbers, A pending),
 *    the fill-in (`peers=wait`, A's rows pulled), and steady state (A's rows cached);
 * 2. **peer slow** (A's process stopped with SIGSTOP: connected, never answers): the first
 *    request, and a `peers=wait` (bounded by the 2.5 s peer timeout);
 * 3. **peer offline** (A's process stopped).
 *
 * Fake CLIs only, throwaway data, test ports (`SWITCHBOARD_TEST_PORTS`).
 */
import { parseArgs } from 'node:util';
import { EXAMPLE_PRICES, type InsightsAnswer, utcDay } from '../../src/core/insights.ts';
import { transaction } from '../../src/server/db/database.ts';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import { makeTempDir, removeTempDir } from '../../tests/helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../tests/helpers/peers.ts';

function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return Number((sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0).toFixed(1));
}

function stats(values: readonly number[]): string {
  return `p50 ${quantile(values, 0.5)} ms · p95 ${quantile(values, 0.95)} ms · max ${quantile(values, 1)} ms (n ${values.length})`;
}

async function seed(node: PeerNode, label: string): Promise<void> {
  const store = await openStore(storeFile(node.dataDir));
  try {
    const models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'];
    const turn = store.db.prepare(
      `INSERT INTO insight_turns_daily (day, session_id, provider, model, profile_id, folder, kind, turns, error_turns, tokens, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, unsplit_tokens, duration_ms, reverts, redos)
       VALUES (?, ?, 'claude', ?, 'default-claude', ?, 'session', ?, 0, ?, ?, ?, ?, ?, 0, ?, ?, 0)`,
    );
    const todo = store.db.prepare(
      `INSERT INTO todo_actuals (todo_id, session_id, folder, title, estimate_minutes, actual_ms, actual_tokens, completed_at, priority, provider, model, profile_id, usage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'claude', ?, 'default-claude', ?)`,
    );
    const now = Date.now();
    transaction(store.db, () => {
      for (let d = 0; d < 90; d += 1) {
        const day = utcDay(now - d * 86_400_000);
        for (let s = 0; s < 20; s += 1) {
          for (const [m, model] of models.entries()) {
            const n = 1 + ((d * 7 + s * 3 + m) % 9);
            turn.run(day, `${label}-s${s}`, model, `/work/${label}/repo-${s % 5}`, n, n * 12_000, n * 500, n * 4_000, n * 7_500, n * 60_000, n * 90_000, (d + s) % 13 === 0 ? 1 : 0);
          }
        }
      }
      for (let i = 0; i < 400; i += 1) {
        const usage = { input: 500, output: 2_000 + (i % 50) * 100, cacheWrite: 10_000, cacheRead: 100_000, unsplit: 0 };
        todo.run(`${label}-t${i}`, `${label}-s${i % 20}`, `/work/${label}/repo-${i % 5}`, `Todo ${i}`, [10, 20, 45][i % 3] as number, (5 + (i % 40)) * 60_000, usage.input + usage.output + usage.cacheWrite, new Date(now - (i % 89) * 86_400_000).toISOString(), ['low', 'medium', 'high'][i % 3] as string, models[i % 3] as string, JSON.stringify(usage));
      }
    });
  } finally {
    await store.close();
  }
}

async function timed(node: PeerNode, route: string): Promise<{ ms: number; body: InsightsAnswer }> {
  const start = performance.now();
  const answer = await node.call('GET', route);
  const ms = performance.now() - start;
  if (answer.status !== 200) throw new Error(`${route}: HTTP ${answer.status}`);
  return { ms, body: answer.body as InsightsAnswer };
}

/** Changes the price table a little: every answer is computed again (not a cached copy). */
async function bust(node: PeerNode, n: number): Promise<void> {
  await node.call('PUT', '/api/settings', { 'insights.prices': { ...EXAMPLE_PRICES, models: EXAMPLE_PRICES.models.map((row) => ({ ...row, input: row.input + n / 1e6 })) } });
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { runs: { type: 'string', default: '10' } } });
  const runs = Math.max(1, Number(values.runs));
  const tmp = await makeTempDir('bench-insights-peers');
  const { a, b, aId } = await pairedNodes(tmp);
  try {
    await seed(a, 'a');
    await seed(b, 'b');
    const route = '/api/insights?period=90d&machine=all';
    let n = 0;

    // 1 · Peer reachable: first request (cached: A pending), fill-in (wait), steady (A cached).
    const first = await timed(b, `${route}&peers=cached`);
    const fill = await timed(b, `${route}&peers=wait`);
    console.log(`reachable · first (B alone, A pending): ${first.ms.toFixed(1)} ms, pending ${first.body.machines.pending.map((m) => m.name).join(', ') || '—'} · fill-in (A pulled): ${fill.ms.toFixed(1)} ms, included ${fill.body.machines.included.length}, turns ${fill.body.time.totals.turns}`);
    const steady: number[] = [];
    for (let i = 0; i < runs; i += 1) {
      await bust(b, (n += 1));
      steady.push((await timed(b, `${route}&peers=cached`)).ms);
    }
    console.log(`reachable · recomputed with A's cached rows: ${stats(steady)}`);
    const localOnly: number[] = [];
    for (let i = 0; i < runs; i += 1) {
      await bust(b, (n += 1));
      localOnly.push((await timed(b, '/api/insights?period=90d&machine=local')).ms);
    }
    console.log(`this machine only, recomputed: ${stats(localOnly)}`);

    // 2 · Peer slow: A's process stopped (SIGSTOP) — connected, never answers.
    a.server.child.kill('SIGSTOP');
    // A period not asked yet: A's rows must be pulled (none cached).
    const slowRoute = '/api/insights?period=30d&machine=all';
    const slowFirst: number[] = [];
    for (let i = 0; i < runs; i += 1) {
      await bust(b, (n += 1));
      slowFirst.push((await timed(b, `${slowRoute}&peers=cached`)).ms);
    }
    console.log(`slow peer · first request (never waits): ${stats(slowFirst)}`);
    const slowWait = await timed(b, `${slowRoute}&peers=wait`);
    console.log(`slow peer · fill-in (bounded by the peer timeout): ${slowWait.ms.toFixed(0)} ms, missing ${JSON.stringify(slowWait.body.machines.missing)}`);
    a.server.child.kill('SIGCONT');

    // 3 · Peer offline.
    await a.server.stop();
    await waitFor('A offline on B', async () => ((await b.call('GET', '/api/machines')).body as { machines: Array<{ id: string; state: string }> }).machines.find((m) => m.id === aId)?.state !== 'online', 30_000);
    const offline: number[] = [];
    let notice = '';
    for (let i = 0; i < runs; i += 1) {
      await bust(b, (n += 1));
      const answer = await timed(b, `${route}&peers=wait`);
      offline.push(answer.ms);
      notice = JSON.stringify(answer.body.machines.missing);
    }
    console.log(`offline peer · peers=wait: ${stats(offline)}, missing ${notice}`);
  } finally {
    a.server.child.kill('SIGCONT');
    await Promise.all([a.server.stop(), b.server.stop()]);
    await removeTempDir(tmp);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
