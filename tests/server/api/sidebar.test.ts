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

/** D58 oracle: subfolders through the routes (parentId on create / move, refusals, delete moves things up, persistence). */
describe('/api/sidebar subfolders (D58)', () => {
  const create = async (name: string, parentId?: string | null) => {
    const response = await call('POST', '/api/sidebar/folders', parentId === undefined ? { name } : { name, parentId });
    return response;
  };
  const idOf = (layout: SidebarLayout, name: string) => layout.folders.find((f) => f.name === name)?.id as string;
  const shape = (layout: SidebarLayout) => layout.folders.map((f) => `${f.parentId === null ? '-' : layout.folders.find((p) => p.id === f.parentId)?.name}/${f.name}`);

  it('creates subfolders, moves folders in / out / among siblings, and answers the tree in tree order; persisted and published', async () => {
    const top = (await create('Work')).json() as SidebarLayout;
    const work = idOf(top, 'Work');
    expect(top.folders[0]?.parentId).toBeNull();
    const sub = await create('Reviews', work);
    expect(sub.statusCode).toBe(201);
    let layout = sub.json() as SidebarLayout;
    const reviews = idOf(layout, 'Reviews');
    layout = (await create('Later')).json() as SidebarLayout;
    const later = idOf(layout, 'Later');
    layout = (await create('Deep', reviews)).json() as SidebarLayout;
    expect(shape(layout)).toEqual(['-/Work', 'Work/Reviews', 'Reviews/Deep', '-/Later']);

    // Later into Work, before Reviews.
    layout = (await call('PUT', `/api/sidebar/folders/${later}/position`, { index: 0, parentId: work })).json() as SidebarLayout;
    expect(shape(layout)).toEqual(['-/Work', 'Work/Later', 'Work/Reviews', 'Reviews/Deep']);
    // D54's body (no parentId): re-orders within its level.
    layout = (await call('PUT', `/api/sidebar/folders/${later}/position`, { index: 1 })).json() as SidebarLayout;
    expect(shape(layout)).toEqual(['-/Work', 'Work/Reviews', 'Reviews/Deep', 'Work/Later']);
    // Out to the top level.
    layout = (await call('PUT', `/api/sidebar/folders/${reviews}/position`, { index: 1, parentId: null })).json() as SidebarLayout;
    expect(shape(layout)).toEqual(['-/Work', 'Work/Later', '-/Reviews', 'Reviews/Deep']);

    expect(await store.sidebar.read()).toEqual(layout);
    expect(layoutEvents().at(-1)).toEqual(layout);
    const positions = store.db.prepare('SELECT name, parent_id, position FROM sidebar_folders ORDER BY name').all();
    expect(positions).toEqual([
      { name: 'Deep', parent_id: reviews, position: 0 },
      { name: 'Later', parent_id: work, position: 0 },
      { name: 'Reviews', parent_id: null, position: 1 },
      { name: 'Work', parent_id: null, position: 0 },
    ]);
  });

  it('refusals: unknown parent 404, a loop or too deep 422 on parentId; nothing changes and nothing is published', async () => {
    let layout = (await create('A')).json() as SidebarLayout;
    const a = idOf(layout, 'A');
    let parent = a;
    for (const name of ['B', 'C', 'D', 'E']) {
      layout = (await create(name, parent)).json() as SidebarLayout;
      parent = idOf(layout, name);
    }
    const before = await store.sidebar.read();
    const published = layoutEvents().length;
    expect((await create('X', 'nope')).statusCode).toBe(404);
    const tooDeep = await create('F', parent);
    expect(tooDeep.statusCode).toBe(422);
    expect(tooDeep.json()).toEqual({ error: 'invalid', errors: [{ field: 'parentId', message: 'folders nest at most 5 levels deep' }] });
    const loop = await call('PUT', `/api/sidebar/folders/${a}/position`, { index: 0, parentId: idOf(layout, 'C') });
    expect(loop.statusCode).toBe(422);
    expect(loop.json().errors[0].field).toBe('parentId');
    expect((await call('PUT', `/api/sidebar/folders/${a}/position`, { index: 0, parentId: a })).statusCode).toBe(422);
    expect((await call('PUT', `/api/sidebar/folders/${a}/position`, { index: 0, parentId: 'nope' })).statusCode).toBe(404);
    expect((await call('PUT', `/api/sidebar/folders/nope/position`, { index: 0, parentId: a })).statusCode).toBe(404);
    expect((await call('POST', '/api/sidebar/folders', { name: 'X', parentId: 5 })).statusCode).toBe(422);
    // A two-level folder does not fit under the fourth level.
    layout = (await create('G')).json() as SidebarLayout;
    const g = idOf(layout, 'G');
    await create('H', g);
    expect((await call('PUT', `/api/sidebar/folders/${g}/position`, { index: 0, parentId: idOf(layout, 'D') })).statusCode).toBe(422);
    expect((await call('PUT', `/api/sidebar/folders/${g}/position`, { index: 0, parentId: idOf(layout, 'C') })).statusCode).toBe(200);
    expect(before.folders).toHaveLength(5);
    expect(layoutEvents().length).toBe(published + 3);
  });

  it('delete: subfolders move up into its place, its sessions go to its parent (or loose); sessions are never deleted', async () => {
    const [s1, s2] = [await session('one'), await session('two')];
    let layout = (await create('Top')).json() as SidebarLayout;
    const topId = idOf(layout, 'Top');
    layout = (await create('Mid', topId)).json() as SidebarLayout;
    const mid = idOf(layout, 'Mid');
    layout = (await create('Leaf', mid)).json() as SidebarLayout;
    const leaf = idOf(layout, 'Leaf');
    await call('POST', '/api/sidebar/place', { sessionId: s1, place: 'folder', folderId: mid });
    await call('POST', '/api/sidebar/place', { sessionId: s2, place: 'folder', folderId: leaf });

    layout = (await call('DELETE', `/api/sidebar/folders/${mid}`)).json() as SidebarLayout;
    expect(shape(layout)).toEqual(['-/Top', 'Top/Leaf']);
    expect(layout.folders.find((f) => f.id === topId)?.sessionIds).toEqual([s1]);
    expect(layout.folders.find((f) => f.id === leaf)?.sessionIds).toEqual([s2]);
    expect(await store.sidebar.read()).toEqual(layout);

    layout = (await call('DELETE', `/api/sidebar/folders/${topId}`)).json() as SidebarLayout;
    expect(shape(layout)).toEqual(['-/Leaf']);
    expect(layout.folders[0]?.sessionIds).toEqual([s2]);
    expect(layout.pinned).toEqual([]);
    expect(await store.sidebar.read()).toEqual(layout);
    expect(await store.sessions.get(s1)).not.toBeNull();
  });

  it("a paired machine's session sits in a subfolder like a local one", async () => {
    await store.machines.upsert({ id: MACHINE, name: 'pc-office', outboundToken: 'out', inboundTokenHash: 'hash' });
    let layout = (await create('Top')).json() as SidebarLayout;
    layout = (await create('Sub', idOf(layout, 'Top'))).json() as SidebarLayout;
    const remote = `r~${MACHINE}~5c1e0b52`;
    layout = (await call('POST', '/api/sidebar/place', { sessionId: remote, place: 'folder', folderId: idOf(layout, 'Sub') })).json() as SidebarLayout;
    expect(layout.folders[1]?.sessionIds).toEqual([remote]);
  });
});
