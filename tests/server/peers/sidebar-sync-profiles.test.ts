import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import type { MachineSidebarSync } from '../../../src/core/peers.ts';
import { remoteId } from '../../../src/core/peers.ts';
import type { SidebarLayout } from '../../../src/core/sidebar-layout.ts';
import type { UserProfile, UserProfilesView } from '../../../src/core/user-profiles.ts';
import { TOKEN_FILE } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, machineOn, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D179 (`docs/sidebar.md` → *Shared layout (D71)*, D179): with two real Switchboard processes whose
 * Defaults are two people (A's "Marcin", B's "Eskil", D172), the layout is shared per profile: a
 * profile shares only when it turned sharing on, on both computers; Marcin's folders never reach
 * Eskil's layout; a shared profile's folder and a new agent's place arrive at once (no reconnect).
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-sidebar-profiles');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

type Call = (method: string, route: string, body?: unknown) => Promise<{ status: number; body: any }>;

/** `node`'s API as a browser in profile `id` (its profile cookie). */
async function inProfile(node: PeerNode, id: string): Promise<Call> {
  const token = (await readFile(path.join(node.dataDir, TOKEN_FILE), 'utf8')).trim();
  const switched = await fetch(`${node.baseUrl}/api/user-profiles/switch`, { method: 'POST', headers: { cookie: `sb_token=${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
  await switched.text();
  expect(switched.status).toBe(200);
  const profileCookie = String(switched.headers.get('set-cookie')).split(';')[0] as string;
  return async (method, route, body) => {
    const answer = await fetch(`${node.baseUrl}${route}`, { method, headers: { cookie: `sb_token=${token}; ${profileCookie}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await answer.text();
    return { status: answer.status, body: text ? JSON.parse(text) : null };
  };
}

async function folder(call: Call, name: string): Promise<string> {
  const answer = await call('POST', '/api/sidebar/folders', { name });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return ((answer.body as SidebarLayout).folders.find((f) => f.name === name) as { id: string }).id;
}

async function setSync(call: Call, machineId: string, enabled: boolean): Promise<MachineSidebarSync> {
  const answer = await call('PUT', `/api/machines/${machineId}/sidebar-sync`, { enabled });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return (answer.body as { sidebarSync: MachineSidebarSync }).sidebarSync;
}

describe('D179 · the shared layout is per profile', () => {
  it('Marcin’s folders never reach Eskil’s layout; a shared profile’s folders and a new agent’s place arrive at once', async () => {
    const { a, b, aId, bId } = await pairedNodes(tmp, { SWITCHBOARD_PEER_TEST_HOOKS: '1', SWITCHBOARD_PEER_GRACE_MS: '20000' }, {}, { separateDefaults: true });
    nodes.push(a, b);
    expect((await a.call('PUT', '/api/user-profiles/default', { name: 'Marcin' })).status).toBe(200);
    expect((await b.call('PUT', '/api/user-profiles/default', { name: 'Eskil' })).status).toBe(200);
    // A profile both computers know (made on A, synced to B with its id).
    const team = (await a.call('POST', '/api/user-profiles', { name: 'Team' })).body as UserProfile;
    await waitFor('Team on B', async () => (((await b.call('GET', '/api/user-profiles')).body as UserProfilesView).profiles.some((p) => p.id === team.id) ? true : null), 30_000);

    // Each computer's Default shares (the switch in a browser in Default: the old one-switch case).
    const marcinOnA = await inProfile(a, 'default');
    const eskilOnB = await inProfile(b, 'default');
    const acme = await folder(marcinOnA, 'Acme');
    const eskilsOwn = await folder(eskilOnB, 'Eskil stuff');
    expect((await setSync(marcinOnA, bId, true)).profiles).toEqual(['default']);
    expect((await setSync(eskilOnB, aId, true)).profiles).toEqual(['default']);
    // Two different people: nothing of Marcin's reaches B, nothing of Eskil's reaches A (not even unseen records).
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const bFolders = ((await eskilOnB('GET', '/api/sidebar')).body as SidebarLayout).folders.map((f) => f.id);
    expect(bFolders).toEqual([eskilsOwn]);
    const marcinOnB = await inProfile(b, ((await b.call('GET', '/api/user-profiles')).body as UserProfilesView).profiles.find((p) => p.name === 'Marcin')?.id as string);
    expect(((await marcinOnB('GET', '/api/sidebar')).body as SidebarLayout).folders).toEqual([]);
    expect(((await marcinOnA('GET', '/api/sidebar')).body as SidebarLayout).folders.map((f) => f.id)).toEqual([acme]);

    // Team turns sharing on, on both computers: its folders sync at once, both ways.
    const teamOnA = await inProfile(a, team.id);
    const teamOnB = await inProfile(b, team.id);
    expect((await setSync(teamOnA, bId, true)).profiles?.slice().sort()).toEqual(['default', team.id].sort());
    expect(await setSync(teamOnB, aId, true)).toMatchObject({ enabled: true });
    const board = await folder(teamOnA, 'Board');
    await waitFor('Board on B (no reconnect)', async () => (((await teamOnB('GET', '/api/sidebar')).body as SidebarLayout).folders.some((f) => f.id === board) ? true : null), 10_000);
    // Eskil's and Marcin's layouts on B still hold only their own.
    expect(((await eskilOnB('GET', '/api/sidebar')).body as SidebarLayout).folders.map((f) => f.id)).toEqual([eskilsOwn]);

    // A new agent of Team on B, put in Team's folder there: its place is on A at once.
    const created = await teamOnB('POST', '/api/sessions', { name: 'team-chat', task: 'Say OK.', folder: b.folderId, worktrees: false, ultracode: false });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const agent = (created.body as Session).id;
    expect((await teamOnB('POST', '/api/sidebar/place', { sessionId: agent, place: 'folder', folderId: board })).status).toBe(200);
    await waitFor('the new agent in Board on A', async () => (((await teamOnA('GET', '/api/sidebar')).body as SidebarLayout).folders.find((f) => f.id === board)?.sessionIds.includes(remoteId(bId, agent)) ? true : null), 10_000);
    // The switch in Settings → Computers is each profile's own.
    expect((await machineOn(a, bId))?.sidebarSync?.profiles?.slice().sort()).toEqual(['default', team.id].sort());
    expect((await setSync(marcinOnA, bId, false)).profiles).toEqual([team.id]);
  }, 150_000);
});
