import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { CleanupScan } from '../../../src/core/cleanup.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { isLocalOnly } from '../../../src/server/devices/local-only.ts';
import { PEER_API_ALLOW } from '../../../src/server/peers/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

const PORT = 4876; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

let tmp: string | undefined;
let store: Store | undefined;
let app: FastifyInstance | undefined;
let token = '';

afterEach(async () => {
  await app?.close();
  await store?.close();
  if (tmp) await removeTempDir(tmp);
  app = undefined;
  store = undefined;
  tmp = undefined;
});

async function setup(): Promise<void> {
  tmp = await makeTempDir('api-cleanup');
  store = await openTempStore(path.join(tmp, 'data'));
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: path.join(tmp, 'data') }, platform: 'linux', home: tmp, cwd: tmp });
  app = await buildApp({ config: { ...base, port: PORT }, token, store, webRoot: tmp });
  await app.ready();
}

function call(method: InjectOptions['method'], url: string, payload?: unknown, headers: Record<string, string> = {}) {
  if (!app) throw new Error('no app');
  return app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}`, ...headers, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

describe('/api/cleanup (D84)', () => {
  it('an empty install scans to nothing; the closed-session limit is saved and validated', async () => {
    await setup();
    const scan = (await call('GET', '/api/cleanup')).json<CleanupScan>();
    expect(scan.items).toEqual([]);
    expect(scan.closedSessionDays).toBe(30);
    expect(scan.staleDays).toBe(14);
    expect((await call('PUT', '/api/cleanup/settings', { closedSessionDays: 7 })).json()).toEqual({ closedSessionDays: 7 });
    expect((await call('GET', '/api/cleanup')).json<CleanupScan>().closedSessionDays).toBe(7);
    for (const bad of [0, 3651, 2.5, '7', null]) {
      const response = await call('PUT', '/api/cleanup/settings', { closedSessionDays: bad });
      expect(response.statusCode).toBe(422);
      expect(response.json().errors[0].field).toBe('closedSessionDays');
    }
  });

  it('a run body is validated; an id no scan lists fails alone; unknown runs are 404', async () => {
    await setup();
    expect((await call('POST', '/api/cleanup/runs', { items: [] })).statusCode).toBe(422);
    expect((await call('POST', '/api/cleanup/runs', { items: [{ id: 'x', fingerprint: 'f', confirm: 'everything' }] })).statusCode).toBe(422);
    expect((await call('POST', '/api/cleanup/runs', { items: [{ id: 'x', fingerprint: 'f' }, { id: 'x', fingerprint: 'f' }] })).statusCode).toBe(422);
    const started = await call('POST', '/api/cleanup/runs', { items: [{ id: 'wt:nope', fingerprint: 'f' }] });
    expect(started.statusCode).toBe(202);
    let run = started.json();
    for (let i = 0; i < 50 && run.finishedAt === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      run = (await call('GET', `/api/cleanup/runs/${run.id}`)).json();
    }
    expect(run.items).toEqual([{ id: 'wt:nope', group: 'worktrees', title: 'wt:nope', status: 'failed', error: 'no longer listed: scan again', sizeBytes: null }]);
    expect((await call('GET', '/api/cleanup/runs/unknown')).statusCode).toBe(404);
  });

  it('desktop only: refused to paired devices (allow-list) and to peers', async () => {
    await setup();
    for (const [method, url] of [
      ['GET', '/api/cleanup'],
      ['PUT', '/api/cleanup/settings'],
      ['POST', '/api/cleanup/runs'],
      ['GET', '/api/cleanup/runs/r1'],
      ['GET', '/api/machines/m1/api/cleanup'],
    ] as const) {
      expect(isLocalOnly(method, url)).toBe(true);
      expect(PEER_API_ALLOW.some(([verb, pattern]) => verb === method && pattern.test(url))).toBe(false);
    }
    const peer = await call('GET', '/api/cleanup', undefined, { 'x-switchboard-peer': 'm1' });
    expect(peer.statusCode).toBe(403);
    expect(peer.json().error).toBe('peer-forbidden');
  });
});
