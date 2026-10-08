import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FreshContinueResult, Session, SessionDetail, SidebarLayout } from '../../../src/core/api.ts';
import { remoteId } from '../../../src/core/peers.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D83 × D48: B continues A's session in a fresh session through the proxy. The
 * handover and the new session run on A; B's answer carries its view of the old
 * session; the links come back namespaced, and the fresh session takes the old
 * one's place in B's sidebar (B pinned A's session by its remote id).
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-fresh');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

describe('D83 on a peer\'s session (D48 proxy)', () => {
  it('B continues A\'s session: the fresh session runs on A, links are namespaced, B\'s pin moves to it', async () => {
    const { a, b, aId } = await pairedNodes(tmp);
    nodes.push(a, b);
    const created = await a.call('POST', '/api/sessions', { name: 'peer-fresh', task: 'Go. [fake:usage 170000]', folder: a.folderId, worktrees: false, ultracode: false });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const local = created.body as Session;
    await waitFor('A finished the turn', async () => ((await a.call('GET', `/api/sessions/${local.id}`)).body as SessionDetail).status === 'done');
    const id = remoteId(aId, local.id);
    expect((await b.call('POST', '/api/sidebar/place', { sessionId: id, place: 'pinned' })).status).toBe(200);

    const answer = await b.call('POST', `/api/sessions/${encodeURIComponent(id)}/fresh`, {});
    expect(answer.status, JSON.stringify(answer.body)).toBe(202);
    expect((answer.body as FreshContinueResult).session).toMatchObject({ id, machine: { id: aId } });

    const continued = await waitFor('A continued it', async () => {
      const old = (await a.call('GET', `/api/sessions/${local.id}`)).body as Session;
      return old.continuedTo ? old : undefined;
    });
    const freshLocal = continued.continuedTo?.sessionId as string;
    expect(continued.closedAt).not.toBeNull();
    // Seen from B: namespaced links.
    const seen = (await b.call('GET', `/api/sessions/${encodeURIComponent(remoteId(aId, freshLocal))}`)).body as SessionDetail;
    expect(seen).toMatchObject({ id: remoteId(aId, freshLocal), continuedFrom: { sessionId: id, title: 'peer-fresh' } });
    expect(seen.events.find((event) => (event.payload as { action?: string } | null)?.action === 'continued-from')?.payload).toMatchObject({ linkedSessionId: id });
    // B's pin follows the fresh session (B's own layout holds A's sessions by their remote ids).
    await waitFor('B pinned the fresh session', async () => {
      const layout = (await b.call('GET', '/api/sidebar')).body as SidebarLayout;
      return layout.pinned.includes(remoteId(aId, freshLocal)) ? layout : undefined;
    });
    expect(((await b.call('GET', '/api/sidebar')).body as SidebarLayout).pinned).toEqual([remoteId(aId, freshLocal)]);
  });
});
