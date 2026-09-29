import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HubEventName, Session, SessionDetail } from '../../../src/core/api.ts';
import { remoteId } from '../../../src/core/peers.ts';
import { readSse } from '../../../src/server/peers/sse.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D53 × D48: a peer's live activity reaches this machine. Two real Switchboard
 * processes: A runs a supervised session (fake-claude) whose turn sits in a slow
 * Bash call; B's `/hub` gets A's `activity` events namespaced, B's session list
 * and detail carry the running tool (the list from the peer cache, which the
 * events keep current), and once A is gone B shows no live activity (its offline
 * note says why).
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-activity');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

/** Collects `node`'s own `/hub` events (as its browser would get them); `ready` once the stream is open. */
function hubOf(node: PeerNode): { readonly events: Array<{ name: HubEventName; payload: any }>; readonly ready: Promise<void>; stop(): void } {
  const events: Array<{ name: HubEventName; payload: any }> = [];
  const abort = new AbortController();
  let opened: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  void (async () => {
    const token = (await readFile(path.join(node.dataDir, 'sb_token'), 'utf8')).trim();
    const response = await fetch(`${node.baseUrl}/hub`, { headers: { cookie: `sb_token=${token}` }, signal: abort.signal });
    opened();
    if (!response.body) return;
    await readSse(response.body, (frame) => events.push({ name: frame.event as HubEventName, payload: JSON.parse(frame.data) }), abort.signal);
  })().catch(() => undefined);
  return { events, ready, stop: () => abort.abort() };
}

describe('D53: a peer\'s live activity on this machine', () => {
  it('a supervised session running a tool on A shows ● Bash on B (hub, list, detail); none once A is offline', async () => {
    const world = await pairedNodes(tmp);
    nodes.push(world.a, world.b);
    const { a, b, aId } = world;
    const hub = hubOf(b);
    await hub.ready;
    try {
      const created = await a.call('POST', '/api/sessions', { name: 'slow-on-a', task: '[fake:interrupt-tool] Run the slow command.', folder: a.folderId, worktrees: false, ultracode: false });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = remoteId(aId, (created.body as Session).id);

      const event = await waitFor('A\'s activity on B\'s /hub', async () => hub.events.find((entry) => entry.name === 'activity' && entry.payload.sessionId === id && entry.payload.activity?.state === 'tool'));
      expect(event.payload.activity).toMatchObject({ state: 'tool', tool: 'Bash' });
      const detail = await waitFor('the detail on B', async () => {
        const answer = (await b.call('GET', `/api/sessions/${encodeURIComponent(id)}`)).body as SessionDetail;
        return answer.activity?.state === 'tool' ? answer : null;
      });
      expect(detail.activity).toMatchObject({ tool: 'Bash' });
      const listed = await waitFor('the list on B', async () => ((await b.call('GET', '/api/sessions')).body as Session[]).find((session) => session.id === id && session.activity?.state === 'tool'));
      expect(listed.machine?.state).toBe('online');

      await a.server.stop();
      const offline = await waitFor('offline on B', async () => ((await b.call('GET', '/api/sessions')).body as Session[]).find((session) => session.id === id && session.machine?.state !== 'online'));
      expect(offline.activity).toBeNull();
    } finally {
      hub.stop();
    }
  });
});
