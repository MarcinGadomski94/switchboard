import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HubEventName, InboxItem, Session, SessionDetail } from '../../../src/core/api.ts';
import { parseRemoteId, remoteId } from '../../../src/core/peers.ts';
import { readSse } from '../../../src/server/peers/sse.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, machineOn, pairedNodes, startPeerNode, waitFor } from '../../helpers/peers.ts';

/**
 * D48 P2 / P3 with two real Switchboard processes (fake-claude sessions): B sees
 * and drives A's sessions and Inbox items through its own API, with remote ids;
 * B starts a session on A. `docs/peers.md` → *Proxy*.
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-proxy');
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

describe('D48 P2: a peer\'s sessions and Inbox through the local API', () => {
  it('lists, reads and drives a remote session: question card, message, permission, pause / resume, events', async () => {
    const { a, b, aId } = await world();
    const hub = hubOf(b);
    await hub.ready;
    try {
      const local = await startOn(a, 'on-a', '[fake:ask-2q] Ask me two questions.');
      const id = remoteId(aId, local.id);

      // B lists it with its machine; its own list on A stays local-only.
      const listed = await waitFor('B lists the remote session', async () => {
        const sessions = (await b.call('GET', '/api/sessions')).body as Session[];
        return sessions.find((session) => session.id === id) ?? null;
      });
      expect(listed.machine).toEqual({ id: aId, name: expect.any(String), state: 'online' });
      expect(((await a.call('GET', '/api/sessions')).body as Session[]).map((session) => session.id)).toEqual([local.id]);

      // The question batch reaches B's Inbox, namespaced and tagged.
      const item = await waitFor('the remote question batch in B\'s Inbox', async () => {
        const inbox = (await b.call('GET', '/api/inbox')).body as InboxItem[];
        return inbox.find((entry) => entry.kind === 'questions' && entry.sessionId === id) ?? null;
      });
      expect(parseRemoteId(item.id)?.machineId).toBe(aId);
      expect(item.machine?.id).toBe(aId);
      expect(item.questions?.every((question) => question.batchId === item.id && question.sessionId === id)).toBe(true);

      // The detail: events and questions namespaced; question ids raw (the answers name them).
      const detail = (await b.call('GET', `/api/sessions/${encodeURIComponent(id)}`)).body as SessionDetail;
      expect(detail.id).toBe(id);
      expect(detail.machine?.id).toBe(aId);
      expect(detail.events.every((event) => event.sessionId === id)).toBe(true);
      expect(detail.questions.map((question) => question.batchId)).toContain(item.id);

      // B answers the batch: A's batch is answered, both Inboxes empty.
      const answers = (item.questions ?? []).map((question) => ({ questionId: question.id, answerIndex: 0 }));
      const answered = await b.call('POST', `/api/questions/batch/${encodeURIComponent(item.id)}/answers`, { answers });
      expect(answered.status, JSON.stringify(answered.body)).toBe(204);
      await waitFor('A\'s Inbox is empty', async () => ((await a.call('GET', '/api/inbox')).body as InboxItem[]).length === 0);
      await waitFor('B\'s Inbox is empty', async () => ((await b.call('GET', '/api/inbox')).body as InboxItem[]).length === 0);

      // A message from B runs on A; its permission request reaches B's Inbox; Allow once from B.
      const sent = await b.call('POST', `/api/sessions/${encodeURIComponent(id)}/messages`, { text: '[fake:perm-allow] Run the command.' });
      expect(sent.status).toBe(202);
      const permission = await waitFor('the remote permission item', async () => {
        const inbox = (await b.call('GET', '/api/inbox')).body as InboxItem[];
        return inbox.find((entry) => entry.kind === 'permission' && entry.sessionId === id) ?? null;
      });
      const allowed = await b.call('POST', `/api/inbox/${encodeURIComponent(permission.id)}/actions/allow-once`);
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(204);
      await waitFor('A\'s permission decided', async () => ((await a.call('GET', '/api/inbox')).body as InboxItem[]).length === 0);
      await waitFor('the turn ended', async () => ['idle', 'done'].includes(((await b.call('GET', `/api/sessions/${encodeURIComponent(id)}`)).body as SessionDetail).status));

      // Events of the remote session reached B's /hub namespaced.
      await waitFor('namespaced hub events on B', async () => hub.events.some((event) => event.name === 'event' && event.payload.sessionId === id));
      expect(hub.events.filter((event) => event.name === 'event').every((event) => event.payload.sessionId === id)).toBe(true);
      expect(hub.events.some((event) => event.name === 'questionBatch' && event.payload.batchId === item.id), JSON.stringify(hub.events.map((event) => [event.name, event.payload.batchId ?? event.payload.sessionId ?? event.payload.id]))).toBe(true);
      const events = (await b.call('GET', `/api/sessions/${encodeURIComponent(id)}/events`)).body as SessionDetail['events'];
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((event) => event.sessionId === id)).toBe(true);

      // No echo between the two machines (each listens and connects to the other): a quiet second stays quiet.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const before = hub.events.length;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(hub.events.length - before).toBeLessThanOrEqual(1);

      // Pause / resume, model, title go through; the answer is B's view of the session.
      const paused = await b.call('POST', `/api/sessions/${encodeURIComponent(id)}/pause`);
      expect(paused.status).toBe(200);
      expect(paused.body).toMatchObject({ id, status: 'paused', machine: { id: aId } });
      const renamed = await b.call('PUT', `/api/sessions/${encodeURIComponent(id)}/title`, { title: 'Renamed from B' });
      expect(renamed.body).toMatchObject({ id, title: 'Renamed from B' });
      expect(((await a.call('GET', `/api/sessions/${local.id}`)).body as SessionDetail).title).toBe('Renamed from B');

      // Not part of the peer API: the terminal handoff.
      const detach = await b.call('POST', `/api/sessions/${encodeURIComponent(id)}/detach`);
      expect(detach).toMatchObject({ status: 403, body: { error: 'peer-forbidden' } });
      // An unknown machine, an unknown session on a known machine.
      expect((await b.call('GET', `/api/sessions/${encodeURIComponent(remoteId('zzzzzzzzzzzz', local.id))}`)).status).toBe(404);
      expect((await b.call('GET', `/api/sessions/${encodeURIComponent(remoteId(aId, 'nope'))}`)).status).toBe(404);
    } finally {
      hub.stop();
    }
  });

  it('an unreachable peer\'s sessions stay listed as unreachable; its calls answer 502', async () => {
    const { a, b, aId } = await world();
    const local = await startOn(a, 'kept', 'Say OK.');
    const id = remoteId(aId, local.id);
    await waitFor('listed on B', async () => ((await b.call('GET', '/api/sessions')).body as Session[]).some((session) => session.id === id));
    await a.server.stop();
    // Fix · peer reconnects: `reconnecting` within the grace period (3 s for test servers), then `offline`.
    const listed = await waitFor('shown as offline', async () => {
      const sessions = (await b.call('GET', '/api/sessions')).body as Session[];
      const session = sessions.find((entry) => entry.id === id);
      return session && session.machine?.state === 'offline' ? session : null;
    });
    expect(listed.machine?.state).toBe('offline');
    const detail = await b.call('GET', `/api/sessions/${encodeURIComponent(id)}`);
    expect(detail).toMatchObject({ status: 502, body: { error: 'peer-unreachable' } });
  });
});

describe('D48 ruling D48-cache-persist: the last known state survives a restart; nothing can be done until the peer is back', () => {
  it('keeps an unreachable peer\'s sessions listed and readable after this service restarts, refuses every action, and goes live again on reconnection', async () => {
    const started = await world();
    let { a, b } = started;
    const { aId } = started;
    const local = await startOn(a, 'kept-offline', 'Say OK.');
    const id = remoteId(aId, local.id);
    const path_ = `/api/sessions/${encodeURIComponent(id)}`;
    await waitFor('the turn done on A', async () => ['idle', 'done'].includes(((await a.call('GET', `/api/sessions/${local.id}`)).body as SessionDetail).status));
    // B opens it (the detail and the events become the snapshot).
    await waitFor('listed on B', async () => ((await b.call('GET', '/api/sessions')).body as Session[]).some((session) => session.id === id));
    const live = (await b.call('GET', path_)).body as SessionDetail;
    expect(live.events.length).toBeGreaterThan(0);
    expect((await b.call('GET', `${path_}/events`)).status).toBe(200);

    // A goes away, then B restarts: A's session is still listed (offline) and readable.
    await a.server.stop();
    await b.server.stop();
    nodes = nodes.filter((node) => node !== a && node !== b);
    b = await startPeerNode(tmp, 'b', { repo: true });
    nodes.push(b);
    const listed = ((await b.call('GET', '/api/sessions')).body as Session[]).find((session) => session.id === id);
    expect(listed?.machine).toMatchObject({ id: aId, state: expect.not.stringMatching(/^online$/) });
    const offline = await b.call('GET', path_);
    expect(offline.status).toBe(200);
    expect((offline.body as SessionDetail).machine?.state).not.toBe('online');
    expect((offline.body as SessionDetail).events.map((event) => event.id)).toEqual(live.events.map((event) => event.id));
    expect((await b.call('GET', `${path_}/events`)).status).toBe(200);
    // Every action is refused at once, with the reason.
    for (const [method, route, body] of [['POST', '/messages', { text: 'hello' }], ['POST', '/pause', undefined], ['PUT', '/title', { title: 'x' }]] as const) {
      const refused = await b.call(method, `${path_}${route}`, body);
      expect(refused.status, route).toBe(502);
      expect(refused.body).toMatchObject({ error: 'peer-unreachable', message: expect.stringMatching(/ is unreachable — /) });
    }
    expect((await b.call('GET', `${path_}/diff`)).status).toBe(502);

    // A comes back: B reconnects and serves live data again.
    a = await startPeerNode(tmp, 'a', { repo: true });
    nodes.push(a);
    await waitFor('A online again on B', async () => (await machineOn(b, aId))?.state === 'online', 60_000);
    const back = await b.call('GET', path_);
    expect((back.body as SessionDetail).machine?.state).toBe('online');
    expect((await b.call('PUT', `${path_}/title`, { title: 'Back online' })).status).toBe(200);
  });
});

describe('D48 P3: start a session on a peer', () => {
  it('lists the peer\'s folders and models and starts the session there', async () => {
    const { a, b, aId } = await world();
    const folders = await b.call('GET', `/api/machines/${aId}/api/folders`);
    expect(folders.status).toBe(200);
    expect(folders.body.map((folder: { id: string }) => folder.id)).toEqual([a.folderId]);
    expect((await b.call('GET', `/api/machines/${aId}/api/models`)).status).toBe(200);
    // Not on the allow-list: the peer's settings.
    expect((await b.call('GET', `/api/machines/${aId}/api/settings`))).toMatchObject({ status: 403, body: { error: 'peer-forbidden' } });

    // Through the form's own route with `machine`, and through the machine's API.
    const created = await b.call('POST', '/api/sessions', { machine: aId, name: 'from-b', task: 'Say OK.', folder: a.folderId, worktrees: false, ultracode: false });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const session = created.body as Session;
    expect(parseRemoteId(session.id)?.machineId).toBe(aId);
    expect(session.machine?.id).toBe(aId);
    const onA = (await a.call('GET', '/api/sessions')).body as Session[];
    expect(onA.map((entry) => entry.name)).toEqual(['from-b']);
    // `machine` naming this machine (or empty) starts locally.
    const bId = await b.machineId();
    const localStart = await b.call('POST', '/api/sessions', { machine: bId, name: 'here', task: 'Say OK.', folder: b.folderId, worktrees: false, ultracode: false });
    expect(localStart.status).toBe(201);
    expect(parseRemoteId((localStart.body as Session).id)).toBeNull();
    // A peer's validation answers come back as they are.
    const refused = await b.call('POST', '/api/sessions', { machine: aId, name: 'Bad Name', task: 'x', folder: a.folderId, worktrees: false, ultracode: false });
    expect(refused.status).toBe(422);
  });
});
