import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SearchAnswer, SearchResult } from '../../../src/core/search.ts';
import type { Store } from '../../../src/server/db/store.ts';
import type { PeerService } from '../../../src/server/peers/service.ts';
import { SearchService, type SearchParams } from '../../../src/server/search/service.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/** D97 (`docs/search.md` → *Paired machines*): the fan-out, merged by score, namespaced, failures listed as not searched. */

let dir = '';
let store: Store;

beforeEach(async () => {
  dir = await makeTempDir('search-fan-out');
  store = await openTempStore(dir);
});

afterEach(async () => {
  await store.close();
  await removeTempDir(dir);
});

const PARAMS: SearchParams = { q: 'zebra', scope: 'all', session: null, machine: 'all', limit: null, cursor: null, fromPeer: false };

function remoteHit(id: string, score: number, sessionId = 's1'): SearchResult {
  return {
    id: `e:${id}`,
    scope: 'conversations',
    kind: 'message',
    title: [{ text: 'Remote work' }],
    snippet: [{ text: 'zebra', match: true }],
    sessionTitle: 'Remote work',
    detail: 'Agent',
    ts: '2026-10-01T10:00:00.000Z',
    score,
    target: { type: 'event', sessionId, eventId: Number(id), agentId: null },
  };
}

type Answer = { readonly status: 'ok'; readonly body: unknown } | { readonly status: 'down'; readonly reason: string };

/** A stand-in for the peer service: two machines, each answering as told; records the paths asked. */
function fakePeers(answers: Record<string, Answer>, asked: string[]): PeerService {
  const machines = [
    { id: 'aaaaaaaaaaaa', name: 'Acme laptop', state: 'online' as const },
    { id: 'bbbbbbbbbbbb', name: 'Acme desktop', state: 'online' as const },
  ];
  return {
    machines: async () => machines,
    fanOutGet: async (path: string, options: { readonly only?: string }) =>
      machines
        .filter((machine) => options.only === undefined || machine.id === options.only)
        .map((machine) => {
          asked.push(`${machine.id} ${path}`);
          const answer = answers[machine.id];
          if (!answer || answer.status === 'down') return { machine, body: null, reason: answer?.reason ?? 'offline' };
          return { machine, body: answer.body, reason: null };
        }),
  } as unknown as PeerService;
}

function body(results: SearchResult[]): unknown {
  return {
    query: 'zebra',
    groups: [
      { scope: 'conversations', count: results.length, results, nextCursor: null },
      { scope: 'artifacts', count: 0, results: [], nextCursor: null },
      { scope: 'todos', count: 0, results: [], nextCursor: null },
    ],
    indexing: { done: true, percent: 100 },
    notSearched: [],
  };
}

describe('D97 · search fans out to the paired machines', () => {
  it('merges the machines\' results by score, namespaced and tagged; a failing machine is listed, the rest still answer', async () => {
    const s = await store.sessions.create({ name: 'local', claudeSessionId: 'c-l', task: '' });
    const local = await store.events.append({ sessionId: s.id, kind: 'text', payload: { type: 'assistant', text: 'a zebra here', messageId: null } });
    const asked: string[] = [];
    const service = new SearchService({ store, peers: fakePeers({ aaaaaaaaaaaa: { status: 'ok', body: body([remoteHit('7', -100), remoteHit('8', 0.5)]) }, bbbbbbbbbbbb: { status: 'down', reason: 'did not answer in time' } }, asked) });
    const answer: SearchAnswer = await service.search(PARAMS);
    const group = answer.groups[0];
    expect(group?.count).toBe(3);
    // m1's -100 ranks first (bm25: lower is better), then the local hit, then m1's 0.5.
    expect(group?.results.map((r) => r.id)).toEqual(['r~aaaaaaaaaaaa~e:7', `e:${local.id}`, 'r~aaaaaaaaaaaa~e:8']);
    expect(group?.results[0]?.machine).toEqual({ id: 'aaaaaaaaaaaa', name: 'Acme laptop', state: 'online' });
    expect(group?.results[0]?.target).toEqual({ type: 'event', sessionId: 'r~aaaaaaaaaaaa~s1', eventId: 7, agentId: null });
    expect(group?.results[1]?.machine).toBeUndefined();
    expect(answer.notSearched).toEqual([{ machine: { id: 'bbbbbbbbbbbb', name: 'Acme desktop', state: 'online' }, reason: 'did not answer in time' }]);
    // Each machine is asked for its own index only (machine=local), never to fan out further.
    expect(asked.every((line) => line.includes('machine=local'))).toBe(true);
  });

  it('a machine that answers something unexpected is not searched; History is not asked of peers; a peer request never fans out', async () => {
    const asked: string[] = [];
    const service = new SearchService({ store, peers: fakePeers({ aaaaaaaaaaaa: { status: 'ok', body: '<html>' }, bbbbbbbbbbbb: { status: 'ok', body: body([]) } }, asked) });
    const answer = await service.search(PARAMS);
    expect(answer.notSearched.map((n) => [n.machine.id, n.reason])).toEqual([['aaaaaaaaaaaa', 'answered something unexpected']]);
    asked.length = 0;
    await service.search({ ...PARAMS, scope: 'history' });
    expect(asked).toEqual([]);
    await service.search({ ...PARAMS, fromPeer: true });
    expect(asked).toEqual([]);
    await service.search({ ...PARAMS, machine: 'local' });
    expect(asked).toEqual([]);
  });

  it('session= a remote session: only its machine is asked (with its own id), this machine is not searched', async () => {
    const s = await store.sessions.create({ name: 'local', claudeSessionId: 'c-l', task: '' });
    await store.events.append({ sessionId: s.id, kind: 'text', payload: { type: 'assistant', text: 'a zebra here', messageId: null } });
    const asked: string[] = [];
    const service = new SearchService({ store, peers: fakePeers({ aaaaaaaaaaaa: { status: 'ok', body: body([remoteHit('7', -1)]) }, bbbbbbbbbbbb: { status: 'ok', body: body([remoteHit('9', -1)]) } }, asked) });
    const answer = await service.search({ ...PARAMS, session: 'r~aaaaaaaaaaaa~s1' });
    expect(answer.groups[0]?.results.map((r) => r.id)).toEqual(['r~aaaaaaaaaaaa~e:7']);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^aaaaaaaaaaaa \/api\/search\?.*session=s1/);
  });
});
