import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, machineOn, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D162 with two real Switchboard processes (`docs/peers.md` → *A paired computer's CPU
 * and RAM*): each sends its own CPU and memory on its peer stream (`machineStats`, when
 * the stream opens and at each keepalive); the other shows them as `Machine.stats` while
 * it is online, and drops them once it is gone.
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-stats');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

describe('D162 · a paired machine\'s CPU and memory', () => {
  it('B shows A\'s CPU and memory while A is online and drops them when A stops', async () => {
    const { a, b, aId, bId } = await pairedNodes(tmp);
    nodes.push(a, b);

    const aOnB = await waitFor('A\'s stats on B', async () => {
      const machine = await machineOn(b, aId);
      return machine?.state === 'online' && machine.stats ? machine : null;
    });
    const stats = aOnB.stats!;
    expect(stats.cpu).toBeGreaterThanOrEqual(0);
    expect(stats.cpu).toBeLessThanOrEqual(100);
    expect(stats.ramTotal).toBeGreaterThan(0);
    expect(stats.ramUsed).toBeGreaterThan(0);
    expect(stats.ramUsed).toBeLessThanOrEqual(stats.ramTotal);
    expect(Number.isFinite(Date.parse(stats.at))).toBe(true);
    // Both ways.
    await waitFor('B\'s stats on A', async () => ((await machineOn(a, bId))?.stats ? true : null));

    // A goes away: B no longer shows a stale reading.
    await a.server.stop();
    await waitFor('A away on B without stats', async () => {
      const machine = await machineOn(b, aId);
      return machine && machine.state !== 'online' && machine.state !== 'reconnecting' && machine.stats === undefined ? true : null;
    }, 60_000);
  }, 120_000);
});
