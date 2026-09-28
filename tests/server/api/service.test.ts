import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import type { Providers } from '../../../src/server/providers.ts';
import { LoginService } from '../../../src/server/service/login-service.ts';
import { generateToken } from '../../../src/server/token.ts';
import { fakeServiceCtlCommand } from '../../../tools/fake-servicectl/command.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * M9.1: `GET/PUT /api/service` ("Start at login", additive to the contract,
 * `docs/service.md`) through the real `LoginService` on a temp home with
 * tools/fake-servicectl; behind the usual guard; 501 without a provider.
 */

const PORT = 4871; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

let tmp: string;
let store: Store;
let token: string;
let app: FastifyInstance | null = null;

async function start(providers: Providers): Promise<FastifyInstance> {
  await app?.close();
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
  app = await buildApp({ config, token, store, webRoot: tmp, providers });
  await app.ready();
  return app;
}

function login(env: NodeJS.ProcessEnv = {}): LoginService {
  return new LoginService({
    location: { platform: 'linux', home: path.join(tmp, 'home'), dataDir: path.join(tmp, 'data'), xdgConfigHome: null },
    manager: fakeServiceCtlCommand(),
    env: { ...process.env, FAKE_SERVICECTL_LOG: path.join(tmp, 'ctl.log'), ...env },
    carried: {},
    address: HOST,
    settings: store.settings,
  });
}

beforeEach(async () => {
  tmp = await makeTempDir('api-service');
  store = await openTempStore(tmp);
  token = generateToken();
});

afterEach(async () => {
  await app?.close();
  app = null;
  await store.close();
  await removeTempDir(tmp);
});

const headers = (): Record<string, string> => ({ host: HOST, cookie: `sb_token=${token}` });

describe('GET/PUT /api/service', () => {
  it('reports and changes Start at login on the real code path', async () => {
    const server = await start({ loginService: login() });
    const unit = path.join(tmp, 'home', '.config', 'systemd', 'user', 'switchboard.service');
    const before = await server.inject({ method: 'GET', url: '/api/service', headers: headers() });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ manager: 'systemd', startAtLogin: false, file: unit });

    const on = await server.inject({ method: 'PUT', url: '/api/service', headers: headers(), payload: { startAtLogin: true } });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ manager: 'systemd', startAtLogin: true, file: unit });
    expect((await stat(unit)).isFile()).toBe(true);
    expect(await store.settings.get('service.startAtLogin')).toBe(true);
    expect((await server.inject({ method: 'GET', url: '/api/service', headers: headers() })).json()).toMatchObject({ startAtLogin: true });

    const off = await server.inject({ method: 'PUT', url: '/api/service', headers: headers(), payload: { startAtLogin: false } });
    expect(off.json()).toMatchObject({ startAtLogin: false });
    const calls = (await readFile(path.join(tmp, 'ctl.log'), 'utf8')).trim().split('\n').map((line) => (JSON.parse(line) as { argv: string[] }).argv.join(' '));
    expect(calls).toEqual(['--user daemon-reload', '--user enable switchboard.service', '--user disable switchboard.service', '--user daemon-reload']);
  });

  it('answers 422 for a body without a boolean startAtLogin', async () => {
    const server = await start({ loginService: login() });
    for (const payload of [{}, { startAtLogin: 'yes' }, [true]]) {
      const response = await server.inject({ method: 'PUT', url: '/api/service', headers: headers(), payload });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ error: 'invalid', errors: [{ field: 'startAtLogin', message: 'startAtLogin must be true or false' }] });
    }
  });

  it('answers 409 with the reason when the change is refused', async () => {
    const server = await start({ loginService: login({ FAKE_SERVICECTL_FAIL: 'enable' }) });
    const response = await server.inject({ method: 'PUT', url: '/api/service', headers: headers(), payload: { startAtLogin: true } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'command-failed' });
    expect(response.json().message).toContain('--user enable switchboard.service failed');

    const noNode = await start({ loginService: login({ PATH: path.join(tmp, 'no-bin') }) });
    const refused = await noNode.inject({ method: 'PUT', url: '/api/service', headers: headers(), payload: { startAtLogin: true } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'node-missing', message: 'Node.js ≥ 24 must be on PATH: no node was found there.' });
  });

  it('answers 501 without a provider, so a bare app can never touch the OS', async () => {
    const server = await start({});
    for (const method of ['GET', 'PUT'] as const) {
      const response = await server.inject({ method, url: '/api/service', headers: headers(), ...(method === 'PUT' ? { payload: { startAtLogin: true } } : {}) });
      expect(response.statusCode).toBe(501);
      expect(response.json()).toEqual({ error: 'not-implemented', item: 'M9.1' });
    }
  });

  it('stays behind the cookie guard', async () => {
    const server = await start({ loginService: login() });
    expect((await server.inject({ method: 'GET', url: '/api/service', headers: { host: HOST } })).statusCode).toBe(401);
    expect((await server.inject({ method: 'PUT', url: '/api/service', headers: { host: HOST }, payload: { startAtLogin: true } })).statusCode).toBe(401);
  });
});
