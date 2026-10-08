import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckpointPlan, SessionCheckpoints } from '../../../src/core/checkpoints.ts';
import type { Session, SessionDetail } from '../../../src/core/api.ts';
import { remoteId } from '../../../src/core/peers.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D80 × D48: Undo a turn of a paired machine's session through the proxy, with two
 * real Switchboard processes: B lists A's session's checkpoints, previews, reverts
 * and redoes; the files change in A's repo (the revert runs on A).
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-undo');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function exists(file: string): Promise<boolean> {
  return readFile(file).then(
    () => true,
    () => false,
  );
}

describe('D80 on a peer\'s session (D48 proxy)', () => {
  it('B reverts a turn of A\'s session and redoes it; the files change on A', async () => {
    const { a, b, aId } = await pairedNodes(tmp);
    nodes.push(a, b);
    const created = await a.call('POST', '/api/sessions', { name: 'undo-on-a', task: '[fake:write peer.txt] Write it.', folder: a.folderId, worktrees: false, ultracode: false });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const local = created.body as Session;
    await waitFor('A finished the turn', async () => ['idle', 'done'].includes(((await a.call('GET', `/api/sessions/${local.id}`)).body as SessionDetail).status));
    const file = path.join(a.repo as string, 'peer.txt');
    expect(await exists(file)).toBe(true);

    const id = encodeURIComponent(remoteId(aId, local.id));
    const list = await b.call('GET', `/api/sessions/${id}/checkpoints`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect((list.body as SessionCheckpoints).turns.map((turn) => turn.turn)).toEqual([1]);
    const plan = await b.call('GET', `/api/sessions/${id}/checkpoints/1`);
    expect((plan.body as CheckpointPlan).repos[0]?.files).toEqual([{ path: 'peer.txt', change: 'deleted' }]);

    const reverted = await b.call('POST', `/api/sessions/${id}/checkpoints/1/revert`, {});
    expect(reverted.status, JSON.stringify(reverted.body)).toBe(200);
    expect(await exists(file)).toBe(false);
    expect(((await b.call('GET', `/api/sessions/${id}/checkpoints`)).body as SessionCheckpoints).redo).toMatchObject({ turn: 1 });

    expect((await b.call('POST', `/api/sessions/${id}/checkpoints/redo`, {})).status).toBe(200);
    expect(await exists(file)).toBe(true);
  });
});
