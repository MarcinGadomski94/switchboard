import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InsightsAnswer } from '../../../src/core/insights.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D108 ruling × D48 with two real Switchboard processes: B's Insights (All machines) add A's
 * turns through the peer API (`/api/insights/rows`); B's own view stays B's; with A stopped,
 * B answers with its own numbers and says A is not reachable.
 */
let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-insights');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

describe('D108 · Insights across paired machines', () => {
  it("B's merged view includes A's turns; B's own view does not; A gone → B alone with a notice", async () => {
    const { a, b, aId } = await pairedNodes(tmp);
    nodes.push(a, b);
    const created = await a.call('POST', '/api/sessions', { name: 'insights-on-a', task: 'Say hello.', folder: a.folderId, worktrees: false, ultracode: false });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // A's own Insights count its turn.
    await waitFor("A's turn is rolled up", async () => {
      const own = await a.call('GET', '/api/insights?period=7d&machine=local');
      return own.status === 200 && (own.body as InsightsAnswer).time.totals.turns > 0 ? own.body : null;
    });

    const merged = await waitFor("B's merged view has A", async () => {
      const answer = await b.call('GET', '/api/insights?period=7d&machine=all&peers=wait');
      const body = answer.body as InsightsAnswer;
      return answer.status === 200 && body.time.totals.turns > 0 ? body : null;
    });
    expect(merged.machines.included.map((m) => m.id)).toEqual([null, aId]);
    expect(merged.time.bySession.every((row) => row.key.startsWith(`r~${aId}~`))).toBe(true);
    const own = (await b.call('GET', '/api/insights?period=7d&machine=local')).body as InsightsAnswer;
    expect(own.time.totals.turns).toBe(0);
    expect(own.machines.scope).toBe('local');

    await a.server.stop();
    const alone = await waitFor('B answers without A', async () => {
      const answer = await b.call('GET', '/api/insights?period=30d&machine=all&peers=wait');
      const body = answer.body as InsightsAnswer;
      return answer.status === 200 && body.machines.missing.length === 1 ? body : null;
    });
    expect(alone.machines.missing[0]).toMatchObject({ id: aId });
    expect(alone.time.totals.turns).toBe(0);
  });
});
