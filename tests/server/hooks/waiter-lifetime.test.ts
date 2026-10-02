import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { HooksStatus, Session, SessionDetail } from '../../../src/core/api.ts';
import { HOOK_MARKER, WAITER_HOOK_TIMEOUT_S } from '../../../src/core/hooks.ts';
import { buildApp, createSessionServices } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HookService } from '../../../src/server/hooks/service.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { HOOK_TOKEN_FILE, generateToken, loadOrCreateToken } from '../../../src/server/token.ts';
import { REPO_ROOT, freeTestPorts, makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';
import { assistantTextLine, lastUuid, terminalUserLine, writeTranscript } from '../../helpers/transcripts.ts';

/**
 * Fix · hook waiter expiring (`docs/decisions.md`, `docs/peers.md` → *Waiter
 * lifetime*): the real hook script (`src/hook/sb-hook.ts`, run with node as the
 * CLI would) against a real listening host. A waiter survives a host restart and
 * is delivered the message once; the host's explicit stop (204) ends it; the
 * hook state shows `outdated` for entries without the waiter's long `timeout`
 * and Update hooks rewrites them; the status tells "never armed" from "stopped".
 */

const SCRIPT = path.join(REPO_ROOT, 'src', 'hook', 'sb-hook.ts');
const CS = '5d1f0c52-aaaa-4bbb-8ccc-0123456789cd';

interface Host {
  readonly app: FastifyInstance;
  readonly hooks: HookService;
}

interface World {
  readonly root: string;
  readonly store: Store;
  readonly port: number;
  readonly token: string;
  readonly hookTokenFile: string;
  readonly configDir: string;
  readonly cwd: string;
  readonly transcript: string;
  host: Host | null;
  readonly children: ChildProcess[];
  start(): Promise<Host>;
  stop(): Promise<void>;
}

let world: World | undefined;

afterEach(async () => {
  if (!world) return;
  for (const child of world.children) child.kill('SIGKILL');
  await world.stop();
  await world.store.close();
  await removeTempDir(world.root);
  world = undefined;
});

async function setup(): Promise<World> {
  const port = (await freeTestPorts()).at(-1);
  if (port === undefined) throw new Error('no free test port');
  const root = await makeTempDir('waiter');
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, 'claude-config');
  const cwd = path.join(root, 'project');
  await mkdir(cwd, { recursive: true });
  await mkdir(configDir, { recursive: true });
  const store = await openTempStore(dataDir);
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: dataDir }, platform: 'linux', home: root, cwd: root }), port };
  await loadOrCreateToken(dataDir, HOOK_TOKEN_FILE);
  const hookTokenFile = path.join(dataDir, HOOK_TOKEN_FILE);
  const hookToken = await loadOrCreateToken(dataDir, HOOK_TOKEN_FILE);
  const token = generateToken();
  const lines = [terminalUserLine({ sessionId: CS, cwd, content: 'Hello.', parentUuid: null, timestamp: '2026-10-02T10:00:00.000Z' })];
  lines.push(assistantTextLine({ sessionId: CS, cwd, text: 'Hi.', parentUuid: lastUuid(lines), timestamp: '2026-10-02T10:00:05.000Z' }));
  const transcript = await writeTranscript(configDir, cwd, CS, lines);
  const w: World = {
    root,
    store,
    port,
    token,
    hookTokenFile,
    configDir,
    cwd,
    transcript,
    host: null,
    children: [],
    async start() {
      const bus = new HubBus();
      const { supervisor, questions } = createSessionServices(config, store, bus);
      const hooks = new HookService({
        config,
        store,
        bus,
        questions,
        hookTokenFile,
        env: { CLAUDE_CONFIG_DIR: configDir },
        listAgents: async () => [{ pid: process.pid, sessionId: CS, cwd, kind: 'interactive', name: 'term', status: 'idle', waitingFor: null, startedAt: Date.now() - 60_000 }],
        cliVersion: async () => '2.1.285 (Claude Code)',
      });
      const app = await buildApp({ config, token, store, webRoot: root, supervisor, questions, bus, hooks, hookToken });
      await app.listen({ host: '127.0.0.1', port });
      w.host = { app, hooks };
      return w.host;
    },
    async stop() {
      const host = w.host;
      w.host = null;
      if (!host) return;
      await host.hooks.close();
      await host.app.close();
    },
  };
  world = w;
  return w;
}

function api(w: World, method: 'GET' | 'POST', url: string, payload?: unknown) {
  return (w.host as Host).app.inject({
    method,
    url,
    headers: { host: `127.0.0.1:${w.port}`, cookie: `sb_token=${w.token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

/** The CLI's call of a hook event to the host (as the script would make it). */
async function hookEvent(w: World, event: Record<string, unknown>): Promise<void> {
  const answer = await fetch(`http://127.0.0.1:${w.port}/hook/v1/event`, {
    method: 'POST',
    headers: { host: `127.0.0.1:${w.port}`, authorization: `Bearer ${(await readFile(w.hookTokenFile, 'utf8')).trim()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ event: { session_id: CS, cwd: w.cwd, transcript_path: w.transcript, ...event }, claudePid: process.pid, entrypoint: 'cli' }),
  });
  expect(answer.status).toBeLessThan(300);
}

interface Spawned {
  readonly exited: Promise<{ code: number | null; stderr: string }>;
  readonly child: ChildProcess;
}

/** The real hook script's waiter, started like the CLI would (stdin = the hook input). */
function spawnWaiter(w: World): Spawned {
  const child = spawn(process.execPath, [SCRIPT, HOOK_MARKER, 'waiter', String(w.port), w.hookTokenFile], {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: String(process.pid) },
  });
  w.children.push(child);
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => child.once('close', (code) => resolve({ code, stderr })));
  child.stdin.end(JSON.stringify({ session_id: CS, cwd: w.cwd, transcript_path: w.transcript, hook_event_name: 'Stop' }));
  return { exited, child };
}

async function until<T>(what: string, check: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function hookIn(w: World): Promise<Session> {
  const hooked = await api(w, 'POST', `/api/terminal-sessions/${CS}/hook`);
  expect(hooked.statusCode).toBe(201);
  return hooked.json() as Session;
}

const detail = async (w: World, id: string): Promise<SessionDetail> => (await api(w, 'GET', `/api/sessions/${id}`)).json() as SessionDetail;

describe('the waiter outlives a Switchboard restart', () => {
  it('retries while the host is down, re-arms on the new host, and a message is delivered exactly once', async () => {
    const w = await setup();
    await w.start();
    await api(w, 'POST', '/api/hooks/install');
    const session = await hookIn(w);
    const waiter = spawnWaiter(w);
    await until('the waiter is held', () => (w.host as Host).hooks.waiterCount === 1);

    // The host restarts (an update, a crash): the held call is answered 503 / the connection drops. The waiter must not exit.
    await w.stop();
    let exited = false;
    void waiter.exited.then(() => (exited = true));
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(exited).toBe(false);
    await w.start();
    await until('the waiter re-armed on the new host', () => (w.host as Host).hooks.waiterCount === 1);

    // A message now reaches it, once.
    expect((await api(w, 'POST', `/api/sessions/${session.id}/messages`, { text: 'Still there?' })).statusCode).toBeLessThan(300);
    const result = await waiter.exited;
    expect(result.code).toBe(2);
    expect(result.stderr).toBe('Still there?');
    expect((w.host as Host).hooks.waiterCount).toBe(0);
    expect(await w.store.pendingMessages.pending(session.id)).toHaveLength(0);
    // Nothing is left to deliver to a later waiter (no double delivery).
    const second = spawnWaiter(w);
    await until('the second waiter is held', () => (w.host as Host).hooks.waiterCount === 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((w.host as Host).hooks.waiterCount).toBe(1);
    second.child.kill('SIGKILL');
    await second.exited;
  }, 40_000);
});

describe('the host\'s explicit stop ends the waiter', () => {
  it('SessionEnd answers 204: exit 0, no retry', async () => {
    const w = await setup();
    await w.start();
    await hookIn(w);
    const waiter = spawnWaiter(w);
    await until('the waiter is held', () => (w.host as Host).hooks.waiterCount === 1);
    await hookEvent(w, { hook_event_name: 'SessionEnd' });
    expect(await waiter.exited).toMatchObject({ code: 0, stderr: '' });
  });

  it('a newer waiter supersedes the older one (204): the older exits 0 and does not fight back', async () => {
    const w = await setup();
    await w.start();
    await hookIn(w);
    const older = spawnWaiter(w);
    await until('the first waiter is held', () => (w.host as Host).hooks.waiterCount === 1);
    const newer = spawnWaiter(w);
    expect(await older.exited).toMatchObject({ code: 0 });
    await until('the newer waiter is held', () => (w.host as Host).hooks.waiterCount === 1);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((w.host as Host).hooks.waiterCount).toBe(1);
    newer.child.kill('SIGKILL');
    await newer.exited;
  }, 20_000);

  it('unhooking the session stops its waiter', async () => {
    const w = await setup();
    await w.start();
    const session = await hookIn(w);
    const waiter = spawnWaiter(w);
    await until('the waiter is held', () => (w.host as Host).hooks.waiterCount === 1);
    expect((await api(w, 'POST', `/api/sessions/${session.id}/close`)).statusCode).toBeLessThan(300);
    expect(await waiter.exited).toMatchObject({ code: 0 });
  });
});

describe('old entries: outdated, then Update hooks', () => {
  it('entries without the waiter\'s timeout are outdated; Update hooks rewrites only Switchboard\'s (backup first)', async () => {
    const w = await setup();
    await w.start();
    await api(w, 'POST', '/api/hooks/install');
    const file = path.join(w.configDir, 'settings.json');
    const current = JSON.parse(await readFile(file, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> };
    expect(current.hooks['Stop']?.some((group) => group.hooks.some((hook) => hook['asyncRewake'] === true && hook['timeout'] === WAITER_HOOK_TIMEOUT_S))).toBe(true);
    // The 1.5.0 install: the waiter without `timeout`, next to another tool's own hook.
    for (const groups of Object.values(current.hooks)) for (const group of groups) for (const hook of group.hooks) if (hook['asyncRewake'] === true) delete hook['timeout'];
    current.hooks['Stop']?.unshift({ hooks: [{ type: 'command', command: 'my-own.sh' }] });
    await writeFile(file, JSON.stringify(current, null, 2));

    const session = await hookIn(w);
    expect(((await api(w, 'GET', '/api/hooks')).json() as HooksStatus).state).toBe('outdated');
    expect((await detail(w, session.id)).hookStatus).toMatchObject({ hooksOutdated: true });

    const updated = (await api(w, 'POST', '/api/hooks/install')).json() as HooksStatus;
    expect(updated.state).toBe('installed');
    expect(updated.lastBackup).toContain('settings.json.switchboard-backup-');
    const after = JSON.parse(await readFile(file, 'utf8')) as typeof current;
    expect(after.hooks['Stop']?.[0]).toEqual({ hooks: [{ type: 'command', command: 'my-own.sh' }] });
    expect(after.hooks['Stop']?.some((group) => group.hooks.some((hook) => hook['asyncRewake'] === true && hook['timeout'] === WAITER_HOOK_TIMEOUT_S))).toBe(true);
    expect((await detail(w, session.id)).hookStatus?.hooksOutdated).toBeUndefined();
  });
});

describe('the status tells "never armed" from "stopped"', () => {
  it('no waiter yet → waiter held → waiter gone: waiter-stopped', async () => {
    const w = await setup();
    await w.start();
    await api(w, 'POST', '/api/hooks/install');
    const session = await hookIn(w);
    expect((await detail(w, session.id)).hookStatus).toMatchObject({ waiter: false, delivery: 'no-waiter' });
    const waiter = spawnWaiter(w);
    await until('the waiter is held', () => (w.host as Host).hooks.waiterCount === 1);
    expect((await detail(w, session.id)).hookStatus).toMatchObject({ waiter: true, delivery: null });
    // The CLI kills it (its timeout): the connection goes away.
    waiter.child.kill('SIGKILL');
    await waiter.exited;
    const stopped = await until('waiter-stopped', async () => {
      const status = (await detail(w, session.id)).hookStatus;
      return status?.delivery === 'waiter-stopped' ? status : null;
    });
    expect(stopped.waiter).toBe(false);
  });
});
