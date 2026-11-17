import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
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
import { type DeviceWorld, rawCall, startDeviceWorld } from '../../helpers/devices.ts';
import { freeTestPorts, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D170 (`docs/terminals.md`): terminals over a real pseudo-terminal and real sockets. The program
 * is a deterministic `node -e` echo (never a real shell or the developer's profile): it prints
 * `echo:<input>`. Three profiles (Default, Ann with a password, Bo): strictly only mine; the
 * socket behind the same guard as `/api` (Origin, token cookie); scrollback on reattach; resize;
 * Close ends the program; a start folder outside the allowed places is refused; a paired phone
 * with its device credential.
 */

const ECHO = "process.stdin.setEncoding('utf8');process.stdin.on('data',d=>process.stdout.write('echo:'+d.trim()+'\\r\\n'));process.stdout.write('ready\\r\\n')";

/** node-pty, with the shell swapped for the echo program (the service still does everything else). */
export const echoSpawner: PtySpawner = (_file, _args, options) => pty.spawn(process.execPath, ['-e', ECHO], options) as unknown as PtyProcess;

interface Client {
  readonly socket: WebSocket;
  readonly frames: TerminalServerFrame[];
  readonly closed: Promise<number>;
  until(test: (frames: readonly TerminalServerFrame[]) => boolean, what: string): Promise<void>;
  type(text: string): void;
}

/** Opens a terminal socket with `headers` (the cookie, the Origin a browser sends). */
function connect(url: string, headers: Record<string, string>): Promise<Client> {
  const Socket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;
  const socket = new Socket(url, { headers });
  const frames: TerminalServerFrame[] = [];
  let closedResolve: (code: number) => void = () => undefined;
  const closed = new Promise<number>((resolve) => {
    closedResolve = resolve;
  });
  socket.addEventListener('message', (event: MessageEvent) => frames.push(JSON.parse(String(event.data)) as TerminalServerFrame));
  socket.addEventListener('close', (event: CloseEvent) => closedResolve(event.code));
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () =>
      resolve({
        socket,
        frames,
        closed,
        async until(test, what) {
          const end = Date.now() + 10_000;
          while (Date.now() < end) {
            if (test(frames)) return;
            await new Promise((r) => setTimeout(r, 25));
          }
          throw new Error(`timed out: ${what} (frames: ${JSON.stringify(frames).slice(0, 400)})`);
        },
        type(text) {
          socket.send(JSON.stringify({ t: 'in', d: text }));
        },
      }),
    );
    socket.addEventListener('error', () => reject(new Error('socket refused')));
  });
}

const output = (frames: readonly TerminalServerFrame[]): string => frames.map((frame) => (frame.t === 'out' ? frame.d : frame.t === 'hello' ? frame.scrollback : '')).join('');

describe('D170 · terminals on this computer', () => {
  let dir: string;
  let home: string;
  let store: Store;
  let app: FastifyInstance;
  let token: string;
  let port: number;
  let terminals: TerminalService;
  let ann: UserProfile;
  let bo: UserProfile;
  let annCookie: string;
  let boCookie: string;

  const host = (): string => `127.0.0.1:${port}`;
  const origin = (): string => `http://127.0.0.1:${port}`;
  const call = (method: string, route: string, body?: unknown, profileCookie?: string) =>
    rawCall(port, method, route, { host: host(), cookie: `sb_token=${token}${profileCookie ? `; ${profileCookie}` : ''}` }, body);
  const socketUrl = (id: string): string => `ws://127.0.0.1:${port}/api/terminals/${id}/socket`;
  const browser = (profileCookie?: string): Record<string, string> => ({ origin: origin(), cookie: `sb_token=${token}${profileCookie ? `; ${profileCookie}` : ''}` });

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sb-terminals-'));
    home = path.join(dir, 'home');
    await mkdir(home, { recursive: true });
    store = await openTempStore(dir);
    token = generateToken();
    port = (await freeTestPorts())[0] as number;
    terminals = new TerminalService({ spawn: echoSpawner, home, idleMs: 0 });
    const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: path.join(dir, 'data') }, platform: process.platform, home: dir, cwd: dir }), port };
    app = await buildApp({ config, token, store, webRoot: dir, bus: new HubBus(), agentTools: false, terminals });
    await listenLoopback(app, { port });
    ann = (await call('POST', '/api/user-profiles', { name: 'Ann', color: 'green', password: 'ann-secret' })).body as UserProfile;
    bo = (await call('POST', '/api/user-profiles', { name: 'Bo', color: 'amber' })).body as UserProfile;
    const cookieOf = async (id: string, password?: string): Promise<string> => {
      const answer = await call('POST', '/api/user-profiles/switch', { id, ...(password ? { password } : {}) });
      return String(([] as string[]).concat(answer.headers['set-cookie'] ?? [])[0]).split(';')[0] as string;
    };
    annCookie = await cookieOf(ann.id, 'ann-secret');
    boCookie = await cookieOf(bo.id);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await store.close();
    await removeTempDir(dir);
  });

  it('opens a terminal in the home folder, echoes what is typed, replays the scrollback on reattach, resizes, and Close ends its program', async () => {
    const view = (await call('GET', '/api/terminals', undefined, annCookie)).body as TerminalsView;
    expect(view.terminals).toEqual([]);
    expect(view.shells[0]?.id).toBe('default');
    expect(view.max).toBe(16);
    const created = await call('POST', '/api/terminals', { cols: 100, rows: 30 }, annCookie);
    expect(created.status, created.text).toBe(201);
    const info = created.body as TerminalInfo;
    expect(info).toMatchObject({ cols: 100, rows: 30, exited: null, clients: 0 });

    const first = await connect(socketUrl(info.id), browser(annCookie));
    await first.until((frames) => frames[0]?.t === 'hello', 'the hello');
    await first.until((frames) => output(frames).includes('ready'), 'the program to start');
    first.type('hi\r');
    await first.until((frames) => output(frames).includes('echo:hi'), 'the echo');
    // A second client (a reload, another device) gets what was printed so far.
    const second = await connect(socketUrl(info.id), browser(annCookie));
    await second.until((frames) => frames[0]?.t === 'hello' && frames[0].scrollback.includes('echo:hi'), 'the scrollback');
    expect(((await call('GET', `/api/terminals/${info.id}`, undefined, annCookie)).body as TerminalInfo).clients).toBe(2);
    second.socket.send(JSON.stringify({ t: 'resize', cols: 120, rows: 40 }));
    // A malformed frame is dropped, the socket stays.
    second.socket.send('not json');
    second.socket.send(JSON.stringify({ t: 'resize', cols: 1, rows: 40 }));
    await first.until(() => true, '');
    await new Promise((r) => setTimeout(r, 200));
    expect((await call('GET', `/api/terminals/${info.id}`, undefined, annCookie)).body).toMatchObject({ cols: 120, rows: 40 });

    // Close: both sockets end, the program is gone, the list is empty.
    expect((await call('DELETE', `/api/terminals/${info.id}`, undefined, annCookie)).status).toBe(204);
    expect(await first.closed).toBe(1000);
    expect(await second.closed).toBe(1000);
    expect(first.frames.some((frame) => frame.t === 'closed')).toBe(true);
    expect(((await call('GET', '/api/terminals', undefined, annCookie)).body as TerminalsView).terminals).toEqual([]);
  });

  it('strictly only mine: another profile neither lists, reads, attaches to nor closes it', async () => {
    const info = (await call('POST', '/api/terminals', {}, annCookie)).body as TerminalInfo;
    expect(((await call('GET', '/api/terminals', undefined, boCookie)).body as TerminalsView).terminals).toEqual([]);
    expect(((await call('GET', '/api/terminals')).body as TerminalsView).terminals).toEqual([]);
    expect((await call('GET', `/api/terminals/${info.id}`, undefined, boCookie)).status).toBe(404);
    expect((await call('DELETE', `/api/terminals/${info.id}`, undefined, boCookie)).status).toBe(404);
    const intruder = await connect(socketUrl(info.id), browser(boCookie));
    expect(await intruder.closed).toBe(4404);
    expect(intruder.frames).toEqual([]);
    expect((await call('DELETE', `/api/terminals/${info.id}`, undefined, annCookie)).status).toBe(204);
  });

  it('the socket is behind the same guard as /api: a foreign Origin, no token or a wrong Host is refused before any upgrade', async () => {
    const info = (await call('POST', '/api/terminals', {}, annCookie)).body as TerminalInfo;
    const upgrade = (headers: Record<string, string>) =>
      rawCall(port, 'GET', `/api/terminals/${info.id}/socket`, { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'), ...headers });
    expect((await upgrade({ host: host(), origin: 'http://evil.example', cookie: `sb_token=${token}; ${annCookie}` })).status).toBe(403);
    expect((await upgrade({ host: host(), origin: origin() })).status).toBe(401);
    expect((await upgrade({ host: 'evil.example', origin: origin(), cookie: `sb_token=${token}` })).status).toBe(403);
    await expect(connect(socketUrl(info.id), { origin: 'http://localhost:1', cookie: `sb_token=${token}; ${annCookie}` })).rejects.toThrow('socket refused');
    expect((await call('DELETE', `/api/terminals/${info.id}`, undefined, annCookie)).status).toBe(204);
  });

  it('a start folder: home or a saved folder of this profile; anything else is refused; a browser in no profile cannot open one', async () => {
    expect((await call('POST', '/api/terminals', { cwd: os.tmpdir() }, annCookie)).status).toBe(403);
    expect((await call('POST', '/api/terminals', { cwd: 'relative/path' }, annCookie)).status).toBe(422);
    expect((await call('POST', '/api/terminals', { folderId: 'nope' }, annCookie)).status).toBe(404);
    const inHome = await call('POST', '/api/terminals', { cwd: home }, annCookie);
    expect(inHome.status).toBe(201);
    expect((await call('DELETE', `/api/terminals/${(inHome.body as TerminalInfo).id}`, undefined, annCookie)).status).toBe(204);
    // Default gets a password: a browser without a profile cookie is then in no profile.
    expect((await call('PUT', '/api/user-profiles/default', { password: 'default-secret' })).status).toBe(200);
    expect((await call('POST', '/api/terminals', {})).status).toBe(403);
  });
});

describe('D170 · a terminal from a paired phone (device listener, its credential)', () => {
  let world: DeviceWorld;
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'sb-terminals-home-'));
    world = await startDeviceWorld({ terminals: new TerminalService({ spawn: echoSpawner, home, idleMs: 0 }) });
  }, 60_000);

  afterAll(async () => {
    await world?.close();
    await removeTempDir(home);
  });

  it('opens and uses a terminal with the device credential; without it the upgrade is refused', async () => {
    const { cookie } = await world.pair('Phone');
    const created = await world.device('POST', '/api/terminals', { cookie, headers: { origin: world.origin }, body: {} });
    expect(created.status, created.text).toBe(201);
    const id = (created.body as TerminalInfo).id;
    const phone = await connect(`ws://localhost:${world.devicePort}/api/terminals/${id}/socket`, { origin: world.origin, cookie });
    await phone.until((frames) => output(frames).includes('ready'), 'the program');
    phone.type('from the phone\r');
    await phone.until((frames) => output(frames).includes('echo:from the phone'), 'the echo');
    phone.socket.close();
    // No device credential: refused before any upgrade.
    const refused = await rawCall(world.devicePort, 'GET', `/api/terminals/${id}/socket`, { host: `localhost:${world.devicePort}`, origin: world.origin, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64') });
    expect([401, 403]).toContain(refused.status);
    expect((await world.device('DELETE', `/api/terminals/${id}`, { cookie, headers: { origin: world.origin } })).status).toBe(204);
  });
});
