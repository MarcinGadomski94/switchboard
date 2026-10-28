import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SidebarLayout } from '../../../src/core/sidebar-layout.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HubBus, type HubMessage } from '../../../src/server/hub/bus.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { registerPlanHooks } from '../../../src/server/plans/hooks.ts';
import { registerTeamHooks } from '../../../src/server/team/hooks.ts';
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
    expect(response.json()).toEqual({ pinned: [], folders: [], loose: [] });
    const anonymous = await app.inject({ method: 'GET', url: '/api/sidebar', headers: { host: HOST } });
    expect(anonymous.statusCode).toBe(401);
  });

  it('pins, re-orders, folders, collapses, renames, moves and deletes; every write answers the layout and publishes it', async () => {
    const [s1, s2, s3] = [await session('one'), await session('two'), await session('three')];
    expect((await call('POST', '/api/sidebar/place', { sessionId: s1, place: 'pinned' })).json()).toEqual({ pinned: [s1], folders: [], loose: [] });
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
    expect(await store.sidebar.read()).toEqual({ pinned: [], folders: [], loose: [] });
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

  it('2.4.4: a crew pins next to the agents (crew~<team id>), in pin order, unpins, and goes nowhere else', async () => {
    const local = await session('local');
    await call('POST', '/api/sidebar/place', { sessionId: local, place: 'pinned' });
    const pinned = await call('POST', '/api/sidebar/place', { sessionId: 'crew~team', place: 'pinned' });
    expect(pinned.statusCode).toBe(200);
    expect((pinned.json() as SidebarLayout).pinned).toEqual([local, 'crew~team']);
    expect(layoutEvents().at(-1)?.pinned).toEqual([local, 'crew~team']);
    // Undo of an Unpin puts it back at its index.
    await call('POST', '/api/sidebar/place', { sessionId: 'crew~team', place: 'loose' });
    expect((await store.sidebar.read()).pinned).toEqual([local]);
    expect((await store.sidebar.read()).loose).toEqual([]);
    await call('POST', '/api/sidebar/place', { sessionId: 'crew~team', place: 'pinned', index: 0 });
    expect((await store.sidebar.read()).pinned).toEqual(['crew~team', local]);
    // A crew is never put in a folder or the loose order, and a malformed crew id is an unknown session.
    const fid = ((await call('POST', '/api/sidebar/folders', { name: 'F' })).json() as SidebarLayout).folders[0]?.id as string;
    expect((await call('POST', '/api/sidebar/place', { sessionId: 'crew~team', place: 'folder', folderId: fid })).statusCode).toBe(422);
    expect((await call('POST', '/api/sidebar/place', { sessionId: 'crew~team', place: 'loose', index: 0 })).statusCode).toBe(422);
    expect((await call('POST', '/api/sidebar/place', { sessionId: 'crew~a b', place: 'pinned' })).statusCode).toBe(404);
    expect((await store.sidebar.read()).pinned).toEqual(['crew~team', local]);
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
    // D71: stored with order keys per parent (no integer positions since 0029).
    const level = (parent: string | null) =>
      store.db.prepare('SELECT name FROM sidebar_folders WHERE deleted_clock IS NULL AND parent_id IS ? ORDER BY sort_key, id').all(parent).map((row) => row['name']);
    expect(level(null)).toEqual(['Work', 'Reviews']);
    expect(level(work)).toEqual(['Later']);
    expect(level(reviews)).toEqual(['Deep']);
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

describe('/api/sidebar folder delete with archiving (D141)', () => {
  const create = async (name: string, parentId?: string | null): Promise<SidebarLayout> =>
    (await call('POST', '/api/sidebar/folders', parentId === undefined ? { name } : { name, parentId })).json() as SidebarLayout;
  const idOf = (layout: SidebarLayout, name: string) => layout.folders.find((f) => f.name === name)?.id as string;
  const into = (sessionId: string, folderId: string) => call('POST', '/api/sidebar/place', { sessionId, place: 'folder', folderId });

  /** Work › Reviews › Deep, a sibling Later; sessions in each level of Work. */
  async function tree() {
    let layout = await create('Outer');
    const outer = idOf(layout, 'Outer');
    layout = await create('Work', outer);
    const work = idOf(layout, 'Work');
    layout = await create('Reviews', work);
    const reviews = idOf(layout, 'Reviews');
    layout = await create('Deep', reviews);
    const deep = idOf(layout, 'Deep');
    layout = await create('Later');
    const later = idOf(layout, 'Later');
    return { outer, work, reviews, deep, later };
  }

  it('archives every open session in the folder and its subfolders, deletes the whole subtree, and moves nothing else', async () => {
    const f = await tree();
    const [a, b, c, other, closedBefore] = [await session('alpha'), await session('beta'), await session('gamma'), await session('other'), await session('closed-before')];
    await into(a, f.work);
    await into(b, f.reviews);
    await into(c, f.deep);
    await into(other, f.later);
    await into(closedBefore, f.work);
    await store.sessions.update(closedBefore, { closedAt: '2026-10-01T10:00:00.000Z' });
    const published = layoutEvents().length;

    const response = await call('DELETE', `/api/sidebar/folders/${f.work}?archive=1`);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { layout: SidebarLayout; archived: Array<{ sessionId: string; name: string; machine: string | null }>; kept: unknown[] };
    expect(body.archived.map((x) => x.sessionId).sort()).toEqual([a, b, c].sort());
    expect(body.archived.find((x) => x.sessionId === a)).toEqual({ sessionId: a, name: 'alpha', machine: null });
    expect(body.kept).toEqual([]);
    // Archived the way Archive does (closedAt set; the records stay).
    for (const id of [a, b, c]) expect((await store.sessions.get(id))?.closedAt).toBeTruthy();
    expect((await store.sessions.get(other))?.closedAt).toBeNull();
    // Work, Reviews and Deep are gone; Outer and Later stay; the archived sessions keep a (hidden) place in Outer.
    expect(body.layout.folders.map((x) => x.name)).toEqual(['Outer', 'Later']);
    expect(body.layout.folders.find((x) => x.id === f.outer)?.sessionIds).toEqual([a, closedBefore, b, c]);
    expect(body.layout.folders.find((x) => x.id === f.later)?.sessionIds).toEqual([other]);
    expect(await store.sidebar.read()).toEqual(body.layout);
    expect(layoutEvents().length).toBe(published + 1);
    expect(layoutEvents().at(-1)).toEqual(body.layout);
  });

  it('holds back crew members and plan sessions (moved out, reported with the reason); a top-level folder\'s held sessions become loose', async () => {
    const f = await tree();
    const [plain, member, owner, step] = [await session('plain'), await session('member'), await session('owner'), await session('step')];
    for (const id of [plain, member]) await into(id, f.work);
    for (const id of [owner, step]) await into(id, f.deep);
    registerTeamHooks(store, {
      charterFor: async () => null,
      roleOf: () => null,
      memberOf: (id) => (id === member ? { id: 'm1', name: 'Reviewer', teamId: 't1', sessionId: id, machineId: 'here', here: true, paused: false } : null),
    });
    registerPlanHooks(store, {
      sessionContinued: async () => undefined,
      inboxMerge: async () => null,
      outcomes: async () => null,
      itemsOfTodos: async () => [],
      archiveHolds: async () =>
        new Map<string, 'plan' | 'plan-step'>([
          [owner, 'plan'],
          [step, 'plan-step'],
        ]),
    });

    const response = await call('DELETE', `/api/sidebar/folders/${f.outer}?archive=true`);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { layout: SidebarLayout; archived: Array<{ sessionId: string }>; kept: Array<{ sessionId: string; reason: string; machine: string | null }> };
    expect(body.archived.map((x) => x.sessionId)).toEqual([plain]);
    expect(body.kept.map(({ sessionId, reason }) => ({ sessionId, reason }))).toEqual([
      { sessionId: member, reason: 'crew' },
      { sessionId: owner, reason: 'plan' },
      { sessionId: step, reason: 'plan-step' },
    ]);
    for (const id of [member, owner, step]) expect((await store.sessions.get(id))?.closedAt).toBeNull();
    // Outer was top level: everything in it is out of the folders (unplaced), Later stays.
    expect(body.layout.folders.map((x) => x.name)).toEqual(['Later']);
    expect(body.layout.pinned).toEqual([]);
  });

  it('without the flag (or ?archive=0) the delete is D58\'s: nothing is archived, subfolders move up; a bad flag is 422, an unknown folder 404', async () => {
    const f = await tree();
    const a = await session('alpha');
    await into(a, f.reviews);
    expect((await call('DELETE', `/api/sidebar/folders/${f.work}?archive=maybe`)).statusCode).toBe(422);
    expect((await call('DELETE', '/api/sidebar/folders/nope?archive=1')).statusCode).toBe(404);
    expect((await store.sessions.get(a))?.closedAt).toBeNull();
    const plain = await call('DELETE', `/api/sidebar/folders/${f.work}?archive=0`);
    const layout = plain.json() as SidebarLayout;
    expect(layout.folders.map((x) => x.name)).toEqual(['Outer', 'Reviews', 'Deep', 'Later']);
    expect((await store.sessions.get(a))?.closedAt).toBeNull();
    const again = (await call('DELETE', `/api/sidebar/folders/${f.reviews}`)).json() as SidebarLayout;
    expect(again.folders.map((x) => x.name)).toEqual(['Outer', 'Deep', 'Later']);
    expect(again.folders.find((x) => x.id === f.outer)?.sessionIds).toEqual([a]);
  });

  it('an empty folder (or one holding only archived sessions) is simply deleted with its subfolders', async () => {
    const f = await tree();
    const body = (await call('DELETE', `/api/sidebar/folders/${f.work}?archive=1`)).json() as { layout: SidebarLayout; archived: unknown[]; kept: unknown[] };
    expect(body).toMatchObject({ archived: [], kept: [] });
    expect(body.layout.folders.map((x) => x.name)).toEqual(['Outer', 'Later']);
  });
});
