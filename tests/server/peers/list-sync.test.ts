import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArtifactListItem, Session } from '../../../src/core/api.ts';
import { type Machine, type MachineStateEvent, peerSyncNotes } from '../../../src/core/peers.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, machineOn, pairedNodes, waitFor } from '../../helpers/peers.ts';
import { type HubStream, openHub } from '../../helpers/sse.ts';

/**
 * D113 with two real Switchboard processes: B tells, per paired machine, where
 * its copies of A's artifacts and Inbox stand (`GET /api/machines` →
 * `listSync`, live as `/hub` `machineState`): syncing while A holds its answers
 * (the test hook), synced (a newer `syncedAt`) once they arrive, with A's new
 * artifact merged into B's Artifacts page; and an unreachable A goes offline
 * with no fetch left running.
 */

const HOOKS = { SWITCHBOARD_PEER_TEST_HOOKS: '1', SWITCHBOARD_PEER_GRACE_MS: '1500' };

let tmp: string;
let nodes: PeerNode[] = [];
let streams: HubStream[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-list-sync');
});
afterEach(async () => {
  for (const stream of streams) stream.close();
  streams = [];
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

/** A's status on B once its artifacts and Inbox are both in and nothing is being fetched. */
async function synced(b: PeerNode, aId: string, after: string | null = null): Promise<Machine> {
  return waitFor('A\'s artifacts and Inbox synced on B', async () => {
    const machine = await machineOn(b, aId);
    const sync = machine?.listSync;
    if (!machine || machine.state !== 'online' || !sync || sync.artifacts.syncing || sync.inbox.syncing) return null;
    if (!sync.artifacts.syncedAt || !sync.inbox.syncedAt) return null;
    if (after !== null && (sync.artifacts.syncedAt <= after || sync.inbox.syncedAt <= after)) return null;
    return machine;
  });
}

describe('D113 · a paired machine\'s list sync', () => {
  it('pending → synced: syncing while A holds its lists, then a newer syncedAt (machineState) and A\'s artifact merged in', async () => {
    const { a, b, aId } = await pairedNodes(tmp, HOOKS);
    nodes.push(a, b);
    const first = await synced(b, aId);
    expect(peerSyncNotes([first], 'artifacts')).toEqual([]);
    const created = await a.call('POST', '/api/sessions', { name: 'sync-on-a', task: 'Hi.', folder: a.folderId, worktrees: false, ultracode: false });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const localId = (created.body as Session).id;

    const token = (await readFile(path.join(b.dataDir, 'sb_token'), 'utf8')).trim();
    const hub = await openHub({ port: b.server.port, cookie: `sb_token=${token}`, headers: { host: `127.0.0.1:${b.server.port}` } });
    streams.push(hub);
    expect(hub.status).toBe(200);

    // A holds its lists; B's stream to A drops and reconnects, so B fetches both again (held).
    expect((await a.call('POST', '/api/test/peers/hold-lists')).status).toBe(204);
    expect((await a.call('POST', '/api/test/peers/drop')).status).toBe(200);
    const pending = await waitFor('A syncing on B', async () => {
      const machine = await machineOn(b, aId);
      return machine?.state === 'online' && machine.listSync?.artifacts.syncing && machine.listSync.inbox.syncing ? machine : null;
    });
    expect(peerSyncNotes([pending], 'artifacts')).toEqual([{ id: aId, name: pending.name, kind: 'syncing', text: `Syncing with ${pending.name}…` }]);
    expect(peerSyncNotes([pending], 'inbox').map((note) => note.kind)).toEqual(['syncing']);
    // Saved on A while the fetch waits: B's page does not have it yet.
    expect((await a.call('POST', `/api/sessions/${localId}/artifacts`, { title: 'Held notes', kind: 'markdown', content: '# Held\n' })).status).toBe(201);
    expect(((await b.call('GET', '/api/artifacts')).body as ArtifactListItem[]).map((item) => item.title)).not.toContain('Held notes');

    // A answers: synced (newer stamps), published live, and the artifact is on B's page.
    expect((await a.call('DELETE', '/api/test/peers/hold-lists')).status).toBe(204);
    const after = await synced(b, aId, first.listSync!.artifacts.syncedAt! > first.listSync!.inbox.syncedAt! ? first.listSync!.artifacts.syncedAt! : first.listSync!.inbox.syncedAt!);
    expect(peerSyncNotes([after], 'artifacts')).toEqual([]);
    expect(((await b.call('GET', '/api/artifacts')).body as ArtifactListItem[]).map((item) => item.title)).toContain('Held notes');
    const events = hub.payloads<MachineStateEvent>('machineState').filter((event) => event.id === aId);
    expect(events.some((event) => event.listSync?.artifacts.syncing === true)).toBe(true);
    expect(events.some((event) => event.listSync?.inbox.syncing === true)).toBe(true);
    expect(events.at(-1)?.listSync).toMatchObject({ artifacts: { syncing: false }, inbox: { syncing: false } });
    // The Inbox count went out again once A's Inbox arrived after the reconnect.
    expect(hub.payloads('inboxChanged').length).toBeGreaterThan(0);
  }, 60_000);

  it('offline: an unreachable A is offline on B with no fetch running; the pages show the static note', async () => {
    const { a, b, aId } = await pairedNodes(tmp, HOOKS);
    nodes.push(a, b);
    await synced(b, aId);
    expect((await a.call('POST', '/api/test/peers/outage', { ms: 60_000 })).status).toBe(204);
    const offline = await waitFor('A offline on B', async () => {
      const machine = await machineOn(b, aId);
      return machine?.state === 'offline' ? machine : null;
    }, 30_000);
    expect(offline.listSync).toMatchObject({ artifacts: { syncing: false }, inbox: { syncing: false } });
    expect(peerSyncNotes([offline], 'artifacts')).toEqual([{ id: aId, name: offline.name, kind: 'offline', text: `${offline.name} is offline — its artifacts may be out of date` }]);
    expect(peerSyncNotes([offline], 'inbox')[0]?.text).toBe(`${offline.name} is offline — its items are not shown until it is back`);
  }, 60_000);
});
