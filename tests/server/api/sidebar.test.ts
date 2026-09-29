import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SidebarLayout } from '../../../src/core/sidebar-layout.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HubBus, type HubMessage } from '../../../src/server/hub/bus.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D54 oracle: the sidebar layout routes (src/server/api/sidebar.ts), migration
 * 0019 and its triggers, `sidebarLayoutChanged`, and the layout staying this
 * machine's (not on the peer API).
 */

const PORT = 4876; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;
const MACHINE = 'abcdefghijkl';

let tmp: string;
let store: Store;
let app: FastifyInstance;
let token: string;
let published: HubMessage[];

beforeEach(async () => {
  tmp = await makeTempDir('api-sidebar');
  store = await openTempStore(tmp);
  token = generateToken();
  const bus = new HubBus();
  published = [];
  bus.subscribe((message) => published.push(message));
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
  app = await buildApp({ config, token, store, webRoot: tmp, bus });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await store.close();
  await removeTempDir(tmp);
});

function call(method: InjectOptions['method'], url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

async function session(name: string): Promise<string> {
  return (await store.sessions.create({ name, claudeSessionId: randomUUID() })).id;
}

function layoutEvents(): SidebarLayout[] {
  return published.filter((m) => m.name === 'sidebarLayoutChanged').map((m) => m.payload as SidebarLayout);
}

describe('/api/sidebar (D54)', () => {
  it('starts empty; a cookie-less call is refused like every API call', async () => {
    const response = await call('GET', '/api/sidebar');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ pinned: [], folders: [] });
    const anonymous = await app.inject({ method: 'GET', url: '/api/sidebar', headers: { host: HOST } });
    expect(anonymous.statusCode).toBe(401);
  });

  it('pins, re-orders, folders, collapses, renames, moves and deletes; every write answers the layout and publishes it', async () => {
    const [s1, s2, s3] = [await session('one'), await session('two'), await session('three')];
    expect((await call('POST', '/api/sidebar/place', { sessionId: s1, place: 'pinned' })).json()).toEqual({ pinned: [s1], folders: [] });
    expect((await call('POST', '/api/sidebar/place', { sessionId: s2, place: 'pinned', index: 0 })).json().pinned).toEqual([s2, s1]);

    const created = await call('POST', '/api/sidebar/folders', { name: '  Work  ' });
    expect(created.statusCode).toBe(201);
    const folder = (created.json() as SidebarLayout).folders[0];
    expect(folder).toMatchObject({ name: 'Work', collapsed: false, sessionIds: [] });
    const fid = folder?.id as string;
    const second = ((await call('POST', '/api/sidebar/folders', { name: 'Later' })).json() as SidebarLayout).folders[1]?.id as string;

    // Into a folder (out of Pinned), then a second one before it.
    let layout = (await call('POST', '/api/sidebar/place', { sessionId: s1, place: 'folder', folderId: fid })).json() as SidebarLayout;
    expect(layout.pinned).toEqual([s2]);
    layout = (await call('POST', '/api/sidebar/place', { sessionId: s3, place: 'folder', folderId: fid, index: 0 })).json() as SidebarLayout;
    expect(layout.folders[0]?.sessionIds).toEqual([s3, s1]);

    layout = (await call('PUT', `/api/sidebar/folders/${fid}`, { collapsed: true, name: 'Work 2' })).json() as SidebarLayout;
    expect(layout.folders[0]).toMatchObject({ name: 'Work 2', collapsed: true });
    layout = (await call('PUT', `/api/sidebar/folders/${second}/position`, { index: 0 })).json() as SidebarLayout;
    expect(layout.folders.map((f) => f.id)).toEqual([second, fid]);

    // Persisted: a fresh read (the repository) has the same.
    expect(await store.sidebar.read()).toEqual(layout);

    layout = (await call('DELETE', `/api/sidebar/folders/${fid}`)).json() as SidebarLayout;
    expect(layout.folders.map((f) => f.id)).toEqual([second]);
    expect(layout.pinned).toEqual([s2]);
    layout = (await call('POST', '/api/sidebar/place', { sessionId: s2, place: 'loose' })).json() as SidebarLayout;
    expect(layout.pinned).toEqual([]);

    // One `sidebarLayoutChanged` per write, each the whole answer.
    expect(layoutEvents()).toHaveLength(10);
    expect(layoutEvents().at(-1)).toEqual(layout);
  });

  it('refusals: 422 for bad input, 404 for an unknown folder or session; nothing changes and nothing is published', async () => {
    const s1 = await session('one');
    expect((await call('POST', '/api/sidebar/folders', { name: '' })).statusCode).toBe(422);
    expect((await call('POST', '/api/sidebar/folders', { name: 'x'.repeat(61) })).statusCode).toBe(422);
    expect((await call('PUT', '/api/sidebar/folders/nope', { collapsed: true })).statusCode).toBe(404);
    expect((await call('PUT', '/api/sidebar/folders/nope', {})).statusCode).toBe(422);
    expect((await call('PUT', '/api/sidebar/folders/nope/position', { index: 0 })).statusCode).toBe(404);
    expect((await call('DELETE', '/api/sidebar/folders/nope')).statusCode).toBe(404);
    expect((await call('POST', '/api/sidebar/place', { sessionId: s1, place: 'folder', folderId: 'nope' })).statusCode).toBe(404);
    expect((await call('POST', '/api/sidebar/place', { sessionId: 'not-a-session', place: 'pinned' })).statusCode).toBe(404);
    // A remote id of a machine that is not paired.
    expect((await call('POST', '/api/sidebar/place', { sessionId: `r~${MACHINE}~s1`, place: 'pinned' })).statusCode).toBe(404);
    expect((await call('POST', '/api/sidebar/place', { sessionId: s1, place: 'top' })).statusCode).toBe(422);
    expect(await store.sidebar.read()).toEqual({ pinned: [], folders: [] });
    expect(layoutEvents()).toEqual([]);
  });

  it("a paired machine's session can be pinned and foldered here; forgetting the machine removes its places", async () => {
    await store.machines.upsert({ id: MACHINE, name: 'pc-office', outboundToken: 'out', inboundTokenHash: 'hash' });
    const remote = `r~${MACHINE}~5c1e0b52`;
    const local = await session('local');
    const response = await call('POST', '/api/sidebar/place', { sessionId: remote, place: 'pinned' });
    expect(response.statusCode).toBe(200);
    await call('POST', '/api/sidebar/place', { sessionId: local, place: 'pinned' });
    expect((await store.sidebar.read()).pinned).toEqual([remote, local]);
    await store.machines.delete(MACHINE);
    expect((await store.sidebar.read()).pinned).toEqual([local]);
  });

  it('a closed session keeps its place (reopening restores it); deleting its record removes it', async () => {
    const s1 = await session('one');
    const fid = ((await call('POST', '/api/sidebar/folders', { name: 'F' })).json() as SidebarLayout).folders[0]?.id as string;
    await call('POST', '/api/sidebar/place', { sessionId: s1, place: 'folder', folderId: fid });
    await store.sessions.update(s1, { closedAt: new Date().toISOString() });
    expect((await store.sidebar.read()).folders[0]?.sessionIds).toEqual([s1]);
    await store.sessions.delete(s1);
    expect((await store.sidebar.read()).folders[0]?.sessionIds).toEqual([]);
  });

  it('the layout is this machine\'s: no sidebar route is on the peer API', () => {
    for (const [method, url] of [
      ['GET', '/api/sidebar'],
      ['POST', '/api/sidebar/folders'],
      ['PUT', '/api/sidebar/folders/f1'],
      ['PUT', '/api/sidebar/folders/f1/position'],
      ['DELETE', '/api/sidebar/folders/f1'],
      ['POST', '/api/sidebar/place'],
    ] as const) {
      expect(peerApiAllowed(method, url), `${method} ${url}`).toBe(false);
    }
  });
});
