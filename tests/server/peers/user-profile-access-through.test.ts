import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UserProfile, UserProfilesView } from '../../../src/core/user-profiles.ts';
import { TOKEN_FILE } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, enableListener, machineOn, pair, startPeerNode, waitFor } from '../../helpers/peers.ts';

/**
 * D176 with three real Switchboard processes in a chain (`docs/profiles.md` → *Admins and computer
 * access*): A–B paired, B–C paired, A and C not (the developer's PC, the shared Mac Studio, a
 * colleague's laptop). A lists C "through B"; a checklist set on A for computers A and B (C not in
 * view) blocks Bo on B and leaves Bo allowed on C, and reaches C through B at once (the relay); a
 * checklist set with C in view decides for C too.
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-user-profile-through');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function signIn(node: PeerNode, id: string, password?: string): Promise<string> {
  const base = `sb_token=${(await readFile(path.join(node.dataDir, TOKEN_FILE), 'utf8')).trim()}`;
  const response = await fetch(`${node.baseUrl}/api/user-profiles/switch`, { method: 'POST', headers: { cookie: base, 'content-type': 'application/json' }, body: JSON.stringify({ id, password }) });
  await response.text();
  const set = response.headers.get('set-cookie');
  return set ? `${base}; ${set.split(';')[0]}` : base;
}

async function put(node: PeerNode, cookie: string, route: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${node.baseUrl}${route}`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function view(node: PeerNode): Promise<UserProfilesView> {
  return (await node.call('GET', '/api/user-profiles')).body as UserProfilesView;
}

describe('D176 · a checklist decides only for the computers it was set for', () => {
  it('A–B–C chain: A lists C through B; a list set without C in view leaves Bo allowed on C, blocks B; with C in view, decides C', async () => {
    const a = await startPeerNode(tmp, 'a');
    nodes.push(a);
    const b = await startPeerNode(tmp, 'b');
    nodes.push(b);
    const c = await startPeerNode(tmp, 'c');
    nodes.push(c);
    const bAddress = await enableListener(b);
    await enableListener(a);
    await enableListener(c);
    await pair(b, a, bAddress);
    await pair(b, c, bAddress);
    const [aId, bId, cId] = [await a.machineId(), await b.machineId(), await c.machineId()];
    await waitFor('A–B and B–C online', async () => (await machineOn(a, bId))?.state === 'online' && (await machineOn(b, aId))?.state === 'online' && (await machineOn(c, bId))?.state === 'online' && (await machineOn(b, cId))?.state === 'online', 30_000);
    // A and C are not paired.
    expect(await machineOn(a, cId)).toBeNull();

    // A knows C only through B (B reported its pairings in the profile exchange).
    const through = await waitFor('C through B on A', async () => (await view(a)).otherComputers?.find((computer) => computer.id === cId) ?? null, 30_000);
    const bName = (await machineOn(a, bId))?.name;
    expect(through.through).toBe(bName);
    expect((await view(a)).otherComputers?.map((computer) => computer.id)).not.toContain(bId);

    // Ann (A) becomes the first admin; Bo is made on A and reaches C through B (the relay).
    const ann = (await a.call('POST', '/api/user-profiles', { name: 'Ann', password: 'ann-secret' })).body as UserProfile;
    const bo = (await a.call('POST', '/api/user-profiles', { name: 'Bo', password: 'bo-secret' })).body as UserProfile;
    const annA = await signIn(a, ann.id, 'ann-secret');
    expect((await put(a, annA, `/api/user-profiles/${ann.id}/admin`, { admin: true, adminPassword: 'ann-secret' })).status).toBe(200);
    await waitFor('Bo on C', async () => ((await view(c)).profiles.find((profile) => profile.id === bo.id) ? true : null), 30_000);

    // A checklist shown before C was in view (A and B), Bo only on A: decided for A and B, not C.
    const limited = await put(a, annA, `/api/user-profiles/${bo.id}/access`, { computers: [aId], decidedFor: [aId, bId], adminPassword: 'ann-secret' });
    expect(limited.status, JSON.stringify(limited.body)).toBe(200);
    expect(limited.body).toMatchObject({ computers: [aId], allowedHere: true });
    expect([...limited.body.decidedFor].sort()).toEqual([aId, bId].sort());
    // B (decided, not ticked) refuses Bo; C (never decided) still allows Bo, with the list it got through B.
    await waitFor('Bo blocked on B', async () => ((await view(b)).profiles.find((profile) => profile.id === bo.id)?.allowedHere === false ? true : null), 30_000);
    const onC = await waitFor('the list on C', async () => {
      const profile = (await view(c)).profiles.find((entry) => entry.id === bo.id);
      return profile?.computers && profile.computers.length === 1 ? profile : null;
    }, 30_000);
    expect(onC.allowedHere).toBe(true);
    expect(onC.decidedFor).toEqual(expect.arrayContaining([aId, bId]));

    // Set with nothing named as shown: decided for every computer A knows (A, B, and C through B): C refuses Bo now.
    expect((await put(a, annA, `/api/user-profiles/${bo.id}/access`, { computers: [aId], adminPassword: 'ann-secret' })).status).toBe(200);
    await waitFor('Bo blocked on C', async () => ((await view(c)).profiles.find((profile) => profile.id === bo.id)?.allowedHere === false ? true : null), 30_000);
  }, 180_000);
});
