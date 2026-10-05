import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import type { MachinesView, MachineSidebarSync } from '../../../src/core/peers.ts';
import { remoteId } from '../../../src/core/peers.ts';
import type { SidebarLayout } from '../../../src/core/sidebar-layout.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, machineOn, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D71 "shared sidebar layout" with two real Switchboard processes (fake CLIs,
 * the D48 test world: loopback listeners, `docs/peers.md` → *Shared sidebar
 * layout (D71)*): off by default; on one side only = waiting; on both = the
 * first merge (union, same-named folders combined); live both ways with one
 * session being one item on both machines; a conflict (last write wins); an
 * outage and the catch-up on reconnect; off again; forgetting the machine.
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-sidebar-sync');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function world() {
  const paired = await pairedNodes(tmp, { SWITCHBOARD_PEER_TEST_HOOKS: '1', SWITCHBOARD_PEER_GRACE_MS: '20000' });
  nodes.push(paired.a, paired.b);
  return paired;
}

async function layoutOf(node: PeerNode): Promise<SidebarLayout> {
  return (await node.call('GET', '/api/sidebar')).body as SidebarLayout;
}

/** The shared part (`collapsed` is each machine's own). */
function shared(layout: SidebarLayout) {
  return { ...layout, folders: layout.folders.map(({ collapsed: _c, ...f }) => f) };
}

/** `node`'s layout with the session ids it knows turned into `<machine>:<id>` keys (so two machines' layouts compare). */
function keyed(layout: SidebarLayout, selfId: string) {
  const key = (id: string) => (id.startsWith('r~') ? id.slice(2).replace('~', ':') : `${selfId}:${id}`);
  const s = shared(layout);
  return { pinned: s.pinned.map(key), loose: (s.loose ?? []).map(key), folders: s.folders.map((f) => ({ ...f, sessionIds: f.sessionIds.map(key) })) };
}

async function syncOf(node: PeerNode, machineId: string): Promise<MachineSidebarSync | undefined> {
  return (await machineOn(node, machineId))?.sidebarSync;
}

async function setSync(node: PeerNode, machineId: string, enabled: boolean) {
  const answer = await node.call('PUT', `/api/machines/${machineId}/sidebar-sync`, { enabled });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body as { sidebarSync: MachineSidebarSync };
}

async function folder(node: PeerNode, name: string, parentId?: string): Promise<string> {
  const answer = await node.call('POST', '/api/sidebar/folders', { name, ...(parentId ? { parentId } : {}) });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return ((answer.body as SidebarLayout).folders.filter((f) => f.name === name && (f.parentId ?? null) === (parentId ?? null)).at(-1) as { id: string }).id;
}

async function startOn(node: PeerNode, name: string): Promise<string> {
  const created = await node.call('POST', '/api/sessions', { name, task: 'Say OK.', folder: node.folderId, worktrees: false, ultracode: false });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return (created.body as Session).id;
}

async function listedOn(node: PeerNode, id: string): Promise<void> {
  await waitFor(`${id} listed`, async () => ((await node.call('GET', '/api/sessions')).body as Session[]).some((s) => s.id === id));
}

describe('D71 shared sidebar layout between two paired machines', () => {
  it('off by default, waiting while on one side only; on both: the first merge (union, same-named folders combined), then live both ways, a conflict, and off again', async () => {
    const { a, b, aId, bId } = await world();
    // Off by default for a pairing; each machine has its own layout.
    expect(await syncOf(a, bId)).toMatchObject({ enabled: false, state: 'off', mergedAt: null });
    const xOnA = await startOn(a, 'x-on-a');
    const yOnB = await startOn(b, 'y-on-b');
    await listedOn(b, remoteId(aId, xOnA));
    await listedOn(a, remoteId(bId, yOnB));
    const acmeA = await folder(a, 'Acme');
    const projA = await folder(a, 'PROJ-1', acmeA);
    const mineA = await folder(a, 'Mine');
    expect((await a.call('POST', '/api/sidebar/place', { sessionId: xOnA, place: 'folder', folderId: projA })).status).toBe(200);
    const acmeB = await folder(b, 'Acme');
    const projB = await folder(b, 'PROJ-1', acmeB);
    const otherB = await folder(b, 'PROJ-2', acmeB);
    expect((await b.call('POST', '/api/sidebar/place', { sessionId: yOnB, place: 'folder', folderId: projB })).status).toBe(200);
    expect((await b.call('POST', '/api/sidebar/place', { sessionId: remoteId(aId, xOnA), place: 'pinned' })).status).toBe(200);
    expect((await a.call('PUT', `/api/sidebar/folders/${acmeA}`, { collapsed: true })).status).toBe(200);

    // On A only: waiting for B; nothing moves either way.
    const onA = await setSync(a, bId, true);
    expect(onA.sidebarSync).toMatchObject({ enabled: true, state: 'waiting', mergedAt: null });
    expect((await layoutOf(b)).folders.map((f) => f.id).sort()).toEqual([acmeB, otherB, projB].sort());

    // On B too: both merge. Union; "Acme" and "Acme/PROJ-1" combine into the smaller ids; x was placed later on B (pinned), so it is pinned on both.
    await setSync(b, aId, true);
    await waitFor('both synced', async () => (await syncOf(a, bId))?.state === 'synced' && (await syncOf(b, aId))?.state === 'synced' && (await syncOf(a, bId))?.mergedAt && (await syncOf(b, aId))?.mergedAt);
    await waitFor('the same layout on both', async () => JSON.stringify(keyed(await layoutOf(a), aId)) === JSON.stringify(keyed(await layoutOf(b), bId)));
    const merged = await layoutOf(a);
    const acme = [acmeA, acmeB].sort()[0] as string;
    const proj = [projA, projB].sort()[0] as string;
    expect(merged.folders.filter((f) => f.parentId === null).map((f) => f.name).sort()).toEqual(['Acme', 'Mine']);
    expect(merged.folders.find((f) => f.id === mineA)).toBeDefined();
    expect(merged.folders.filter((f) => f.parentId === acme).map((f) => f.name).sort()).toEqual(['PROJ-1', 'PROJ-2']);
    expect(merged.folders.find((f) => f.id === proj)?.sessionIds).toEqual([remoteId(bId, yOnB)]);
    expect(merged.pinned).toEqual([xOnA]);
    // `collapsed` is each machine's own: Acme stays collapsed on A only (when A's Acme survived).
    if (acme === acmeA) {
      expect(merged.folders.find((f) => f.id === acme)?.collapsed).toBe(true);
      expect((await layoutOf(b)).folders.find((f) => f.id === acme)?.collapsed).toBe(false);
    }

    // Live, A → B: a new folder, B's session dropped into it on A (its remote id there), a rename.
    const live = await folder(a, 'Live');
    expect((await a.call('POST', '/api/sidebar/place', { sessionId: remoteId(bId, yOnB), place: 'folder', folderId: live })).status).toBe(200);
    expect((await a.call('PUT', `/api/sidebar/folders/${mineA}`, { name: 'Mine 2' })).status).toBe(200);
    await waitFor('B follows A', async () => {
      const onB = await layoutOf(b);
      return onB.folders.find((f) => f.id === live)?.sessionIds.join() === yOnB && onB.folders.find((f) => f.id === mineA)?.name === 'Mine 2';
    });
    // Live, B → A: A's own session moved on B lands in A's folder; a loose order.
    expect((await b.call('POST', '/api/sidebar/place', { sessionId: remoteId(aId, xOnA), place: 'folder', folderId: live, index: 0 })).status).toBe(200);
    await waitFor('A follows B', async () => (await layoutOf(a)).folders.find((f) => f.id === live)?.sessionIds.join() === [xOnA, remoteId(bId, yOnB)].join());

    // A conflict: both move x at once; the later write wins on both.
    await Promise.all([
      a.call('POST', '/api/sidebar/place', { sessionId: xOnA, place: 'pinned' }),
      b.call('POST', '/api/sidebar/place', { sessionId: remoteId(aId, xOnA), place: 'folder', folderId: mineA }),
    ]);
    await waitFor('converged after the conflict', async () => JSON.stringify(keyed(await layoutOf(a), aId)) === JSON.stringify(keyed(await layoutOf(b), bId)));
    const after = await layoutOf(a);
    expect(after.pinned.includes(xOnA) !== (after.folders.find((f) => f.id === mineA)?.sessionIds.includes(xOnA) ?? false)).toBe(true);

    // Off on B: B stops taking A's changes (and A shows waiting at its next send).
    await setSync(b, aId, false);
    expect(await syncOf(b, aId)).toMatchObject({ enabled: false, state: 'off' });
    await folder(a, 'After off');
    await waitFor('A sees B is off', async () => (await syncOf(a, bId))?.state === 'waiting');
    expect((await layoutOf(b)).folders.some((f) => f.name === 'After off')).toBe(false);
  });

  it('a machine that was away catches up when it is back (both ways), and a deletion reaches it as a tombstone', async () => {
    const { a, b, aId, bId } = await world();
    await setSync(a, bId, true);
    await setSync(b, aId, true);
    await waitFor('both synced', async () => (await syncOf(a, bId))?.state === 'synced' && (await syncOf(b, aId))?.state === 'synced');
    const gone = await folder(a, 'Gone soon');
    await waitFor('B has it', async () => (await layoutOf(b)).folders.some((f) => f.id === gone));

    // B's listener is away for a while: A cannot send to B.
    expect((await b.call('POST', '/api/test/peers/outage', { ms: 120_000 })).status).toBe(204);
    await waitFor('A cannot reach B', async () => (await machineOn(a, bId))?.state !== 'online');
    const kept = await folder(a, 'Made while B was away');
    expect((await a.call('DELETE', `/api/sidebar/folders/${gone}`)).status).toBe(200);
    await waitFor('A says unreachable', async () => (await syncOf(a, bId))?.state === 'unreachable');
    expect((await layoutOf(b)).folders.some((f) => f.id === kept)).toBe(false);
    // B changes something meanwhile (B → A still works over B's own connection).
    const fromB = await folder(b, 'From B');

    // B is back: A reconnects and the full exchange catches B up.
    expect((await b.call('DELETE', '/api/test/peers/outage')).status).toBe(204);
    await waitFor('caught up', async () => {
      const onB = await layoutOf(b);
      return onB.folders.some((f) => f.id === kept) && !onB.folders.some((f) => f.id === gone);
    }, 30_000);
    await waitFor('the same on both', async () => JSON.stringify(shared(await layoutOf(a))) === JSON.stringify(shared(await layoutOf(b))));
    expect((await layoutOf(a)).folders.some((f) => f.id === fromB)).toBe(true);
  });

  it('forgetting the machine stops the sharing; each keeps its layout as it is', async () => {
    const { a, b, aId, bId } = await world();
    await setSync(a, bId, true);
    await setSync(b, aId, true);
    await waitFor('both synced', async () => (await syncOf(a, bId))?.state === 'synced' && (await syncOf(b, aId))?.state === 'synced');
    const shared1 = await folder(a, 'Shared');
    await waitFor('B has it', async () => (await layoutOf(b)).folders.some((f) => f.id === shared1));
    expect((await b.call('DELETE', `/api/machines/${aId}`)).status).toBe(204);
    await waitFor('A forgot B', async () => (await machineOn(a, bId)) === null);
    await folder(a, 'Only on A');
    expect((await layoutOf(b)).folders.map((f) => f.name)).toEqual(['Shared']);
    expect((await layoutOf(a)).folders.map((f) => f.name).sort()).toEqual(['Only on A', 'Shared']);
    const view = (await a.call('GET', '/api/machines')).body as MachinesView;
    expect(view.machines).toEqual([]);
  });
});
