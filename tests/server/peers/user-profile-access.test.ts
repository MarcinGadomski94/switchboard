import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MachinesView } from '../../../src/core/peers.ts';
import type { UserProfile, UserProfilesView } from '../../../src/core/user-profiles.ts';
import { TOKEN_FILE } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D173 with two real Switchboard processes (`docs/profiles.md` → *Admins and computer access*): the
 * first admin (bootstrap), admins only; Bo limited to computer A can't be used on B, A hides B's agents
 * from Bo, a request in Bo's profile forwarded to B is refused, a move to B too; Bo's agent on B keeps
 * running; the access syncs both ways.
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-user-profile-access');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

interface Answer {
  readonly status: number;
  readonly body: any;
}

async function token(node: PeerNode): Promise<string> {
  return (await readFile(path.join(node.dataDir, TOKEN_FILE), 'utf8')).trim();
}

/** Switches a browser on `node` to profile `id`: the status and that browser's cookie header. */
async function signIn(node: PeerNode, id: string, password?: string): Promise<{ status: number; cookie: string }> {
  const base = `sb_token=${await token(node)}`;
  const response = await fetch(`${node.baseUrl}/api/user-profiles/switch`, { method: 'POST', headers: { cookie: base, 'content-type': 'application/json' }, body: JSON.stringify({ id, password }) });
  await response.text();
  const set = response.headers.get('set-cookie');
  return { status: response.status, cookie: set ? `${base}; ${set.split(';')[0]}` : base };
}

async function as(node: PeerNode, cookie: string, method: string, route: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`${node.baseUrl}${route}`, {
    method,
    headers: { cookie, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function profileOn(node: PeerNode, id: string): Promise<UserProfile | undefined> {
  return ((await node.call('GET', '/api/user-profiles')).body as UserProfilesView).profiles.find((profile) => profile.id === id);
}

const names = (answer: Answer): string[] => (answer.body as Array<{ name: string }>).map((session) => session.name);

describe('D173 · admins decide which computers each profile may use', () => {
  it('bootstrap, admins only, Bo limited to A: refused on B, B’s agents hidden on A, forwards and moves refused, its agent on B kept; syncs both ways', async () => {
    const { a, b } = await pairedNodes(tmp, {}, {}, { separateDefaults: true });
    nodes.push(a, b);
    const [aId, bId] = [await a.machineId(), await b.machineId()];
    const ann = (await a.call('POST', '/api/user-profiles', { name: 'Ann', password: 'ann-secret' })).body as UserProfile;
    const bo = (await a.call('POST', '/api/user-profiles', { name: 'Bo', password: 'bo-secret' })).body as UserProfile;
    const cy = (await a.call('POST', '/api/user-profiles', { name: 'Cy' })).body as UserProfile;
    await waitFor('the profiles on B', async () => ((await profileOn(b, cy.id)) ? true : null), 30_000);

    const annA = (await signIn(a, ann.id, 'ann-secret')).cookie;
    const boA = (await signIn(a, bo.id, 'bo-secret')).cookie;
    const cyA = (await signIn(a, cy.id)).cookie;

    // Bootstrap: no admin yet. A profile without a password can't; one can't make another admin; Ann makes herself the first admin.
    expect((await as(a, cyA, 'PUT', `/api/user-profiles/${cy.id}/admin`, { admin: true })).status).toBe(403);
    expect((await as(a, boA, 'PUT', `/api/user-profiles/${ann.id}/admin`, { admin: true, adminPassword: 'bo-secret' })).status).toBe(403);
    expect((await as(a, annA, 'PUT', `/api/user-profiles/${ann.id}/admin`, { admin: true, adminPassword: 'wrong' })).status).toBe(401);
    const made = await as(a, annA, 'PUT', `/api/user-profiles/${ann.id}/admin`, { admin: true, adminPassword: 'ann-secret' });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body).toMatchObject({ admin: true });

    // After the bootstrap only an admin manages: Bo (no admin) is refused.
    expect((await as(a, boA, 'PUT', `/api/user-profiles/${bo.id}/admin`, { admin: true, adminPassword: 'bo-secret' })).body).toMatchObject({ error: 'not-admin' });
    expect((await as(a, boA, 'PUT', `/api/user-profiles/${bo.id}/access`, { computers: 'all', adminPassword: 'bo-secret' })).status).toBe(403);
    // The invariants: an admin needs a password; the last admin stays; an admin's password can't be removed.
    expect((await as(a, annA, 'PUT', `/api/user-profiles/${cy.id}/admin`, { admin: true, adminPassword: 'ann-secret' })).body).toMatchObject({ error: 'needs-password' });
    expect((await as(a, annA, 'PUT', `/api/user-profiles/${ann.id}/admin`, { admin: false, adminPassword: 'ann-secret' })).body).toMatchObject({ error: 'last-admin' });
    expect((await as(a, annA, 'PUT', `/api/user-profiles/${ann.id}`, { password: null, currentPassword: 'ann-secret' })).body).toMatchObject({ error: 'admin-needs-password' });
    expect((await as(a, annA, 'PUT', `/api/user-profiles/${bo.id}/access`, { computers: ['not an id'], adminPassword: 'ann-secret' })).status).toBe(422);

    // Bo has an agent on B (made while Bo may use B); A lists it for Bo.
    const boB = (await signIn(b, bo.id, 'bo-secret')).cookie;
    const created = await as(b, boB, 'POST', '/api/sessions', { name: 'bo-on-b', task: 'Say OK.', folder: b.folderId, worktrees: false, ultracode: false });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    await waitFor('Bo’s agent on B listed on A', async () => (names(await as(a, boA, 'GET', '/api/sessions')).includes('bo-on-b') ? true : null), 30_000);

    // Ann limits Bo to computer A.
    const limited = await as(a, annA, 'PUT', `/api/user-profiles/${bo.id}/access`, { computers: [aId], adminPassword: 'ann-secret' });
    expect(limited.status, JSON.stringify(limited.body)).toBe(200);
    expect(limited.body).toMatchObject({ computers: [aId], allowedHere: true });

    // A → B: B learns the limit; Bo can't be switched to on B, and B's old cookie for Bo no longer signs a browser in.
    await waitFor('the limit on B', async () => ((await profileOn(b, bo.id))?.allowedHere === false ? true : null), 30_000);
    expect((await signIn(b, bo.id, 'bo-secret')).status).toBe(403);
    expect(((await as(b, boB, 'GET', '/api/user-profiles')).body as UserProfilesView).activeId).not.toBe(bo.id);

    // On A, Bo no longer sees B: not its agents, not the computer.
    await waitFor('B’s agent hidden from Bo on A', async () => (!names(await as(a, boA, 'GET', '/api/sessions')).includes('bo-on-b') ? true : null), 30_000);
    const machines = (await as(a, boA, 'GET', '/api/machines')).body as MachinesView;
    expect(machines.machines.map((machine) => machine.id)).not.toContain(bId);
    expect(((await as(a, annA, 'GET', '/api/machines')).body as MachinesView).machines.map((machine) => machine.id)).toContain(bId);

    // A request in Bo's profile forwarded to B is refused by B; a move to B is refused on A.
    const forwarded = await as(a, boA, 'POST', '/api/sessions', { machine: bId, name: 'bo-to-b', task: 'Say OK.', folder: b.folderId, worktrees: false, ultracode: false });
    expect(forwarded.status, JSON.stringify(forwarded.body)).toBe(403);
    expect((await as(a, boA, 'POST', '/api/takeover', { sessionId: 'x', targetMachine: bId })).body).toMatchObject({ error: 'not-allowed-there' });

    // B → A: Ann, on B, gives Bo every computer back; A learns it; Bo's agent on B was kept all along.
    const annB = (await signIn(b, ann.id, 'ann-secret')).cookie;
    expect((await as(b, annB, 'PUT', `/api/user-profiles/${bo.id}/access`, { computers: 'all', adminPassword: 'ann-secret' })).status).toBe(200);
    await waitFor('every computer on A', async () => ((await profileOn(a, bo.id))?.computers === null ? true : null), 30_000);
    const again = await signIn(b, bo.id, 'bo-secret');
    expect(again.status).toBe(200);
    const kept = (await as(b, again.cookie, 'GET', '/api/sessions')).body as Array<{ name: string; archived?: boolean }>;
    expect(kept.find((session) => session.name === 'bo-on-b')).toBeDefined();
    expect(kept.find((session) => session.name === 'bo-on-b')?.archived ?? false).toBe(false);
  }, 180_000);
});
