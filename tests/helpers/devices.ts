import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.ts';
import { type ServerConfig, loadConfig } from '../../src/server/config.ts';
import type { Store } from '../../src/server/db/store.ts';
import { DeviceService } from '../../src/server/devices/service.ts';
import { HubBus } from '../../src/server/hub/bus.ts';
import { listenLoopback } from '../../src/server/listen.ts';
import { generateToken } from '../../src/server/token.ts';
import { fakeTailscaleBinEnv } from '../../tools/fake-tailscale/command.ts';
import { freeTestPorts, makeTempDir, removeTempDir } from './net.ts';
import { openTempStore } from './store.ts';

/**
 * D73 test world (`docs/devices.md` → *Tests*): one Switchboard app in this
 * process, listening on a loopback test port (the UI listener), with its
 * {@link DeviceService} started and device access switched on (the device listener
 * on a second test port; `tailscale` is `tools/fake-tailscale`). The devices'
 * origin is `http://localhost:<device port>` (`SWITCHBOARD_DEVICE_TEST_ORIGIN`),
 * so requests reach the device listener directly with the Host a browser would send.
 */

/** A raw answer. */
export interface Answer {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly text: string;
  readonly body: any;
}

/** Options of a request. */
export interface CallOptions {
  readonly cookie?: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}

/** The world. */
export interface DeviceWorld {
  readonly dir: string;
  readonly app: FastifyInstance;
  readonly store: Store;
  readonly bus: HubBus;
  readonly config: ServerConfig;
  readonly devices: DeviceService;
  readonly token: string;
  readonly uiPort: number;
  devicePort: number;
  /** `http://localhost:<device port>`. */
  origin: string;
  /** Free test ports left for the test (e.g. a fake push service). */
  readonly spare: readonly number[];
  /** This machine's UI (the `sb_token` cookie, a loopback Host). */
  ui(method: string, route: string, body?: unknown): Promise<Answer>;
  /** The device listener, Host `localhost:<device port>`, no Origin unless given. */
  device(method: string, route: string, options?: CallOptions): Promise<Answer>;
  /**
   * `PUT /api/devices/access` with `enabled: true` (plus `extra`) on a free test
   * port, retrying on another one while the listener cannot bind (parallel test
   * files share the port range); the state, and {@link devicePort} follows.
   */
  enableAccess(extra?: Record<string, unknown>): Promise<any>;
  /** Makes a code on the UI and pairs a device with it; the cookie header value (`__Host-sb_device=…`) and the device id. */
  pair(name?: string): Promise<{ readonly cookie: string; readonly id: string }>;
  close(): Promise<void>;
}

/** Options of {@link startDeviceWorld}. */
export interface DeviceWorldOptions {
  /** Extra `SWITCHBOARD_*` / `FAKE_TAILSCALE_*` settings (process env for the fake CLI too). */
  readonly env?: Record<string, string>;
  /** Leave device access off. */
  readonly accessOff?: boolean;
  /** Push deliveries' fetch (default the real one, to the fake push service). */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** One HTTP request over a real socket to 127.0.0.1:`port` with full control of Host. */
export function rawCall(port: number, method: string, route: string, headers: Record<string, string>, body?: unknown): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: route,
        agent: false,
        headers: { accept: 'application/json', ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }), ...headers },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => {
          let parsed: unknown = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body: parsed });
        });
      },
    );
    req.once('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** The `name=value` of the device cookie in a `Set-Cookie` answer, `null` when none. */
export function deviceCookieOf(answer: Answer): string | null {
  const values = ([] as string[]).concat(answer.headers['set-cookie'] ?? []);
  for (const value of values) {
    const pair = value.split(';')[0]?.trim() ?? '';
    if (pair.startsWith('__Host-sb_device=') && pair.length > '__Host-sb_device='.length) return pair;
  }
  return null;
}

/** Ports in a random order (parallel test files then rarely pick the same one). */
function shuffled(ports: readonly number[]): number[] {
  const list = [...ports];
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j] as number, list[i] as number];
  }
  return list;
}

/** Starts a world (see the module comment), retrying on other ports when one is taken meanwhile. */
export async function startDeviceWorld(options: DeviceWorldOptions = {}): Promise<DeviceWorld> {
  let last: unknown = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await startOnce(options);
    } catch (error) {
      last = error;
      if (!/EADDRINUSE|could not start|need two free/.test(String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 200));
    }
  }
  throw last;
}

async function startOnce(options: DeviceWorldOptions): Promise<DeviceWorld> {
  const ports = shuffled(await freeTestPorts());
  if (ports.length < 2) throw new Error('need two free test ports');
  const [uiPort, firstDevicePort, ...spare] = ports as [number, number, ...number[]];
  const dir = await makeTempDir('devices');
  const webRoot = path.join(dir, 'web');
  await mkdir(webRoot, { recursive: true });
  await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><html><body><div id="root">switchboard-ui</div></body></html>');
  await writeFile(path.join(webRoot, 'manifest.webmanifest'), '{"name":"Switchboard"}');
  const env: Record<string, string> = {
    SWITCHBOARD_DATA_DIR: path.join(dir, 'data'),
    SWITCHBOARD_TAILSCALE_BIN: fakeTailscaleBinEnv(),
    ...options.env,
  };
  // The fake CLI reads its FAKE_* settings from this process's environment.
  for (const [key, value] of Object.entries(env)) if (key.startsWith('FAKE_')) process.env[key] = value;
  const store = await openTempStore(dir);
  const bus = new HubBus();
  const token = generateToken();
  // The devices' origin follows the device port (the test origin of the config, changed by enableAccess).
  const config: { -readonly [K in keyof ServerConfig]: ServerConfig[K] } = {
    ...loadConfig({ env: { ...env, SWITCHBOARD_DEVICE_TEST_ORIGIN: `http://localhost:${firstDevicePort}` }, platform: 'linux', home: dir, cwd: dir }),
    port: uiPort,
  };
  const devices = new DeviceService({ config, store, bus, machineName: async () => 'devbox', ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}), onError: () => undefined });
  const app = await buildApp({ config, token, store, webRoot, bus, devices, agentTools: false });
  const cleanup = async (): Promise<void> => {
    await app.close().catch(() => undefined);
    await devices.close();
    await store.close();
    for (const key of Object.keys(env)) if (key.startsWith('FAKE_')) delete process.env[key];
    await removeTempDir(dir);
  };
  try {
    await listenLoopback(app, { port: uiPort });
    await devices.start();
  } catch (error) {
    await cleanup();
    throw error;
  }
  const ui = (method: string, route: string, body?: unknown) => rawCall(uiPort, method, route, { host: `127.0.0.1:${uiPort}`, cookie: `sb_token=${token}` }, body);
  const world: DeviceWorld = {
    dir,
    app,
    store,
    bus,
    config,
    devices,
    token,
    uiPort,
    devicePort: firstDevicePort,
    origin: `http://localhost:${firstDevicePort}`,
    spare,
    ui,
    device(method: string, route: string, call: CallOptions = {}) {
      return rawCall(world.devicePort, method, route, { host: `localhost:${world.devicePort}`, ...(call.cookie ? { cookie: call.cookie } : {}), ...call.headers }, call.body);
    },
    async enableAccess(extra: Record<string, unknown> = {}) {
      let state: any = null;
      // Other test files share the port range (a two-machine test takes six): wait for a free one, up to ~15 s.
      for (let round = 0; round < 30; round++) {
        for (const port of [world.devicePort, ...shuffled(await freeTestPorts()).filter((p) => p !== world.devicePort)]) {
          world.devicePort = port;
          world.origin = `http://localhost:${port}`;
          config.deviceTestOrigin = world.origin;
          state = (await ui('PUT', '/api/devices/access', { ...extra, enabled: true, port })).body;
          if (!String(state?.message ?? '').includes('EADDRINUSE')) return state;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return state;
    },
    async pair(name?: string) {
      const code = await ui('POST', '/api/devices/pairing');
      if (code.status !== 200) throw new Error(`pairing code: ${code.status} ${code.text}`);
      const paired = await world.device('POST', '/device/v1/pair', { body: { code: code.body.code, ...(name ? { name } : {}) }, headers: { origin: world.origin, 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' } });
      const cookie = deviceCookieOf(paired);
      if (paired.status !== 201 || !cookie) throw new Error(`pair: ${paired.status} ${paired.text}`);
      return { cookie, id: paired.body.device.id as string };
    },
    close: cleanup,
  };
  if (!options.accessOff) {
    const state = await world.enableAccess();
    if (state?.https !== 'ok') {
      await cleanup();
      throw new Error(`device access could not start: ${JSON.stringify(state)}`);
    }
  }
  return world;
}
