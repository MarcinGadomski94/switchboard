import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session, SessionEvent } from '../../../src/core/api.ts';
import { remoteId } from '../../../src/core/peers.ts';
import type { SearchAnswer } from '../../../src/core/search.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D97 × D48 with two real Switchboard processes: B's search finds A's session's
 * message through the peer API (namespaced, tagged with A), opens it with
 * `around=` through the proxy, and still answers (A listed as not searched) when A
 * is gone.
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-search');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

describe('D97 · search across paired machines', () => {
  it('B finds A\'s message tagged with A, opens it around the event, and degrades when A stops', async () => {
    const { a, b, aId } = await pairedNodes(tmp);
    nodes.push(a, b);
    const created = await a.call('POST', '/api/sessions', { name: 'search-on-a', task: 'Find the quokka in the ledger.', folder: a.folderId, worktrees: false, ultracode: false });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const localId = (created.body as Session).id;

    const answer = await waitFor('B finds A\'s message', async () => {
      const found = await b.call('GET', '/api/search?q=quokka');
      const body = found.body as SearchAnswer;
      return found.status === 200 && (body.groups[0]?.results.length ?? 0) > 0 ? body : null;
    });
    const hit = answer.groups[0]?.results[0];
    expect(hit?.machine?.id).toBe(aId);
    expect(hit?.id.startsWith(`r~${aId}~e:`)).toBe(true);
    expect(hit?.target).toMatchObject({ type: 'event', sessionId: remoteId(aId, localId) });
    expect(answer.notSearched).toEqual([]);

    // The deep link: B reads A's events around the hit through the proxy.
    const target = hit?.target;
    if (target?.type !== 'event') throw new Error('expected an event target');
    const page = await b.call('GET', `/api/sessions/${encodeURIComponent(target.sessionId)}/events?around=${target.eventId}&limit=5`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect((page.body as SessionEvent[]).some((event) => event.id === target.eventId)).toBe(true);

    // A's own search does not ask B for A's results back (the peer request answers its own index only).
    const onA = (await a.call('GET', '/api/search?q=quokka')).body as SearchAnswer;
    expect(onA.groups[0]?.results.every((result) => result.machine === undefined)).toBe(true);

    await a.server.stop();
    nodes = [b];
    const degraded = await waitFor('B lists A as not searched', async () => {
      const found = await b.call('GET', '/api/search?q=quokka');
      const body = found.body as SearchAnswer;
      return found.status === 200 && body.notSearched.length === 1 ? body : null;
    }, 30_000);
    expect(degraded.notSearched[0]?.machine.id).toBe(aId);
    expect(degraded.groups[0]?.results).toEqual([]);
  }, 90_000);
});
