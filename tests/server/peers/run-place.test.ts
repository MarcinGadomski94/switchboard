import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session, SessionDetail, SessionTodoList, TodoRunResult } from '../../../src/core/api.ts';
import { parseRemoteId, remoteId } from '../../../src/core/peers.ts';
import type { SidebarLayout } from '../../../src/core/sidebar-layout.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D99 / D76 follow-up 2026-10-19 × D48 / D71: B starts a run of A's session through the proxy.
 * The run is A's (A owns it) and lands after its source on A; B, looking at A's sessions by
 * their remote ids, places it after the source in its own folder (sync off), and with the
 * shared layout on (D71) both machines end up with the same folder.
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-run-place');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function layoutOf(node: PeerNode): Promise<SidebarLayout> {
  return (await node.call('GET', '/api/sidebar')).body as SidebarLayout;
}

async function folder(node: PeerNode, name: string, parentId: string | null = null): Promise<string> {
  const answer = await node.call('POST', '/api/sidebar/folders', { name, parentId });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return ((answer.body as SidebarLayout).folders.find((f) => f.name === name && (f.parentId ?? null) === parentId) as { id: string }).id;
}

async function startOn(node: PeerNode, name: string): Promise<string> {
  const created = await node.call('POST', '/api/sessions', { name, task: 'Say OK.', folder: node.folderId, worktrees: false, ultracode: false });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = (created.body as Session).id;
  await waitFor(`${name} idle`, async () => ((await node.call('GET', `/api/sessions/${id}`)).body as SessionDetail).status === 'done');
  return id;
}

/** B runs a new item of A's session `sourceOnB` (its remote id) through the proxy; answers the run's id on A. */
async function runFromB(b: PeerNode, sourceOnB: string, title: string): Promise<string> {
  const list = (await b.call('POST', `/api/sessions/${encodeURIComponent(sourceOnB)}/todos`, { title, plan: 'No plan', priority: 'high', estimateMinutes: 10 })).body as SessionTodoList;
  const todoId = list.todos.find((todo) => todo.title === title)?.id as string;
  const answer = await b.call('POST', `/api/sessions/${encodeURIComponent(sourceOnB)}/todos/${todoId}/run`);
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  const id = (answer.body as TodoRunResult).session.id;
  return parseRemoteId(id)?.id ?? id;
}

async function holds(node: PeerNode, folderId: string, ids: readonly string[]): Promise<void> {
  await waitFor(`folder holds ${ids.join(', ')}`, async () => JSON.stringify((await layoutOf(node)).folders.find((f) => f.id === folderId)?.sessionIds) === JSON.stringify(ids));
}

describe('a run started through the proxy goes after its source', () => {
  it('sync off: A places it after the source in A\'s layout, B after the source\'s remote id in B\'s folder', async () => {
    const { a, b, aId } = await pairedNodes(tmp);
    nodes.push(a, b);
    const source = await startOn(a, 'source-on-a');
    const sourceOnB = remoteId(aId, source);
    const onA = await folder(a, 'Acme');
    expect((await a.call('POST', '/api/sidebar/place', { sessionId: source, place: 'folder', folderId: onA })).status).toBe(200);
    const releasesOnB = await folder(b, 'Releases', await folder(b, 'Acme'));
    await waitFor('B lists A\'s session', async () => ((await b.call('GET', '/api/sessions')).body as Session[]).some((s) => s.id === sourceOnB));
    expect((await b.call('POST', '/api/sidebar/place', { sessionId: sourceOnB, place: 'folder', folderId: releasesOnB })).status).toBe(200);

    const run = await runFromB(b, sourceOnB, 'Write the notes');
    await holds(a, onA, [source, run]);
    await holds(b, releasesOnB, [sourceOnB, remoteId(aId, run)]);
  }, 60_000);

  it('sync on (D71): the same folder on both machines, the run right after its source', async () => {
    const { a, b, aId, bId } = await pairedNodes(tmp, { SWITCHBOARD_PEER_TEST_HOOKS: '1', SWITCHBOARD_PEER_GRACE_MS: '20000' });
    nodes.push(a, b);
    expect((await a.call('PUT', `/api/machines/${bId}/sidebar-sync`, { enabled: true })).status).toBe(200);
    expect((await b.call('PUT', `/api/machines/${aId}/sidebar-sync`, { enabled: true })).status).toBe(200);
    const source = await startOn(a, 'source-on-a');
    const releases = await folder(a, 'Releases', await folder(a, 'Acme'));
    expect((await a.call('POST', '/api/sidebar/place', { sessionId: source, place: 'folder', folderId: releases })).status).toBe(200);
    await holds(b, releases, [remoteId(aId, source)]);

    const run = await runFromB(b, remoteId(aId, source), 'Write the notes');
    await holds(a, releases, [source, run]);
    await holds(b, releases, [remoteId(aId, source), remoteId(aId, run)]);
  }, 60_000);
});
