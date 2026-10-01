import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FullEventAnswer, Session, SessionDetail, SessionEvent } from '../../../src/core/api.ts';
import type { ToolPayload } from '../../../src/core/event-payload.ts';
import { mapPeerAnswer, peerAnswerKind } from '../../../src/core/peer-wire.ts';
import { remoteId } from '../../../src/core/peers.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * Fix · long messages × D48 with two real Switchboard processes: B restores the
 * whole text of a cut event of A's session through the proxy
 * (`/api/sessions/{remote id}/events/{eventId}/full`, allowed in `PEER_API_ALLOW`),
 * read from the transcript on A, its event namespaced like every other.
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-long');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

describe('Fix · long messages · a peer\'s cut events', () => {
  it('the route is part of the peer API; its answer\'s event is namespaced', () => {
    expect(peerApiAllowed('GET', '/api/sessions/s1/events/12/full')).toBe(true);
    expect(peerApiAllowed('POST', '/api/sessions/s1/events/12/full')).toBe(false);
    expect(peerApiAllowed('GET', `/api/sessions/${encodeURIComponent(remoteId('abcdefabcdef', 's1'))}/events/12/full`)).toBe(false);
    expect(peerAnswerKind('GET', '/api/sessions/s1/events/12/full')).toBe('full-event');
    const machine = { id: 'abcdefabcdef', name: 'studio-pc' } as never;
    const event = { id: 12, sessionId: 's1', agentId: null, ts: '', endTs: null, kind: 'text', label: '', payload: { type: 'assistant', text: 'x', messageId: null } } as SessionEvent;
    const mapped = mapPeerAnswer(machine, 'full-event', { event, saved: true }) as FullEventAnswer;
    expect(mapped.event.sessionId).toBe(remoteId('abcdefabcdef', 's1'));
    expect(mapped.saved).toBe(true);
  });

  it('B restores the whole input of a cut tool call of A\'s session through the proxy', async () => {
    const { a, b, aId } = await pairedNodes(tmp);
    nodes.push(a, b);
    const long = 'L'.repeat(6000);
    const created = await a.call('POST', '/api/sessions', {
      name: 'long-on-a',
      task: `Write it. [fake:tool Write {"file_path":"notes.txt","content":"${long}"}]`,
      folder: a.folderId,
      worktrees: false,
      ultracode: false,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = remoteId(aId, (created.body as Session).id);
    const call = await waitFor('B sees A\'s cut tool call', async () => {
      const answer = await b.call('GET', `/api/sessions/${encodeURIComponent(id)}`);
      const detail = answer.body as SessionDetail;
      if (answer.status !== 200 || detail.status !== 'done') return null;
      const events = await b.call('GET', `/api/sessions/${encodeURIComponent(id)}/events`);
      return (events.body as SessionEvent[]).find((event) => (event.payload as ToolPayload).type === 'tool' && (event.payload as ToolPayload).inputTruncated === true) ?? null;
    });
    const answer = await b.call('GET', `/api/sessions/${encodeURIComponent(id)}/events/${call.id}/full`);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const full = answer.body as FullEventAnswer;
    expect(full.event.sessionId).toBe(id);
    expect((full.event.payload as ToolPayload).input['content']).toBe(long);
    expect(full.saved).toBe(false);
  }, 60_000);
});
