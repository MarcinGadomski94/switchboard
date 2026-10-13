/**
 * `node tools/bench/search.ts [--runs <n>] [--out <file.json>]`: D97's search
 * benchmark (`docs/search.md` → *Performance*) on the D95 bench world
 * (`tools/bench/world.ts`: one ≈13k-event session, four ≈4.7k ones, ≈32k events in
 * all), seeded **before** the server starts, so the index fills through the startup
 * backfill as on an upgrade. Test port (`SWITCHBOARD_TEST_PORTS`), throwaway data,
 * fake CLIs only.
 *
 * Measures:
 * 1. **startup**: the server's start until it answers, and requests while the
 *    backfill runs (`GET /api/sessions`, the big session's newest page, a search):
 *    p50 / p95, so a backfill that blocked would show;
 * 2. **backfill**: wall time until `indexing.done`, and the server's time in steps;
 * 3. **search**: each query `--runs` times (default 30) once the index is full:
 *    p50 / p95 per query and over all of them, and the index's size.
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import { removeTempDir } from '../../tests/helpers/net.ts';
import { startServer } from '../../tests/helpers/server-process.ts';
import type { SearchAnswer } from '../../src/core/search.ts';
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

/** The queries: the vocabulary of the synthetic history is small, so most words match nearly every message (the worst case). */
function queries(bigSessionId: string): ReadonlyArray<readonly [label: string, route: string]> {
  const q = (text: string, extra = ''): string => `/api/search?q=${encodeURIComponent(text)}${extra}`;
  return [
    ['common word (all scopes)', q('upload')],
    ['two common words', q('queue drains')],
    ['phrase', q('"queue drains before"')],
    ['prefix', q('retr*')],
    ['rare (one file name)', q('file-1234')],
    ['no match', q('zanzibar')],
    ['conversations, page 2 size', q('token expires', '&scope=conversations&limit=20')],
    ['one session', q('worker starts', `&session=${bigSessionId}`)],
    ['artifacts only', q('upload', '&scope=artifacts')],
  ];
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { runs: { type: 'string', default: '30' }, out: { type: 'string' } } });
  const runs = Math.max(1, Number(values.runs));
  const world = await makeBenchWorld('bench-search');
  const events = [...world.sizes.values()].reduce((sum, size) => sum + size.events, 0);
  console.log(`world: ${world.dataDir} · ${events} events in ${world.sizes.size} sessions`);
  const report: Record<string, unknown> = { events };
  const started = performance.now();
  const server = await startServer(world.env, 60_000);
  const startMs = performance.now() - started;
  try {
    const client: BenchClient = await clientFor(world, server);
    report['startMs'] = Number(startMs.toFixed(0));
    console.log(`server answering after ${startMs.toFixed(0)} ms`);

    // While the backfill runs: the usual reads and a search keep answering.
    const during: Record<string, number[]> = { sessions: [], events: [], search: [] };
    const backfillStart = performance.now();
    let done = false;
    let percent = 0;
    while (!done && performance.now() - backfillStart < 300_000) {
      during['sessions']!.push((await client.get('/api/sessions')).ms);
      during['events']!.push((await client.get(`/api/sessions/${world.bigSessionId}/events?limit=1000`)).ms);
      const answer = await client.get('/api/search?q=upload');
      during['search']!.push(answer.ms);
      const indexing = (answer.body as SearchAnswer).indexing;
      done = indexing.done;
      percent = indexing.percent;
    }
    const backfillMs = performance.now() - backfillStart;
    report['backfill'] = { wallMs: Number(backfillMs.toFixed(0)), done, percent, requestsDuring: Object.fromEntries(Object.entries(during).map(([k, v]) => [k, stats(v)])) };
    console.log(`backfill: ${done ? 'done' : `not done (${percent}%)`} after ${backfillMs.toFixed(0)} ms (startup delay included)`);
    for (const [name, list] of Object.entries(during)) console.log(`  during backfill ${name.padEnd(9)} ${JSON.stringify(stats(list))}`);

    // Warm-up, then each query `runs` times.
    for (const [, route] of queries(world.bigSessionId)) await client.get(route);
    const all: number[] = [];
    const rows: Record<string, unknown> = {};
    for (const [label, route] of queries(world.bigSessionId)) {
      const times: number[] = [];
      let answer: SearchAnswer | null = null;
      for (let i = 0; i < runs; i += 1) {
        const result = await client.get(route);
        if (result.status !== 200) throw new Error(`${route}: HTTP ${result.status}`);
        times.push(result.ms);
        answer = result.body as SearchAnswer;
      }
      all.push(...times);
      const counts = (answer?.groups ?? []).map((group) => `${group.scope} ${group.count}`).join(', ');
      rows[label] = { ...stats(times), counts };
      console.log(`  ${label.padEnd(30)} p50 ${String(quantile(times, 0.5)).padStart(6)} ms  p95 ${String(quantile(times, 0.95)).padStart(6)} ms  (${counts})`);
    }
    report['search'] = { perQuery: rows, overall: stats(all) };
    console.log(`search overall: ${JSON.stringify(stats(all))}`);
  } finally {
    await server.stop();
  }
  const store = await openStore(storeFile(world.dataDir));
  try {
    const size = store.search.sizeBytes();
    const dbBytes = Number(store.db.prepare('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()').get()?.['n'] ?? 0);
    report['index'] = { bytes: size, databaseBytes: dbBytes };
    console.log(`index: ${size === null ? 'n/a' : `${(size / 1e6).toFixed(1)} MB`} of a ${(dbBytes / 1e6).toFixed(1)} MB database`);
  } finally {
    await store.close();
    await removeTempDir(world.tmp);
  }
  if (values.out) await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
