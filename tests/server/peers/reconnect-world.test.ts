import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HubEventName, Session, SessionDetail } from '../../../src/core/api.ts';
import { type Machine, type ReconnectResult, remoteId } from '../../../src/core/peers.ts';
import { readSse } from '../../../src/server/peers/sse.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, machineOn, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * Fix · peer reconnects (`docs/peers.md` → *Connection states*) with two real
 * Switchboard processes. A's test hooks (`SWITCHBOARD_PEER_TEST_HOOKS=1`) cut B's
 * event stream or stop A's peer listener for a while (connection refused), so B
 * sees a drop without any real network: `reconnecting` (reads from the cache,
 * actions held) and back within the grace period; a long outage → `offline`
 * (actions refused at once) → **Reconnect now** once A is back. B's `/hub` carries
 * every change as `machineState`.
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-reconnect');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function world(graceMs: number) {
  const pairedWorld = await pairedNodes(tmp, { SWITCHBOARD_PEER_TEST_HOOKS: '1', SWITCHBOARD_PEER_GRACE_MS: String(graceMs) });
  nodes.push(pairedWorld.a, pairedWorld.b);
  return pairedWorld;
}

async function startOn(node: PeerNode, name: string): Promise<Session> {
  const created = await node.call('POST', '/api/sessions', { name, task: 'Say OK.', folder: node.folderId, worktrees: false, ultracode: false });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body as Session;
}

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

/** The states B's `/hub` reported for machine `id`, in order, without repeats. */
function statesOf(events: ReadonlyArray<{ name: HubEventName; payload: any }>, id: string): string[] {
  const states: string[] = [];
  for (const event of events) {
    if (event.name !== 'machineState' || (event.payload as Machine).id !== id) continue;
    const state = (event.payload as Machine).state;
    if (states.at(-1) !== state) states.push(state);
  }
  return states;
}

async function sessionReady(a: PeerNode, b: PeerNode, aId: string, name: string): Promise<{ readonly id: string; readonly path: string }> {
  const local = await startOn(a, name);
  await waitFor('the turn done on A', async () => ['idle', 'done'].includes(((await a.call('GET', `/api/sessions/${local.id}`)).body as SessionDetail).status));
  const id = remoteId(aId, local.id);
  await waitFor('listed on B', async () => ((await b.call('GET', '/api/sessions')).body as Session[]).some((session) => session.id === id));
  const route = `/api/sessions/${encodeURIComponent(id)}`;
  // B opens it: the detail becomes the snapshot reads fall back on.
  expect((await b.call('GET', route)).status).toBe(200);
  return { id, path: route };
}

describe('fix · peer reconnects: a dropped stream', () => {
  it('a cut stream is reconnected at once; a short outage is reconnecting (reads work, an action is held) and back within the grace period, never offline', async () => {
    const { a, b, aId } = await world(10_000);
    const { id, path: route } = await sessionReady(a, b, aId, 'short-outage');
    const hub = hubOf(b);
    try {
      await hub.ready;

      // The stream is cut (as a relay dropping it would): B is back on a new stream at once.
      expect((await a.call('POST', '/api/test/peers/drop')).body).toMatchObject({ dropped: expect.any(Number) });
      await waitFor('reconnecting reported', async () => statesOf(hub.events, aId).includes('reconnecting'));
      await waitFor('online again', async () => (await machineOn(b, aId))?.state === 'online', 5_000);

      // A's listener stops for 2.5 s: connection refused while it is down.
      expect((await a.call('POST', '/api/test/peers/outage', { ms: 2_500 })).status).toBe(204);
      const during = await waitFor('reconnecting with a refused attempt', async () => {
        const machine = await machineOn(b, aId);
        return machine?.state === 'reconnecting' && machine.connection?.lastFailure?.kind === 'refused' ? machine : null;
      });
      expect(during.connection).toMatchObject({ graceUntil: expect.any(String), lastFailure: { message: expect.stringMatching(/^connection refused/) } });
      // Reads keep working: the list (tagged reconnecting) and the detail from the snapshot.
      const listed = ((await b.call('GET', '/api/sessions')).body as Session[]).find((session) => session.id === id);
      expect(listed?.machine?.state).toBe('reconnecting');
      const detail = await b.call('GET', route);
      expect(detail.status).toBe(200);
      // An action is held until A is back, then done.
      const asked = Date.now();
      const renamed = await b.call('PUT', `${route}/title`, { title: 'Held then done' });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
      expect(Date.now() - asked).toBeGreaterThan(200);
      expect(((await a.call('GET', `/api/sessions/${id.split('~')[2]}`)).body as SessionDetail).title).toBe('Held then done');
      expect((await machineOn(b, aId))?.state).toBe('online');
      expect(statesOf(hub.events, aId)).not.toContain('offline');
      expect(statesOf(hub.events, aId)).toEqual(['reconnecting', 'online', 'reconnecting', 'online']);
    } finally {
      hub.stop();
    }
  });
});

describe('fix · peer reconnects: a long outage and Reconnect now', () => {
  it('offline after the grace period (actions refused at once), Reconnect now answers the reason while A is down and online once it is back', async () => {
    const { a, b, aId } = await world(1_500);
    const { path: route } = await sessionReady(a, b, aId, 'long-outage');
    const hub = hubOf(b);
    try {
      await hub.ready;
      expect((await a.call('POST', '/api/test/peers/outage', { ms: 120_000 })).status).toBe(204);
      const offline = await waitFor('offline on B', async () => {
        const machine = await machineOn(b, aId);
        return machine?.state === 'offline' ? machine : null;
      });
      expect(offline.connection?.lastFailure?.kind).toBe('refused');
      expect(statesOf(hub.events, aId)).toEqual(['reconnecting', 'offline']);

      // Offline: actions are refused at once with the reason; reads come from the snapshot.
      const asked = Date.now();
      const refused = await b.call('PUT', `${route}/title`, { title: 'Refused' });
      expect(Date.now() - asked).toBeLessThan(1_000);
      expect(refused).toMatchObject({ status: 502, body: { error: 'peer-unreachable', state: 'offline', message: expect.stringMatching(/ is unreachable — /) } });
      expect((await b.call('GET', route)).status).toBe(200);

      // Reconnect now while A is still down: one attempt, the reason.
      const failed = await b.call('POST', `/api/machines/${aId}/reconnect`);
      expect(failed.status).toBe(200);
      expect(failed.body as ReconnectResult).toMatchObject({ outcome: 'offline', machine: { id: aId, state: 'offline', connection: { trying: false, lastFailure: { kind: 'refused' } } } });

      // A is back: Reconnect now reaches it at once (two at once share one attempt).
      expect((await a.call('DELETE', '/api/test/peers/outage')).status).toBe(204);
      const started = Date.now();
      const [first, second] = await Promise.all([b.call('POST', `/api/machines/${aId}/reconnect`), b.call('POST', `/api/machines/${aId}/reconnect`)]);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(first.body as ReconnectResult).toMatchObject({ outcome: 'online', machine: { state: 'online', connection: { attempt: 0 } } });
      expect((second.body as ReconnectResult).outcome).toBe('online');
      expect((await b.call('PUT', `${route}/title`, { title: 'Back' })).status).toBe(200);
      await waitFor('online on the hub', async () => statesOf(hub.events, aId).at(-1) === 'online');

      // An unknown machine.
      expect((await b.call('POST', '/api/machines/zzzzzzzzzzzz/reconnect')).status).toBe(404);

      // B's service log tells what happened, with the machine's name and id and never a token.
      const log = b.server.output();
      const name = offline.name;
      expect(log).toContain(`switchboard peers: ${name} (${aId}): online → reconnecting (`);
      expect(log).toMatch(new RegExp(`switchboard peers: ${name} \\(${aId}\\): reconnecting → offline \\(connection refused.*; \\d+ failed attempts?\\)`));
      expect(log).toMatch(new RegExp(`switchboard peers: ${name} \\(${aId}\\): attempt \\d+ failed \\(connection refused.*\\); next try in \\d+ s`));
      expect(log).toContain(`switchboard peers: ${name} (${aId}): Reconnect now`);
      expect(log).toMatch(new RegExp(`switchboard peers: ${name} \\(${aId}\\): offline → online after \\d+ failed attempts?`));
      expect(log).not.toMatch(/Bearer|outboundToken|token=/);
    } finally {
      hub.stop();
    }
  });

  it('the test hooks exist only with SWITCHBOARD_PEER_TEST_HOOKS=1', async () => {
    const pairedWorld = await pairedNodes(tmp);
    nodes.push(pairedWorld.a, pairedWorld.b);
    expect((await pairedWorld.a.call('POST', '/api/test/peers/drop')).status).toBe(404);
    expect((await pairedWorld.a.call('POST', '/api/test/peers/outage', { ms: 10 })).status).toBe(404);
  });
});
