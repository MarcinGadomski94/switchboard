import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InterruptResult, Session, SessionDetail, StopBackgroundResult } from '../../../src/core/api.ts';
import { peerAnswerKind } from '../../../src/core/peer-wire.ts';
import { remoteId } from '../../../src/core/peers.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D50 × D48: Stop and the background-task stop work on a peer's session through
 * the proxy (`PEER_API_ALLOW`), with two real Switchboard processes: B stops a
 * turn A runs (a queued message comes back to B), and B stops A's background
 * task. The answers carry B's view of the session (its remote id, the machine).
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-stop');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function world() {
  const pairedWorld = await pairedNodes(tmp);
  nodes.push(pairedWorld.a, pairedWorld.b);
  return pairedWorld;
}

async function startOn(node: PeerNode, name: string, task: string): Promise<Session> {
  const created = await node.call('POST', '/api/sessions', { name, task, folder: node.folderId, worktrees: false, ultracode: false });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body as Session;
}

describe('D50 on a peer\'s session (D48 proxy)', () => {
  it('the routes are on the peer API allow-list, and their answers map the wrapped session', () => {
    expect(peerApiAllowed('POST', '/api/sessions/abc/interrupt')).toBe(true);
    expect(peerApiAllowed('POST', '/api/sessions/abc/background/stop')).toBe(true);
    expect(peerApiAllowed('GET', '/api/sessions/abc/interrupt')).toBe(false);
    expect(peerAnswerKind('POST', '/api/sessions/abc/interrupt')).toBe('wrapped');
    expect(peerAnswerKind('POST', '/api/sessions/abc/background/stop')).toBe('wrapped');
  });

  it('B stops a turn running on A: the queued message comes back to B, A\'s session is idle', async () => {
    const { a, b, aId } = await world();
    const local = await startOn(a, 'stop-on-a', '[fake:hold 30] Think it through.');
    const id = remoteId(aId, local.id);
    await waitFor('A runs the turn', async () => ((await a.call('GET', `/api/sessions/${local.id}`)).body as SessionDetail).activity?.state === 'thinking');
    expect((await b.call('POST', `/api/sessions/${encodeURIComponent(id)}/messages`, { text: 'Queued from B.' })).status).toBe(202);

    const answer = await b.call('POST', `/api/sessions/${encodeURIComponent(id)}/interrupt`);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const body = answer.body as InterruptResult;
    expect(body.outcome).toBe('stopped');
    expect(body.withdrawn).toEqual(['Queued from B.']);
    expect(body.session).toMatchObject({ id, status: 'idle', machine: { id: aId } });
    expect(((await a.call('GET', `/api/sessions/${local.id}`)).body as SessionDetail).status).toBe('idle');
  });

  it('B stops A\'s background task', async () => {
    const { a, b, aId } = await world();
    const local = await startOn(a, 'bg-on-a', 'Start the dev server. [fake:background 60 npm run dev]');
    const id = remoteId(aId, local.id);
    const task = await waitFor('A waits on the background task', async () => ((await a.call('GET', `/api/sessions/${local.id}`)).body as SessionDetail).activity?.background[0]);
    const answer = await b.call('POST', `/api/sessions/${encodeURIComponent(id)}/background/stop`, {});
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const body = answer.body as StopBackgroundResult;
    expect(body).toMatchObject({ stopped: [task.id], failed: [] });
    expect(body.session).toMatchObject({ id, machine: { id: aId }, activity: null });
  });
});
