import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import { remoteId, parseRemoteId } from '../../../src/core/peers.ts';
import type { SidebarLayout } from '../../../src/core/sidebar-layout.ts';
import { type FakeJira, startFakeJira } from '../../helpers/fake-jira.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D119 × D48 / D71: B imports a Jira epic into a new session on A (`/api/machines/{A}/api/plans/jira/import`).
 * The session runs on A, but the plan's own sidebar subfolder is made in B's layout (the one the
 * developer picked from), holding the session's remote id; `sidebarFolderId` is never forwarded
 * (A's layout is untouched while the layout is not shared). With the shared layout on, A shows the
 * same subfolder.
 */

let tmp: string;
let nodes: PeerNode[] = [];
let fake: FakeJira | null = null;

beforeEach(async () => {
  tmp = await makeTempDir('peers-plan-import-place');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await fake?.close();
  fake = null;
  await removeTempDir(tmp);
});

async function layoutOf(node: PeerNode): Promise<SidebarLayout> {
  return (await node.call('GET', '/api/sidebar')).body as SidebarLayout;
}

/** A with Plans on and the fake Jira connected. */
async function plansOn(node: PeerNode, jira: FakeJira): Promise<void> {
  const saved = await node.call('PUT', '/api/integrations/jira', { baseUrl: jira.url, email: jira.email, token: jira.token });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
}

const IMPORT = { epic: 'PROJ-10', targetBranch: 'feature/PROJ-10-acme-checkout', title: 'PROJ-10 Acme checkout' };

describe('an import on a paired machine places the plan in the layout it was picked from', () => {
  it('sync off: the subfolder is B\'s, with A\'s session (remote id) first; A\'s layout is untouched', async () => {
    const { a, b, aId } = await pairedNodes(tmp, { SWITCHBOARD_TEST_SECRET_STORE: 'memory' });
    nodes.push(a, b);
    fake = await startFakeJira();
    await plansOn(a, fake);
    const acme = await b.call('POST', '/api/sidebar/folders', { name: 'Acme' });
    const acmeOnB = ((acme.body as SidebarLayout).folders.find((f) => f.name === 'Acme') as { id: string }).id;

    // An unknown sidebar folder is refused on B before anything is sent to A.
    const refused = await b.call('POST', `/api/machines/${aId}/api/plans/jira/import`, { ...IMPORT, folder: a.folderId, sidebarFolderId: 'no-such-folder' });
    expect(refused.status).toBe(404);
    expect(((await a.call('GET', '/api/sessions')).body as Session[]).length).toBe(0);

    const answer = await b.call('POST', `/api/machines/${aId}/api/plans/jira/import`, { ...IMPORT, folder: a.folderId, sidebarFolderId: acmeOnB });
    expect(answer.status, JSON.stringify(answer.body)).toBe(201);
    const { session, sidebarFolder } = answer.body as { session: Session; sidebarFolder: { id: string; name: string; parentId: string | null } };
    expect(parseRemoteId(session.id)?.machineId).toBe(aId);
    expect(sidebarFolder).toMatchObject({ name: 'Plan · PROJ-10 Acme checkout', parentId: acmeOnB });
    const onB = (await layoutOf(b)).folders.find((f) => f.id === sidebarFolder.id);
    expect(onB).toMatchObject({ parentId: acmeOnB, sessionIds: [session.id] });
    expect((await layoutOf(a)).folders).toEqual([]);
  }, 90_000);

  it('sync on (D71): A shows the same subfolder with its own session in it', async () => {
    const { a, b, aId, bId } = await pairedNodes(tmp, { SWITCHBOARD_TEST_SECRET_STORE: 'memory', SWITCHBOARD_PEER_TEST_HOOKS: '1' });
    nodes.push(a, b);
    expect((await a.call('PUT', `/api/machines/${bId}/sidebar-sync`, { enabled: true })).status).toBe(200);
    expect((await b.call('PUT', `/api/machines/${aId}/sidebar-sync`, { enabled: true })).status).toBe(200);
    fake = await startFakeJira();
    await plansOn(a, fake);
    const answer = await b.call('POST', `/api/machines/${aId}/api/plans/jira/import`, { ...IMPORT, folder: a.folderId, sidebarFolderId: null });
    expect(answer.status, JSON.stringify(answer.body)).toBe(201);
    const { session, sidebarFolder } = answer.body as { session: Session; sidebarFolder: { id: string } };
    const local = parseRemoteId(session.id)?.id as string;
    expect(session.id).toBe(remoteId(aId, local));
    await waitFor('A shows the subfolder with its session', async () => JSON.stringify((await layoutOf(a)).folders.find((f) => f.id === sidebarFolder.id)?.sessionIds) === JSON.stringify([local]));
  }, 90_000);
});
