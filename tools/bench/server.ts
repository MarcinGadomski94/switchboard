/**
 * `node tools/bench/server.ts [--profile <dir>] [--out <file.json>]`: the server half
 * of the performance harness (`docs/performance.md`). Runs on a test port
 * (`SWITCHBOARD_TEST_PORTS`, default 4871–4879) with a throwaway data folder, fake
 * CLIs only; never the real app's port, data or CLI config.
 *
 * Scenarios:
 * 1. **open**: every route the session view calls, for the big session (≈13k
 *    events / 32 MB), a medium one (≈4.7k) and a small live one: median time and bytes.
 * 2. **stream**: a fake-claude session fires 100 turns of its own (`[fake:fire]`),
 *    once while its conversation is small and once after ≈13k events of history
 *    were added to it: server CPU per event, the time the server needs to take
 *    the stream in, and the bytes `/hub` sends meanwhile.
 *
 * `--profile <dir>` runs the server with `--cpu-prof` (one `.cpuprofile` per run in
 * that folder; summarize with `node tools/bench/profile.ts <file>`).
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import { seedFolderInDataDir } from '../../tests/helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../../tests/helpers/net.ts';
import { type ServerProcess, startServer } from '../../tests/helpers/server-process.ts';
import { appendHistory, seedWorld } from './world.ts';

const run = promisify(execFile);

/** A loopback client with the install's cookie. */
export class BenchClient {
  readonly baseUrl: string;
  readonly #cookie: string;
  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.#cookie = `sb_token=${token}`;
  }

  /** GET `route`: status, ms, bytes and the parsed body. */
  async get(route: string): Promise<{ status: number; ms: number; bytes: number; body: unknown }> {
    const start = performance.now();
    const response = await fetch(`${this.baseUrl}${route}`, { headers: { cookie: this.#cookie } });
    const text = await response.text();
    const ms = performance.now() - start;
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, ms, bytes: Buffer.byteLength(text), body };
  }

  async post(route: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${this.baseUrl}${route}`, {
      method: 'POST',
      headers: { cookie: this.#cookie, origin: this.baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
  }

  /** Opens `/hub` and counts the bytes and events it sends until `close()`. */
  hub(): { readonly stats: { bytes: number; events: Map<string, { count: number; bytes: number }> }; close(): void } {
    const stats = { bytes: 0, events: new Map<string, { count: number; bytes: number }>() };
    const url = new URL(`${this.baseUrl}/hub`);
    let buffer = '';
    const request = http.get({ host: url.hostname, port: url.port, path: '/hub', headers: { cookie: this.#cookie, accept: 'text/event-stream' } }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        stats.bytes += Buffer.byteLength(chunk);
        buffer += chunk;
        let at: number;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const name = /^event: (.*)$/m.exec(frame)?.[1] ?? 'message';
          const entry = stats.events.get(name) ?? { count: 0, bytes: 0 };
          entry.count += 1;
          entry.bytes += Buffer.byteLength(frame);
          stats.events.set(name, entry);
        }
      });
    });
    request.on('error', () => undefined);
    return { stats, close: () => request.destroy() };
  }
}

/** CPU seconds the process has used so far (`ps`, macOS / Linux). */
export async function cpuSeconds(pid: number): Promise<number> {
  const { stdout } = await run('ps', ['-o', 'time=', '-p', String(pid)]);
  // [[dd-]hh:]mm:ss[.ss]
  const text = stdout.trim();
  const [days, rest] = text.includes('-') ? text.split('-') : ['0', text];
  const parts = (rest ?? '').split(':').map(Number);
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return Number(days) * 86_400 + seconds;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** A world for the server: the seeded database, a saved workspace with one git repo, a Claude config folder. */
export interface BenchWorld {
  readonly tmp: string;
  readonly dataDir: string;
  readonly env: Record<string, string>;
  readonly bigSessionId: string;
  readonly mediumSessionIds: readonly string[];
  readonly sizes: ReadonlyMap<string, { readonly events: number; readonly payloadBytes: number }>;
}

export async function makeBenchWorld(label: string): Promise<BenchWorld> {
  const tmp = await realpath(await makeTempDir(label));
  const workspace = path.join(tmp, 'workspace');
  const repo = path.join(workspace, 'microfrontends', 'acme-app-front');
  const gitConfig = path.join(tmp, 'gitconfig');
  await mkdir(repo, { recursive: true });
  await mkdir(path.join(tmp, 'claude-config'), { recursive: true });
  await writeFile(gitConfig, '');
  const gitEnv: Record<string, string> = {
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Switchboard Bench',
    GIT_AUTHOR_EMAIL: 'bench@example.invalid',
    GIT_COMMITTER_NAME: 'Switchboard Bench',
    GIT_COMMITTER_EMAIL: 'bench@example.invalid',
  };
  const git = async (...args: string[]): Promise<void> => {
    const result = await runCommand(['git'], args, { cwd: repo, env: { ...process.env, ...gitEnv } });
    if (!succeeded(result)) throw new Error(`git ${args.join(' ')} failed: ${failureText(result)}`);
  };
  await git('init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'README.md'), 'hello\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'init');
  const dataDir = path.join(tmp, 'data');
  await seedFolderInDataDir(dataDir, workspace);
  const world = await seedWorld(dataDir);
  return {
    tmp,
    dataDir,
    env: { ...gitEnv, SWITCHBOARD_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config') },
    bigSessionId: world.bigSessionId,
    mediumSessionIds: world.mediumSessionIds,
    sizes: world.sizes,
  };
}

export async function clientFor(world: BenchWorld, server: ServerProcess): Promise<BenchClient> {
  const token = (await readFile(path.join(world.dataDir, 'sb_token'), 'utf8')).trim();
  return new BenchClient(server.baseUrl, token);
}

/** The routes the session view calls when it opens a session (chat tab). */
export function sessionRoutes(id: string): string[] {
  return [
    `/api/sessions/${id}`,
    `/api/sessions/${id}/events`,
    // D95: what the chat asks for since the paging (the newest page).
    `/api/sessions/${id}/events?limit=1000`,
    `/api/sessions/${id}/checkpoints`,
    `/api/sessions/${id}/todos`,
    `/api/sessions/${id}/loops`,
    `/api/sessions/${id}/drafts`,
    `/api/sessions/${id}/artifacts`,
    `/api/sessions/${id}/diff/count?scope=head`,
  ];
}

/** Starts a fake-claude session through the API and waits for its first turn to end. */
export async function startLiveSession(client: BenchClient, name: string): Promise<string> {
  const started = await client.post('/api/sessions', {
    name,
    task: 'Say hello.',
    workType: 'feature',
    mode: 'single',
    solutions: ['acme-app-front'],
    phase: 'ui-first',
    coordination: 'none',
    qa: null,
    worktrees: false,
    ultracode: false,
  });
  if (started.status !== 201) throw new Error(`POST /api/sessions: ${started.status} ${JSON.stringify(started.body)}`);
  const id = (started.body as { id: string }).id;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const detail = await client.get(`/api/sessions/${id}`);
    if ((detail.body as { status?: string }).status === 'done') return id;
    if (Date.now() > deadline) throw new Error(`session ${id} did not finish its first turn`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** The number of events of `sessionId` (a read-only connection of its own). */
async function eventCount(dataDir: string, sessionId: string): Promise<number> {
  const store = await openStore(storeFile(dataDir));
  try {
    const row = store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?').get(sessionId);
    return Number(row?.['n'] ?? 0);
  } finally {
    await store.close();
  }
}

/**
 * Fires `turns` turns into the live session (`[fake:fire]`) and measures until the
 * server is quiet (no new event for 2 s): CPU seconds, events, `/hub` bytes.
 */
export async function streamInto(
  world: BenchWorld,
  server: ServerProcess,
  client: BenchClient,
  sessionId: string,
  turns: number,
  everyMs: number,
): Promise<{ events: number; wallMs: number; cpuMs: number; cpuMsPerEvent: number; hubBytes: number; hubEvents: Record<string, { count: number; bytes: number }> }> {
  const pid = server.child.pid ?? 0;
  const before = await eventCount(world.dataDir, sessionId);
  const hub = client.hub();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const cpu0 = await cpuSeconds(pid);
  const start = performance.now();
  const sent = await client.post(`/api/sessions/${sessionId}/messages`, { text: `[fake:fire ${turns} ${everyMs}] keep going` });
  if (sent.status >= 300) throw new Error(`POST messages: ${sent.status} ${JSON.stringify(sent.body)}`);
  let last = before;
  let lastChange = performance.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const now = await eventCount(world.dataDir, sessionId);
    if (now !== last) {
      last = now;
      lastChange = performance.now();
    } else if (performance.now() - lastChange > 2_000) break;
    if (performance.now() - start > 300_000) break;
  }
  const wallMs = lastChange - start;
  const cpuMs = ((await cpuSeconds(pid)) - cpu0) * 1000;
  hub.close();
  const events = last - before;
  return { events, wallMs: Math.round(wallMs), cpuMs: Math.round(cpuMs), cpuMsPerEvent: Number((cpuMs / Math.max(1, events)).toFixed(2)), hubBytes: hub.stats.bytes, hubEvents: Object.fromEntries(hub.stats.events) };
}

/** Waits until the session's status is not `run` (its turn ended). */
async function waitIdle(client: BenchClient, id: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const detail = await client.get(`/api/sessions/${id}`);
    const status = (detail.body as { status?: string }).status;
    if (status !== 'run') return;
    if (Date.now() > deadline) throw new Error(`session ${id} still runs`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { profile: { type: 'string' }, out: { type: 'string' }, turns: { type: 'string', default: '100' }, every: { type: 'string', default: '20' } } });
  const profileRoot = values.profile ? path.resolve(values.profile) : null;
  const report: Record<string, unknown> = {};
  const world = await makeBenchWorld('bench-server');
  console.log(`world: ${world.dataDir}`);
  for (const [id, size] of world.sizes) console.log(`  ${id === world.bigSessionId ? 'big   ' : 'medium'} ${size.events} events, ${(size.payloadBytes / 1e6).toFixed(1)} MB`);
  /** One server run per phase, each with its own CPU profile folder. */
  const withServer = async <T>(phase: string, fn: (server: ServerProcess, client: BenchClient) => Promise<T>): Promise<T> => {
    let extraEnv: Record<string, string> = {};
    if (profileRoot) {
      const dir = path.join(profileRoot, phase);
      await mkdir(dir, { recursive: true });
      // The fake CLIs inherit NODE_OPTIONS and write their own (smaller) profiles here too; the server's is the largest.
      extraEnv = { NODE_OPTIONS: `--cpu-prof --cpu-prof-dir=${dir} --cpu-prof-name=server-${phase}-\${pid}.cpuprofile` };
    }
    const server = await startServer({ ...world.env, ...extraEnv }, 60_000);
    try {
      return await fn(server, await clientFor(world, server));
    } finally {
      await server.stop();
    }
  };
  const turns = Number(values.turns);
  const every = Number(values.every);
  try {
    // 1. Opening sessions.
    const small = await withServer('open', async (_server, client) => {
      const small = await startLiveSession(client, 'stream-session');
      const open: Record<string, Record<string, { ms: number; bytes: number; status: number }>> = {};
      for (const [label, id] of [['big', world.bigSessionId], ['medium', world.mediumSessionIds[0] ?? ''], ['small', small]] as const) {
        const rows: Record<string, { ms: number; bytes: number; status: number }> = {};
        for (const route of sessionRoutes(id)) {
          const runs: Array<{ ms: number; bytes: number; status: number }> = [];
          for (let i = 0; i < 5; i += 1) {
            const answer = await client.get(route);
            runs.push({ ms: answer.ms, bytes: answer.bytes, status: answer.status });
          }
          rows[route.replace(id, '{id}')] = { ms: Number(median(runs.map((r) => r.ms)).toFixed(1)), bytes: runs[0]?.bytes ?? 0, status: runs[0]?.status ?? 0 };
        }
        open[label] = rows;
      }
      const list = await client.get('/api/sessions');
      open['all'] = { '/api/sessions': { ms: Number(list.ms.toFixed(1)), bytes: list.bytes, status: list.status } };
      report['open'] = open;
      for (const [label, rows] of Object.entries(open)) for (const [route, x] of Object.entries(rows)) console.log(`  open ${label.padEnd(7)} ${route.padEnd(44)} ${x.ms.toFixed(1).padStart(8)} ms ${String(x.bytes).padStart(10)} B ${x.status}`);
      return small;
    });

    // 2. Streaming into a small conversation.
    report['streamSmall'] = await withServer('stream-small', async (server, client) => {
      await client.post(`/api/sessions/${small}/messages`, { text: 'Wake up.' });
      await waitIdle(client, small);
      return streamInto(world, server, client, small, turns, every);
    });
    console.log('stream (small conversation):', JSON.stringify(report['streamSmall']));

    // 3. The same session after ≈13k events of history, with a live CronCreate (the loop tracker follows it).
    const store = await openStore(storeFile(world.dataDir));
    try {
      const main = (await store.agents.listBySession(small)).find((agent) => agent.kind === 'main');
      if (!main) throw new Error('no main agent');
      const now = Date.now();
      const added = appendHistory(store, small, main.id, 13_000, { seed: 7, startMs: now - 14 * 86_400_000, endMs: now - 10 * 60_000, liveCron: false });
      console.log(`  added ${added.events} events (${(added.payloadBytes / 1e6).toFixed(1)} MB) to the stream session`);
    } finally {
      await store.close();
    }
    report['streamBig'] = await withServer('stream-big', async (server, client) => {
      await client.post(`/api/sessions/${small}/messages`, { text: '[fake:tool CronCreate {"cron":"*/30 * * * *","prompt":"check the CI run","recurring":true}] schedule it' });
      await waitIdle(client, small);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return streamInto(world, server, client, small, turns, every);
    });
    console.log('stream (≈13k events):', JSON.stringify(report['streamBig']));
  } finally {
    if (values.out) await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
    await removeTempDir(world.tmp);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
