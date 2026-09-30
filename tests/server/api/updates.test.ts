import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UpdateStatus } from '../../../src/core/updates.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import type { Providers, UpdatesProvider } from '../../../src/server/providers.ts';
import { generateToken } from '../../../src/server/token.ts';
import { UpdateError } from '../../../src/server/updates/service.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/** D55: `/api/updates*` (additive), behind the usual guard; 501 without an updater. */

const PORT = 4871;
const HOST = `127.0.0.1:${PORT}`;
let tmp: string;
let store: Store;
let token: string;
let app: FastifyInstance | null = null;

const STATUS: UpdateStatus = {
  current: '1.0.0',
  install: { kind: 'release', dir: '/opt/switchboard-1.0.0' },
  restart: 'service',
  repo: 'acme/switchboard',
  checking: false,
  lastCheck: { at: '2026-09-30T08:00:00.000Z', ok: true, via: 'api', error: null },
  latest: { version: '1.1.0', tag: 'v1.1.0', name: 'Switchboard 1.1.0', notes: '', publishedAt: null, url: null },
  available: true,
  dismissed: null,
  progress: { phase: 'idle', version: null, message: '', error: null, dir: null, at: null },
  previous: null,
  liveSessions: 0,
};

async function start(providers: Providers): Promise<FastifyInstance> {
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
  app = await buildApp({ config, token, store, webRoot: tmp, providers });
  await app.ready();
  return app;
}

beforeEach(async () => {
  tmp = await makeTempDir('api-updates');
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

describe('/api/updates', () => {
  it('answers 501 without an updater (the demo, SWITCHBOARD_UPDATES=off, bare tests)', async () => {
    const server = await start({});
    for (const [method, url] of [['GET', '/api/updates'], ['POST', '/api/updates/check'], ['POST', '/api/updates/install'], ['POST', '/api/updates/dismiss']] as const) {
      const response = await server.inject({ method, url, headers: headers(), ...(method === 'POST' ? { payload: { version: '1.1.0' } } : {}) });
      expect(response.statusCode, url).toBe(501);
      expect(response.json()).toEqual({ error: 'not-implemented', item: 'D55' });
    }
  });

  it('status, check, install (202), dismiss, and the refusals', async () => {
    const calls: string[] = [];
    const updates: UpdatesProvider = {
      status: () => STATUS,
      check: async () => (calls.push('check'), { ...STATUS, checking: false }),
      install: (version) => {
        calls.push(`install ${version}`);
        if (version === '9.9.9') throw new UpdateError('stale-version', 'The newest release is 1.1.0, not 9.9.9.');
        if (version === 'busy') throw new UpdateError('busy', 'An update is already running.');
        return { ...STATUS, progress: { ...STATUS.progress, phase: 'downloading', version } };
      },
      dismiss: async (version) => (calls.push(`dismiss ${version}`), { ...STATUS, dismissed: version }),
    };
    const server = await start({ updates });
    expect((await server.inject({ method: 'GET', url: '/api/updates', headers: headers() })).json()).toEqual(STATUS);
    expect((await server.inject({ method: 'POST', url: '/api/updates/check', headers: headers() })).statusCode).toBe(200);
    const install = await server.inject({ method: 'POST', url: '/api/updates/install', headers: headers(), payload: { version: '1.1.0' } });
    expect(install.statusCode).toBe(202);
    expect(install.json().progress.phase).toBe('downloading');
    const stale = await server.inject({ method: 'POST', url: '/api/updates/install', headers: headers(), payload: { version: '9.9.9' } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'stale-version', message: 'The newest release is 1.1.0, not 9.9.9.' });
    expect((await server.inject({ method: 'POST', url: '/api/updates/install', headers: headers(), payload: { version: 'busy' } })).json().error).toBe('busy');
    expect((await server.inject({ method: 'POST', url: '/api/updates/install', headers: headers(), payload: {} })).statusCode).toBe(422);
    expect((await server.inject({ method: 'POST', url: '/api/updates/dismiss', headers: headers(), payload: { version: '1.1.0' } })).json().dismissed).toBe('1.1.0');
    expect((await server.inject({ method: 'POST', url: '/api/updates/dismiss', headers: headers(), payload: { version: '' } })).statusCode).toBe(422);
    expect(calls).toEqual(['check', 'install 1.1.0', 'install 9.9.9', 'install busy', 'dismiss 1.1.0']);
  });

  it('is behind the guard (no cookie → 401)', async () => {
    const server = await start({ updates: { status: () => STATUS, check: async () => STATUS, install: () => STATUS, dismiss: async () => STATUS } });
    const response = await server.inject({ method: 'POST', url: '/api/updates/install', headers: { host: HOST }, payload: { version: '1.1.0' } });
    expect(response.statusCode).toBe(401);
  });
});
