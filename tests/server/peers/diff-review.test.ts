import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiffCount, DiffTargets, FileDiff, Session, SessionDetail } from '../../../src/core/api.ts';
import { remoteId } from '../../../src/core/peers.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D174 × D48 (2026-11-20 follow-up): a paired computer's agent's For review. B opens A's
 * agent's To review "Open changes": B asks A, through the proxy, for the views (`review`
 * offered) and the `review` diff (`?scope=review` carried), and gets the agent's file.
 */
let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-diff-review');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

describe('For review of a paired computer’s agent', () => {
  it('B gets A’s agent’s For review: the view is offered and its file listed, the count agrees', async () => {
    const { a, b, aId } = await pairedNodes(tmp);
    nodes.push(a, b);
    const created = await a.call('POST', '/api/sessions', { name: 'review-on-a', task: '[fake:write report.md] Write it.', folder: a.folderId, worktrees: false, ultracode: false });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const local = created.body as Session;
    await waitFor('A’s review raised', async () => ((await a.call('GET', `/api/sessions/${local.id}`)).body as SessionDetail).review ?? null, 30_000);

    const id = encodeURIComponent(remoteId(aId, local.id));
    const targets = await b.call('GET', `/api/sessions/${id}/diff/targets`);
    expect(targets.status, JSON.stringify(targets.body)).toBe(200);
    expect((targets.body as DiffTargets).review).toBeDefined();
    const review = await b.call('GET', `/api/sessions/${id}/diff?scope=review`);
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    expect((review.body as FileDiff[]).map((f) => f.path)).toEqual(['report.md']);
    const counted = await waitFor('the count', async () => {
      const answer = (await b.call('GET', `/api/sessions/${id}/diff/count?scope=review`)).body as DiffCount;
      return answer.stale ? null : answer;
    }, 15_000);
    expect(counted).toMatchObject({ scope: 'review', files: 1 });
  }, 120_000);
});
