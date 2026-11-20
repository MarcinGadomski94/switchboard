import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as pty from '@lydell/node-pty';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TerminalInfo, TerminalServerFrame, TerminalsView } from '../../../src/core/terminals.ts';
import type { UserProfile } from '../../../src/core/user-profiles.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { listenLoopback } from '../../../src/server/listen.ts';
import { type PtyProcess, type PtySpawner, TerminalService } from '../../../src/server/terminals/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import { rawCall } from '../../helpers/devices.ts';
import { freeTestPorts, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D182 (`docs/terminals.md` → *The agent's terminal*): the terminal at the bottom of an agent's
 * conversation. It starts in the agent's folder (a real pseudo-terminal running a Node echo
 * program, never a shell), is not on the Terminals page, closes when the page closes it and by
 * itself shortly after its last tab (here 400 ms), and is refused for another profile's agent, an
 * archived one, a paired computer's one and an agent whose folder is gone.
 */

const ECHO = "process.stdin.setEncoding('utf8');process.stdin.on('data',d=>process.stdout.write('echo:'+d.trim()+'\\r\\n'));process.stdout.write('ready\\r\\n')";
const GRACE_MS = 400;

describe('D182 · the agent’s terminal', () => {
  let dir: string;
  let store: Store;
  let app: FastifyInstance;
  let token: string;
  let port: number;
  let ann: UserProfile;
  let annCookie: string;
  let defaultCookie: string;
  const started: Array<{ cwd: string; pid: number }> = [];
  const spawner: PtySpawner = (_file, _args, options) => {
    const proc = pty.spawn(process.execPath, ['-e', ECHO], options) as unknown as PtyProcess;
    started.push({ cwd: options.cwd, pid: proc.pid });
    return proc;
  };
  const call = (method: string, route: string, body?: unknown, profileCookie?: string) =>
    rawCall(port, method, route, { host: `127.0.0.1:${port}`, cookie: `sb_token=${token}${profileCookie ? `; ${profileCookie}` : ''}` }, body);
  const agent = async (fields: { folder: string | null; closed?: boolean; profile?: string }): Promise<string> => {
    const record = await store.sessions.create({ name: `acme-${randomUUID().slice(0, 6)}`, claudeSessionId: randomUUID(), cwd: fields.folder, root: fields.folder, ...(fields.profile ? { userProfileId: fields.profile } : {}) });
    if (fields.closed) await store.sessions.update(record.id, { closedAt: new Date().toISOString() });
    return record.id;
  };
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (test: () => boolean | Promise<boolean>, what: string): Promise<void> => {
    const end = Date.now() + 10_000;
    while (Date.now() < end) {
      if (await test()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out: ${what}`);
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sb-agent-terminal-'));
    store = await openTempStore(dir);
    token = generateToken();
    port = (await freeTestPorts())[0] as number;
    const terminals = new TerminalService({ spawn: spawner, home: dir, idleMs: 0, env: { ...process.env, SWITCHBOARD_TEST_AGENT_TERMINAL_GRACE_MS: String(GRACE_MS) } });
    const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: path.join(dir, 'data') }, platform: process.platform, home: dir, cwd: dir }), port };
    app = await buildApp({ config, token, store, webRoot: dir, bus: new HubBus(), agentTools: false, terminals });
    await listenLoopback(app, { port });
    ann = (await call('POST', '/api/user-profiles', { name: 'Ann', color: 'green' })).body as UserProfile;
    const cookieOf = async (id: string): Promise<string> => {
      const answer = await call('POST', '/api/user-profiles/switch', { id });
      return String(([] as string[]).concat(answer.headers['set-cookie'] ?? [])[0]).split(';')[0] as string;
    };
    annCookie = await cookieOf(ann.id);
    defaultCookie = await cookieOf('default');
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await store.close();
    await removeTempDir(dir);
  });

  it('starts in the agent’s folder, echoes over its socket, is not on the Terminals page, and Close ends its program', async () => {
    const folder = path.join(dir, 'acme-workspace');
    await mkdir(folder, { recursive: true });
    const id = await agent({ folder });
    const opened = await call('POST', `/api/sessions/${id}/terminal`, { cols: 100, rows: 30 });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const info = opened.body as TerminalInfo;
    expect(info).toMatchObject({ sessionId: id, cols: 100, rows: 30, cwd: await realpath(folder) });
    expect(started.at(-1)?.cwd).toBe(await realpath(folder));
    // Not listed with the Terminals page's terminals; still reachable by its id.
    expect(((await call('GET', '/api/terminals')).body as TerminalsView).terminals.map((t) => t.id)).not.toContain(info.id);
    expect((await call('GET', `/api/terminals/${info.id}`)).status).toBe(200);
    // Its socket is D170's.
    const Socket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;
    const socket = new Socket(`ws://127.0.0.1:${port}/api/terminals/${info.id}/socket`, { headers: { origin: `http://127.0.0.1:${port}`, cookie: `sb_token=${token}` } });
    const frames: TerminalServerFrame[] = [];
    socket.addEventListener('message', (event: MessageEvent) => frames.push(JSON.parse(String(event.data)) as TerminalServerFrame));
    await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
    const text = (): string => frames.map((f) => (f.t === 'out' ? f.d : f.t === 'hello' ? f.scrollback : '')).join('');
    await until(() => text().includes('ready'), 'the program’s first line');
    socket.send(JSON.stringify({ t: 'in', d: 'acme\r' }));
    await until(() => text().includes('echo:acme'), 'the echo');
    // Leaving the conversation: the page closes it, and its program ends.
    const pid = started.at(-1)?.pid as number;
    expect((await call('DELETE', `/api/terminals/${info.id}`)).status).toBe(204);
    await until(() => !alive(pid), 'the program ended');
    expect((await call('GET', `/api/terminals/${info.id}`)).status).toBe(404);
    socket.close();
  }, 30_000);

  it('closes by itself shortly after its last tab (a closed browser tab), and when no tab ever attached', async () => {
    const folder = path.join(dir, 'acme-repo');
    await mkdir(folder, { recursive: true });
    const id = await agent({ folder });
    const info = (await call('POST', `/api/sessions/${id}/terminal`, {})).body as TerminalInfo;
    const pid = started.at(-1)?.pid as number;
    const Socket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;
    const socket = new Socket(`ws://127.0.0.1:${port}/api/terminals/${info.id}/socket`, { headers: { origin: `http://127.0.0.1:${port}`, cookie: `sb_token=${token}` } });
    await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
    // Attached past the grace: it stays.
    await new Promise((r) => setTimeout(r, GRACE_MS * 2));
    expect((await call('GET', `/api/terminals/${info.id}`)).status).toBe(200);
    // The tab goes (no DELETE): gone after the grace, its program too.
    socket.close();
    await until(async () => (await call('GET', `/api/terminals/${info.id}`)).status === 404, 'closed after its last tab');
    await until(() => !alive(pid), 'the program ended');
    // Never attached: gone after the grace too.
    const lonely = (await call('POST', `/api/sessions/${id}/terminal`, {})).body as TerminalInfo;
    await until(async () => (await call('GET', `/api/terminals/${lonely.id}`)).status === 404, 'a terminal no tab attached to');
  }, 30_000);

  it('refuses another profile’s agent (404), an archived one, a paired computer’s one and a missing folder (409)', async () => {
    const folder = path.join(dir, 'acme-refusals');
    await mkdir(folder, { recursive: true });
    const defaults = await agent({ folder });
    // A browser in Ann's profile: Default's agent does not exist for it.
    expect((await call('POST', `/api/sessions/${defaults}/terminal`, {}, annCookie)).status).toBe(404);
    // A browser in Default: it opens, owned by Default (Ann can't attach to it either).
    const mine = await call('POST', `/api/sessions/${defaults}/terminal`, {}, defaultCookie);
    expect(mine.status).toBe(201);
    const id = (mine.body as TerminalInfo).id;
    expect((await call('GET', `/api/terminals/${id}`, undefined, annCookie)).status).toBe(404);
    await call('DELETE', `/api/terminals/${id}`, undefined, defaultCookie);
    const archived = await agent({ folder, closed: true });
    expect((await call('POST', `/api/sessions/${archived}/terminal`, {})).body).toMatchObject({ error: 'closed' });
    const gone = await agent({ folder: path.join(dir, 'no-such-folder') });
    expect((await call('POST', `/api/sessions/${gone}/terminal`, {})).body).toMatchObject({ error: 'folder-missing' });
    // A paired computer's agent: refused here (the guard's 404 for an unknown machine, else the route's 409 `remote`).
    expect([404, 409]).toContain((await call('POST', `/api/sessions/r~abcdefghijkl~${randomUUID()}/terminal`, {})).status);
    expect((await call('POST', `/api/sessions/${randomUUID()}/terminal`, {})).status).toBe(404);
  }, 30_000);
});
