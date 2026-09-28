import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.ts';
import { loadConfig } from '../../src/server/config.ts';
import { BindRefusedError, assertLoopbackBind, listenLoopback } from '../../src/server/listen.ts';
import type { Store } from '../../src/server/db/store.ts';
import { generateToken } from '../../src/server/token.ts';
import { TEST_PORTS, freeTestPorts, makeTempDir, rawRequest, removeTempDir } from '../helpers/net.ts';
import { openTempStore } from '../helpers/store.ts';

let tmp: string;
let store: Store;
const apps: FastifyInstance[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('listen');
  store = await openTempStore(tmp);
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await store.close();
  await removeTempDir(tmp);
});

async function makeApp(port: number, token = generateToken()): Promise<FastifyInstance> {
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, cwd: tmp }), port };
  const app = await buildApp({ config, token, store, webRoot: tmp });
  apps.push(app);
  return app;
}

/** Listens on the first free test port (4871–4879), retrying if a parallel test took it. */
async function listenOnTestPort(token?: string): Promise<{ app: FastifyInstance; port: number }> {
  for (const port of await freeTestPorts()) {
    const app = await makeApp(port, token);
    try {
      await listenLoopback(app, { port });
      return { app, port };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('no free test port in 4871-4879');
}

/** A non-loopback IPv4 address of this machine, if it has one. */
function lanAddress(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return undefined;
}

describe('bind address', () => {
  it.each(['0.0.0.0', '::', '192.168.1.10', '10.0.0.5', 'localhost', '::1', '127.0.0.2', ''])('refuses to bind to %j', (host) => {
    expect(() => assertLoopbackBind(host)).toThrow(BindRefusedError);
  });

  it.each(['0.0.0.0', '::', 'localhost'])('listenLoopback refuses %j before opening a socket', async (host) => {
    const [port] = await freeTestPorts();
    const app = await makeApp(port!);
    await expect(listenLoopback(app, { host, port: port! })).rejects.toBeInstanceOf(BindRefusedError);
    expect(app.server.listening).toBe(false);
  });

  it('binds 127.0.0.1 only', async () => {
    const { app, port } = await listenOnTestPort();
    const address = app.server.address();
    expect(address).toMatchObject({ address: '127.0.0.1', family: 'IPv4', port });
    expect(TEST_PORTS).toContain(port);

    const lan = lanAddress();
    if (lan) {
      // The same port is not reachable on the machine's LAN address.
      await expect(rawRequest({ port, path: '/', connectHost: lan })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    }
  });
});

describe('guard over a real socket', () => {
  it('rejects foreign Host / Origin and a missing cookie; the page sets the cookie', async () => {
    const token = generateToken();
    const { port } = await listenOnTestPort(token);
    const host = `127.0.0.1:${port}`;

    const rebinding = await rawRequest({ port, path: '/', headers: { host: `evil.example:${port}`, 'sec-fetch-site': 'none' } });
    expect(rebinding.status).toBe(403);
    expect(rebinding.headers['set-cookie']).toBeUndefined();

    const noHost = await rawRequest({ port, path: '/', setHost: false });
    expect([400, 403]).toContain(noHost.status);

    const foreignOrigin = await rawRequest({
      port,
      path: '/api/sessions',
      method: 'POST',
      headers: { host, origin: 'http://evil.example', cookie: `sb_token=${token}` },
    });
    expect(foreignOrigin.status).toBe(403);

    const noCookie = await rawRequest({ port, path: '/api/sessions', headers: { host } });
    expect(noCookie.status).toBe(401);
    const hubNoCookie = await rawRequest({ port, path: '/hub', headers: { host } });
    expect(hubNoCookie.status).toBe(401);

    const page = await rawRequest({ port, path: '/', headers: { host, 'sec-fetch-site': 'none' } });
    expect(page.status).toBe(200);
    expect(page.headers['set-cookie']).toEqual([`sb_token=${token}; Path=/; HttpOnly; SameSite=Strict`]);

    const withCookie = await rawRequest({ port, path: '/api/sessions', headers: { host, cookie: `sb_token=${token}` } });
    expect(withCookie.status).toBe(200); // past the guard; the real route (M2.1) lists the (empty) sessions
    expect(JSON.parse(withCookie.body)).toEqual([]);
  });
});
