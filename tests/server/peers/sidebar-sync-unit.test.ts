import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addFolder, placeSession } from '../../../src/core/sidebar-layout.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HubBus, type HubMessage } from '../../../src/server/hub/bus.ts';
import { PeerUnreachableError } from '../../../src/server/peers/client.ts';
import { SIDEBAR_SYNC_PATH, SidebarSync, type SyncConnection } from '../../../src/server/peers/sidebar-sync.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D71 oracle: the sync service on its own (src/server/peers/sidebar-sync.ts),
 * two machines in one process wired through fake connections (the real peer
 * route is covered by tests/server/peers/sidebar-sync.test.ts): an older peer
 * without the route, a refused / malformed message, an unreachable peer, and
 * the full exchange's first merge.
 */

const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';

let tmp: string;
let stores: Store[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('sidebar-sync-unit');
});
afterEach(async () => {
  await Promise.all(stores.map((store) => store.close()));
  stores = [];
  await removeTempDir(tmp);
});

interface Side {
  readonly store: Store;
  readonly sync: SidebarSync;
  readonly published: HubMessage[];
  connection: SyncConnection | undefined;
}

async function side(id: string, peer: string): Promise<Side> {
  const dir = path.join(tmp, id);
  await mkdir(dir, { recursive: true });
  const store = await openTempStore(dir);
  stores.push(store);
  store.sidebar.useNode(id);
  const bus = new HubBus();
  const published: HubMessage[] = [];
  bus.subscribe((m) => published.push(m));
  const holder: Side = {
    store,
    published,
    connection: undefined,
    sync: new SidebarSync({
      store,
      bus,
      selfId: async () => id,
      connection: () => holder.connection,
      machines: () => [peer],
      onStatus: () => undefined,
      onError: () => undefined,
      log: () => undefined,
    }),
  };
  await holder.sync.start();
  return holder;
}

/** A connection that delivers to `to.sync.receive` as `from`. */
function wire(to: Side, from: string): SyncConnection {
  return {
    state: 'online',
    request: async (method, path, body) => {
      expect([method, path]).toEqual(['POST', SIDEBAR_SYNC_PATH]);
      return to.sync.receive(from, JSON.parse(JSON.stringify(body)));
    },
  };
}

describe('D71 sync service', () => {
  it('an older peer (no route: 404) is unsupported; nothing breaks', async () => {
    const a = await side(A, B);
    a.connection = { state: 'online', request: async () => ({ status: 404, body: { error: 'not-found' } }) };
    await a.sync.setEnabled(B, true);
    expect(a.sync.view(B)).toMatchObject({ enabled: true, state: 'unsupported', mergedAt: null });
    await a.store.sidebar.change((l) => addFolder(l, 'f1', 'Acme'));
    expect(a.sync.view(B).state).toBe('unsupported');
  });

  it('an unreachable peer says so; a peer whose switch is off answers enabled: false (waiting) and takes nothing', async () => {
    const a = await side(A, B);
    const b = await side(B, A);
    a.connection = { state: 'online', request: async () => Promise.reject(new PeerUnreachableError('connection refused')) };
    await a.sync.setEnabled(B, true);
    expect(a.sync.view(B).state).toBe('unreachable');
    a.connection = wire(b, A);
    await a.store.sidebar.change((l) => addFolder(l, 'f1', 'Acme'));
    await a.sync.exchange(B);
    expect(a.sync.view(B).state).toBe('waiting');
    expect((await b.store.sidebar.read()).folders).toEqual([]);
  });

  it('a malformed message is refused (400); items that do not read are left out', async () => {
    const b = await side(B, A);
    await b.sync.setEnabled(A, true);
    expect((await b.sync.receive(A, { nope: true })).status).toBe(400);
    const answer = await b.sync.receive(A, { v: 1, full: false, folders: [{ id: 'f1', name: 'Acme', nameClock: '', parentId: null, order: '1', placeClock: '', deletedClock: null }, { id: 'f2' }], places: [{ key: 'garbage' }] });
    expect(answer).toEqual({ status: 200, body: { v: 1, enabled: true } });
    expect((await b.store.sidebar.read()).folders.map((f) => f.id)).toEqual(['f1']);
    expect(b.published.filter((m) => m.name === 'sidebarLayoutChanged')).toHaveLength(1);
  });

  it('the full exchange: both layouts merged on both sides, the first merge combines same-named folders; later changes go live', async () => {
    const a = await side(A, B);
    const b = await side(B, A);
    a.connection = wire(b, A);
    b.connection = wire(a, B);
    await a.store.sidebar.change((l) => addFolder(l, 'fa', 'Acme'));
    await a.store.sidebar.change((l) => placeSession(l, { sessionId: 'x', place: 'folder', folderId: 'fa' }));
    await b.store.sidebar.change((l) => addFolder(l, 'fb', 'Acme'));
    await b.store.sidebar.change((l) => placeSession(l, { sessionId: 'y', place: 'folder', folderId: 'fb' }));
    await b.sync.setEnabled(A, true);
    await a.sync.setEnabled(B, true);
    // Let the live sends settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const onA = await a.store.sidebar.read();
    const onB = await b.store.sidebar.read();
    expect(onA.folders.map((f) => [f.id, f.sessionIds])).toEqual([['fa', ['x', `r~${B}~y`]]]);
    expect(onB.folders.map((f) => [f.id, f.sessionIds])).toEqual([['fa', [`r~${A}~x`, 'y']]]);
    expect(a.sync.view(B)).toMatchObject({ state: 'synced', mergedAt: expect.any(String) });
    expect(b.sync.view(A)).toMatchObject({ state: 'synced', mergedAt: expect.any(String) });
    // Live: a change on A reaches B (sent by `changed`, as the routes do).
    const write = await a.store.sidebar.change((l) => addFolder(l, 'fc', 'Later'));
    a.sync.changed(write?.changes ?? { folders: [], places: [] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await b.store.sidebar.read()).folders.map((f) => f.name)).toEqual(['Acme', 'Later']);
  });
});
