import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session, SessionDetail } from '../../../src/core/api.ts';
import { remoteId } from '../../../src/core/peers.ts';
import type { SidebarFolderArchiveResult } from '../../../src/core/sidebar-folder-archive.ts';
import type { SidebarLayout } from '../../../src/core/sidebar-layout.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D141 × D48 with two real Switchboard processes: deleting a folder on B with archiving
 * archives A's agent in it on A (through the peer proxy, the close route); while A is
 * offline its agent is kept (reason `offline`, A named) and moved out like a plain delete.
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-folder-archive');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function idleOn(node: PeerNode, name: string): Promise<string> {
  const created = await node.call('POST', '/api/sessions', { name, task: 'Say OK.', folder: node.folderId, worktrees: false, ultracode: false });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = (created.body as Session).id;
  await waitFor(`${name}'s turn done`, async () => ['idle', 'done'].includes(((await node.call('GET', `/api/sessions/${id}`)).body as SessionDetail).status));
  return id;
}

async function folderOn(node: PeerNode, name: string, sessionIds: readonly string[]): Promise<string> {
  const layout = (await node.call('POST', '/api/sidebar/folders', { name })).body as SidebarLayout;
  const id = layout.folders.find((f) => f.name === name)?.id as string;
  for (const sessionId of sessionIds) expect((await node.call('POST', '/api/sidebar/place', { sessionId, place: 'folder', folderId: id })).status).toBe(200);
  return id;
}

describe('D141 · a paired computer\'s agents in a deleted folder', () => {
  it('online: archived on their own computer through the proxy; offline: kept with the computer named', async () => {
    const { a, b, aId } = await pairedNodes(tmp);
    nodes.push(a, b);
    const onA = await idleOn(a, 'remote-review');
    const onB = await idleOn(b, 'local-review');
    const remote = remoteId(aId, onA);
    await waitFor('A\'s session listed on B', async () => ((await b.call('GET', '/api/sessions')).body as Session[]).some((s) => s.id === remote));
    const folder = await folderOn(b, 'Reviews', [onB, remote]);

    const answer = await b.call('DELETE', `/api/sidebar/folders/${folder}?archive=1`);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const result = answer.body as SidebarFolderArchiveResult;
    expect(result.archived.map((x) => x.sessionId).sort()).toEqual([onB, remote].sort());
    expect(result.archived.find((x) => x.sessionId === remote)?.machine).toBeTruthy();
    expect(result.kept).toEqual([]);
    expect(((await a.call('GET', `/api/sessions/${onA}`)).body as SessionDetail).closedAt).toBeTruthy();
    expect(((await b.call('GET', `/api/sessions/${onB}`)).body as SessionDetail).closedAt).toBeTruthy();
    expect(result.layout.folders.some((f) => f.id === folder)).toBe(false);

    // A second agent on A, then A goes away: it is kept, out of the folder.
    const second = await idleOn(a, 'remote-later');
    const secondRemote = remoteId(aId, second);
    await waitFor('A\'s second session listed on B', async () => ((await b.call('GET', '/api/sessions')).body as Session[]).some((s) => s.id === secondRemote));
    const later = await folderOn(b, 'Later', [secondRemote]);
    await a.server.stop();
    nodes = nodes.filter((node) => node !== a);
    await waitFor('A offline on B', async () => ((await b.call('GET', '/api/sessions')).body as Session[]).find((s) => s.id === secondRemote)?.machine?.state === 'offline');
    const offline = (await b.call('DELETE', `/api/sidebar/folders/${later}?archive=1`)).body as SidebarFolderArchiveResult;
    expect(offline.archived).toEqual([]);
    expect(offline.kept).toEqual([{ sessionId: secondRemote, name: expect.any(String), machine: expect.any(String), reason: 'offline' }]);
    expect(offline.layout.folders.some((f) => f.id === later)).toBe(false);
  }, 120_000);
});
