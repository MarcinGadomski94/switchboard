import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, it } from 'vitest';
import { removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, startPeerNode } from '../../helpers/peers.ts';
import { hang, leakLog, leakRoot, logSpawns } from './log.ts';

/**
 * Deliberately failing (run only by tests/server/test-servers-no-leak.test.ts): the patterns
 * that used to leave test servers running.
 */
logSpawns();

describe('a test that times out with its cleanup registered too late', () => {
  let tmp: string;
  let nodes: PeerNode[] = [];
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(leakRoot(), 'paired-'));
  });
  afterEach(async () => {
    await Promise.all(nodes.map((node) => node.server.stop()));
    nodes = [];
    await removeTempDir(tmp);
  });

  it('pairedNodes, then hangs before nodes.push', { timeout: 30_000 }, async () => {
    const world = await pairedNodes(tmp);
    leakLog('paired');
    await hang();
    nodes.push(world.a, world.b);
  });

  it('a start that only begins after the test gave up is refused', { timeout: 300 }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    try {
      await startPeerNode(tmp, 'late');
      leakLog('late started');
    } catch (error) {
      leakLog(`late refused: ${(error as Error).message.split('\n')[0]}`);
    }
  });
});

describe('a beforeAll that times out on a server that ignores SIGTERM', () => {
  beforeAll(async () => {
    const root = await mkdtemp(path.join(leakRoot(), 'hung-'));
    const node = await startPeerNode(root, 'x');
    // A hung server: stopped, it never handles SIGTERM; only the SIGKILL to its group ends it.
    process.kill(node.server.child.pid as number, 'SIGSTOP');
    leakLog('stopped');
    await hang();
  }, 20_000);

  it('never runs', () => undefined);
});
