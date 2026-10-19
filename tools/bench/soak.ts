/**
 * `node tools/bench/soak.ts [--sessions 8] [--active-min 4] [--idle-min 10] [--sample-s 30] [--out <dir>] [--no-peer]`:
 * the long-run half of the performance harness (`docs/performance.md` → *Long runs (1.24)*).
 *
 * Two real servers on test ports (`SWITCHBOARD_TEST_PORTS`), paired over loopback (the peer
 * exchange, accounts / insights / team sync running as they do in an install). The measured one
 * (B) gets the bench world (`world.ts`), Team, Plans and Project memory on, `--sessions` live
 * fake-claude sessions, each running the real `switchboard` MCP helper (`FAKE_CLAUDE_MCP_RUN=1`:
 * its tools long-poll included), and a `/hub?delta=1` reader like an open tab. Production timings
 * (no shortened ticks), fake CLIs only, throwaway data.
 *
 * Phases: **active** (`--active-min`: every session fires turns of its own) then **idle**
 * (`--idle-min`: nothing works). Every `--sample-s` the server's RSS and CPU (`ps`) and its heap
 * after a forced GC (the inspector, `--inspect` on B only, a test port) are sampled; the idle
 * phase gets a heap snapshot at its start and end (in `--out`) and is followed by `--profile-min` of
 * idle under the CPU profiler (`idle.cpuprofile`); the helpers' RSS is read at the end. Summarize with `node tools/bench/profile.ts` and
 * `node tools/bench/heap-diff.ts <first> <last>`.
 */
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { freeTestPorts, makeTempDir, removeTempDir } from '../../tests/helpers/net.ts';
import { type PeerNode, enableListener, machineOn, pair, startPeerNode, waitFor } from '../../tests/helpers/peers.ts';
import { cpuSeconds } from './server.ts';
import { openStore, storeFile, type Store } from '../../src/server/db/store.ts';
import { appendHistory, seedWorld } from './world.ts';

const run = promisify(execFile);

/** A minimal Chrome DevTools Protocol client over the inspector's WebSocket. */
export class Inspector {
  readonly #ws: WebSocket;
  #id = 0;
  readonly #pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  readonly #listeners = new Map<string, Array<(params: any) => void>>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
      if (message.id !== undefined) {
        const waiter = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message));
        else waiter?.resolve(message.result);
      } else if (message.method) {
        for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params);
      }
    });
  }

  static async connect(port: number, timeoutMs = 20_000): Promise<Inspector> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ webSocketDebuggerUrl: string }>;
        const url = targets[0]?.webSocketDebuggerUrl;
        if (url) {
          const ws = new WebSocket(url);
          await new Promise<void>((resolve, reject) => {
            ws.addEventListener('open', () => resolve(), { once: true });
            ws.addEventListener('error', () => reject(new Error('inspector websocket failed')), { once: true });
          });
          return new Inspector(ws);
        }
      } catch {
        // Not up yet.
      }
      if (Date.now() > deadline) throw new Error(`no inspector on ${port}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = (this.#id += 1);
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, listener: (params: any) => void): () => void {
    const list = this.#listeners.get(method) ?? [];
    list.push(listener);
    this.#listeners.set(method, list);
    return () => list.splice(list.indexOf(listener), 1);
  }

  /** Heap used / total after a forced full GC (bytes). */
  async heapAfterGc(): Promise<{ used: number; total: number }> {
    await this.send('HeapProfiler.collectGarbage');
    await this.send('HeapProfiler.collectGarbage');
    const usage = await this.send<{ usedSize: number; totalSize: number }>('Runtime.getHeapUsage');
    return { used: usage.usedSize, total: usage.totalSize };
  }

  /** Writes a heap snapshot to `file`. */
  async snapshot(file: string): Promise<void> {
    const out = createWriteStream(file);
    const off = this.on('HeapProfiler.addHeapSnapshotChunk', (params: { chunk: string }) => out.write(params.chunk));
    try {
      await this.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false });
    } finally {
      off();
      await new Promise<void>((resolve) => out.end(resolve));
    }
  }

  close(): void {
    this.#ws.close();
  }
}

/** RSS in KB of `pid` (`ps`). */
export async function rssKb(pid: number): Promise<number> {
  const { stdout } = await run('ps', ['-o', 'rss=', '-p', String(pid)]);
  return Number(stdout.trim());
}

/** The pids and RSS (KB) of the `switchboard` MCP helpers whose argv names `port` (this server's helpers only). */
export async function helperRss(port: number): Promise<Array<{ pid: number; rssKb: number }>> {
  const { stdout } = await run('ps', ['-axo', 'pid=,rss=,command=']);
  const out: Array<{ pid: number; rssKb: number }> = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const command = match[3] ?? '';
    if (/sb-mcp\.(ts|js|mjs)\b/.test(command) && command.includes(`--switchboard-mcp ${port} `)) out.push({ pid: Number(match[1]), rssKb: Number(match[2]) });
  }
  return out;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A `/hub` reader like an open tab (counts bytes). */
function openHub(node: PeerNode, token: string): { bytes: () => number; close: () => void } {
  const controller = new AbortController();
  let bytes = 0;
  void (async () => {
    try {
      const response = await fetch(`${node.baseUrl}/hub?delta=1`, { headers: { cookie: `sb_token=${token}`, accept: 'text/event-stream' }, signal: controller.signal });
      const reader = response.body?.getReader();
      for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) break;
        bytes += chunk.value.byteLength;
      }
    } catch {
      // Closed.
    }
  })();
  return { bytes: () => bytes, close: () => controller.abort() };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      sessions: { type: 'string', default: '8' },
      'active-min': { type: 'string', default: '4' },
      'idle-min': { type: 'string', default: '10' },
      'sample-s': { type: 'string', default: '30' },
      'profile-min': { type: 'string', default: '2' },
      out: { type: 'string', default: '.bench/soak' },
      'no-peer': { type: 'boolean', default: false },
      'extra-open': { type: 'string', default: '0' },
      // Regression guard: exit 1 when the idle phase's CPU or the heap growth over the idle phase passes these.
      'max-idle-cpu': { type: 'string' },
      'max-idle-heap-growth-mb': { type: 'string' },
      'max-helper-mb': { type: 'string' },
      'extra-closed': { type: 'string', default: '0' },
    },
  });
  const sessions = Number(values.sessions);
  const activeMs = Number(values['active-min']) * 60_000;
  const idleMs = Number(values['idle-min']) * 60_000;
  const sampleMs = Number(values['sample-s']) * 1000;
  const profileMs = Number(values['profile-min']) * 60_000;
  const outDir = path.resolve(values.out);
  await mkdir(outDir, { recursive: true });
  const tmp = await makeTempDir('bench-soak');
  const inspectPort = (await freeTestPorts()).at(-1);
  if (inspectPort === undefined) throw new Error('no free test port for the inspector');
  const report: Record<string, unknown> = { sessions, activeMs, idleMs, extraOpen: Number(values['extra-open']), extraClosed: Number(values['extra-closed']) };
  const samples: Array<Record<string, number | string>> = [];
  let a: PeerNode | null = null;
  let b: PeerNode | null = null;
  let inspector: Inspector | null = null;
  try {
    const env = { FAKE_CLAUDE_MCP_RUN: '1' };
    b = await startPeerNode(tmp, 'b', {
      repo: true,
      env,
      nodeArgs: [`--inspect=127.0.0.1:${inspectPort}`],
      startTimeoutMs: 120_000,
      prepare: async ({ dataDir }) => {
        await seedWorld(dataDir);
        // A long-used install: many open sessions without a process, and closed ones (each with a little history).
        const store = await openStore(storeFile(dataDir));
        try {
          const now = Date.now();
          for (let i = 0; i < Number(values['extra-open']) + Number(values['extra-closed']); i += 1) {
            const closed = i >= Number(values['extra-open']);
            const session = await store.sessions.create({ name: `${closed ? 'closed' : 'open'}-${i}`, claudeSessionId: crypto.randomUUID(), task: `Old task ${i}`, status: 'idle', cwd: dataDir, createdAt: new Date(now - (i + 1) * 3_600_000).toISOString(), remoteAvailable: false } as Parameters<Store['sessions']['create']>[0]);
            const main = await store.agents.create({ sessionId: session.id, name: 'main', kind: 'main', status: 'idle' });
            appendHistory(store, session.id, main.id, 200, { seed: i + 1, startMs: now - (i + 2) * 3_600_000, endMs: now - (i + 1) * 3_600_000, liveCron: false });
            if (closed) await store.sessions.update(session.id, { closedAt: new Date(now - i * 60_000).toISOString() });
          }
        } finally {
          await store.close();
        }
      },
    });
    if (!values['no-peer']) {
      a = await startPeerNode(tmp, 'a', { repo: true, env });
      const aAddress = await enableListener(a);
      await enableListener(b);
      await pair(a, b, aAddress);
      const aId = await a.machineId();
      const bId = await b.machineId();
      await waitFor('both machines online', async () => (await machineOn(b!, aId))?.state === 'online' && (await machineOn(a!, bId))?.state === 'online', 30_000);
    }
    const pid = b.server.child.pid ?? 0;
    inspector = await Inspector.connect(inspectPort);
    await b.call('PUT', '/api/settings', { 'experimental.team': true, 'experimental.plans': true, 'experimental.memory': true });
    if (a) await a.call('PUT', '/api/settings', { 'experimental.team': true, 'experimental.plans': true, 'experimental.memory': true });
    const token = (await import('node:fs/promises')).readFile(path.join(b.dataDir, 'sb_token'), 'utf8');
    const hub = openHub(b, (await token).trim());

    const ids: string[] = [];
    for (let i = 0; i < sessions; i += 1) {
      const started = await b.call('POST', '/api/sessions', { simple: true, name: `soak-${i}`, title: `Soak ${i}`, task: 'Say hello.', folder: b.folderId, worktrees: false });
      if (started.status !== 201) throw new Error(`POST /api/sessions: ${started.status} ${JSON.stringify(started.body)}`);
      ids.push((started.body as { id: string }).id);
    }
    if (a) {
      const started = await a.call('POST', '/api/sessions', { simple: true, name: 'peer-0', title: 'Peer 0', task: 'Say hello.', folder: a.folderId, worktrees: false });
      if (started.status !== 201) throw new Error(`A: POST /api/sessions: ${started.status}`);
    }
    await waitFor('sessions idle', async () => {
      for (const id of ids) if ((await b!.call('GET', `/api/sessions/${id}`)).body?.status === 'run') return false;
      return true;
    }, 120_000);
    await waitFor('helpers up', async () => (await helperRss(b!.server.port)).length >= sessions, 60_000).catch(() => undefined);

    const t0 = Date.now();
    let lastCpu = await cpuSeconds(pid);
    let lastAt = Date.now();
    const sample = async (phase: string, withHeap = true): Promise<void> => {
      const cpu = await cpuSeconds(pid);
      const now = Date.now();
      const heap = withHeap ? await inspector!.heapAfterGc() : { used: Number.NaN, total: Number.NaN };
      const row = {
        phase,
        t: Math.round((now - t0) / 1000),
        rssMb: Number(((await rssKb(pid)) / 1024).toFixed(1)),
        heapMb: Number((heap.used / 1e6).toFixed(1)),
        cpuPct: Number((((cpu - lastCpu) * 1000) / (now - lastAt) * 100).toFixed(2)),
        hubKb: Math.round(hub.bytes() / 1024),
      };
      lastCpu = cpu;
      lastAt = now;
      samples.push(row);
      console.log(JSON.stringify(row));
    };
    await sample('start');
    await inspector.snapshot(path.join(outDir, 'active-start.heapsnapshot'));

    // Active: each session fires turns of its own, staggered; again whenever it went quiet.
    const activeEnd = Date.now() + activeMs;
    let fired = 0;
    while (Date.now() < activeEnd) {
      for (const id of ids) {
        const detail = await b.call('GET', `/api/sessions/${id}`);
        if (detail.body?.status !== 'run') {
          // Every other round a Write with a 40 KB file (real agents' tool inputs are that big), else 20 fired turns.
          const text =
            fired % 2 === 0
              ? `[fake:tool Write ${JSON.stringify({ file_path: `src/file-${fired}.ts`, content: `// round ${fired}\n${'export const value = 1;\n'.repeat(1_700)}` })}] write it`
              : `[fake:fire 20 1500] round ${fired}`;
          await b.call('POST', `/api/sessions/${id}/messages`, { text });
          fired += 1;
        }
      }
      const next = Date.now() + sampleMs;
      while (Date.now() < Math.min(next, activeEnd)) await sleep(1000);
      await sample('active');
    }
    await waitFor('sessions idle', async () => {
      for (const id of ids) if ((await b!.call('GET', `/api/sessions/${id}`)).body?.status === 'run') return false;
      return true;
    }, 180_000);
    report['fired'] = fired;

    // Idle: nothing works. CPU from `ps` alone (no profiler, no forced GC in between), heap after a GC and a snapshot at
    // both ends; then `--profile-min` more of idle under the CPU profiler (it costs CPU of its own).
    await sleep(15_000);
    await sample('idle-start');
    await inspector.snapshot(path.join(outDir, 'idle-start.heapsnapshot'));
    await sleep(5_000);
    lastCpu = await cpuSeconds(pid);
    lastAt = Date.now();
    const idleCpu0 = lastCpu;
    const idleAt0 = lastAt;
    const idleEnd = Date.now() + idleMs;
    while (Date.now() < idleEnd) {
      await sleep(Math.min(sampleMs, idleEnd - Date.now()));
      await sample('idle', false);
    }
    const idleCpuPct = (((await cpuSeconds(pid)) - idleCpu0) * 1000) / (Date.now() - idleAt0) * 100;
    await sample('idle-end');
    await inspector.snapshot(path.join(outDir, 'idle-end.heapsnapshot'));
    if (profileMs > 0) {
      await inspector.send('Profiler.enable');
      await inspector.send('Profiler.setSamplingInterval', { interval: 1000 });
      await inspector.send('Profiler.start');
      await sleep(profileMs);
      const { profile } = await inspector.send<{ profile: unknown }>('Profiler.stop');
      await writeFile(path.join(outDir, 'idle.cpuprofile'), JSON.stringify(profile));
    }
    const helpers = await helperRss(b.server.port);
    report['idleCpuPct'] = Number(idleCpuPct.toFixed(2));
    report['helpers'] = { count: helpers.length, rssMb: helpers.map((h) => Number((h.rssKb / 1024).toFixed(1))), avgMb: Number((helpers.reduce((s, h) => s + h.rssKb, 0) / Math.max(1, helpers.length) / 1024).toFixed(1)) };
    const heapAt = (phase: string) => Number(samples.find((row) => row.phase === phase)?.heapMb ?? 0);
    const idleHeapGrowthMb = Number((heapAt('idle-end') - heapAt('idle-start')).toFixed(1));
    report['idleHeapGrowthMb'] = idleHeapGrowthMb;
    console.log('idle CPU %', report['idleCpuPct'], 'idle heap growth MB', idleHeapGrowthMb, 'helpers', JSON.stringify(report['helpers']));
    const failures: string[] = [];
    if (values['max-idle-cpu'] !== undefined && idleCpuPct > Number(values['max-idle-cpu'])) failures.push(`idle CPU ${idleCpuPct.toFixed(2)} % > ${values['max-idle-cpu']} %`);
    if (values['max-idle-heap-growth-mb'] !== undefined && idleHeapGrowthMb > Number(values['max-idle-heap-growth-mb'])) failures.push(`idle heap growth ${idleHeapGrowthMb} MB > ${values['max-idle-heap-growth-mb']} MB`);
    const biggest = Math.max(0, ...helpers.map((h) => h.rssKb / 1024));
    if (values['max-helper-mb'] !== undefined && biggest > Number(values['max-helper-mb'])) failures.push(`a helper at ${biggest.toFixed(1)} MB > ${values['max-helper-mb']} MB`);
    report['guard'] = failures;
    if (failures.length > 0) {
      console.error(`soak guard failed: ${failures.join('; ')}`);
      process.exitCode = 1;
    }
    hub.close();
  } finally {
    report['samples'] = samples;
    await writeFile(path.join(outDir, 'soak.json'), `${JSON.stringify(report, null, 2)}\n`);
    inspector?.close();
    await Promise.all([a?.server.stop(), b?.server.stop()]);
    await removeTempDir(tmp);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
