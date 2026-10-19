import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpuSeconds } from '../../../tools/bench/server.ts';
import { helperRss } from '../../../tools/bench/soak.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, startPeerNode, waitFor } from '../../helpers/peers.ts';

/**
 * 1.24 perf (`docs/performance.md` → *Long runs (1.24)*): a server with live sessions and their
 * `switchboard` MCP helpers (Team, Plans and Project memory on, a `/hub` reader like an open tab)
 * does next to nothing while no session works. The long version is `tools/bench/soak.ts`.
 */
describe.skipIf(process.platform === 'win32')('idle server', () => {
  let tmp: string;
  let node: PeerNode | undefined;
  let hub: AbortController | undefined;

  beforeAll(async () => {
    tmp = await makeTempDir('perf-idle');
    node = await startPeerNode(tmp, 'idle', { repo: true, env: { FAKE_CLAUDE_MCP_RUN: '1' } });
  }, 60_000);

  afterAll(async () => {
    hub?.abort();
    await node?.server.stop();
    await removeTempDir(tmp);
  });

  it('three live sessions with helpers, nothing working: under 4 % of a core over 20 s', async () => {
    const n = node as PeerNode;
    await n.call('PUT', '/api/settings', { 'experimental.team': true, 'experimental.plans': true, 'experimental.memory': true });
    hub = new AbortController();
    const token = (await readFile(path.join(n.dataDir, 'sb_token'), 'utf8')).trim();
    // An open tab: the hub's 5 s system tick runs while a client is connected.
    void fetch(`${n.baseUrl}/hub?delta=1`, { headers: { accept: 'text/event-stream', cookie: `sb_token=${token}` }, signal: hub.signal }).then((response) => response.body?.pipeTo(new WritableStream())).catch(() => undefined);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const started = await n.call('POST', '/api/sessions', { simple: true, name: `idle-${i}`, title: `Idle ${i}`, task: 'Say hello.', folder: n.folderId, worktrees: false });
      expect(started.status).toBe(201);
      ids.push(started.body.id as string);
    }
    await waitFor('sessions idle', async () => {
      for (const id of ids) if ((await n.call('GET', `/api/sessions/${id}`)).body?.status === 'run') return false;
      return true;
    }, 60_000);
    await waitFor('three helpers', async () => (await helperRss(n.server.port)).length >= 3, 30_000);
    // Let the turn-end work (snapshots, enrichers) settle.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const pid = n.server.child.pid ?? 0;
    const cpu0 = await cpuSeconds(pid);
    const at0 = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    const pct = (((await cpuSeconds(pid)) - cpu0) * 1000 * 100) / (Date.now() - at0);
    // Measured ≈0.5–1 % on Apple silicon (the soak bench: 10 sessions ≈1–2 %).
    expect(pct).toBeLessThan(4);
  }, 150_000);
});
