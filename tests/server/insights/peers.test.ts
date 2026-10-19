import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InsightsRows } from '../../../src/core/insights.ts';
import { utcDay } from '../../../src/core/insights.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { InsightsBackfill } from '../../../src/server/insights/backfill.ts';
import { InsightsService, PEER_COPIES_MAX } from '../../../src/server/insights/service.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D108 ruling (merged machines, `docs/insights.md` → *Merged machines*) with a scripted paired
 * machine: the merged answer adds its rows; `peers=cached` never waits (pending, then filled in);
 * an offline or older machine leaves this machine's numbers and a reason; its rows are cached.
 */
let dir = '';
let store: Store;

beforeEach(async () => {
  dir = await makeTempDir('insights-peers');
  store = await openTempStore(dir);
  const s = await store.sessions.create({ name: 'acme', claudeSessionId: 'c-acme', root: '/work/acme' } as Parameters<Store['sessions']['create']>[0]);
  await store.events.append({ sessionId: s.id, kind: 'ok', label: 'Done', payload: { type: 'result', isError: false, durationMs: 1_000, tokens: 1_000, usage: { input: 0, output: 1_000, cacheWrite: 0, cacheRead: 0 }, model: 'claude-opus-5-5' } });
});

afterEach(async () => {
  await store.close();
  await removeTempDir(dir);
});

const today = utcDay(new Date());
const PEER_ROWS: InsightsRows = {
  turns: [{ day: today, sessionId: 'x1', provider: 'claude', model: 'claude-haiku-4-5', profileId: 'default-claude', folder: '/Users/dev/acme', kind: 'session', turns: 3, errorTurns: 0, tokens: 600, usage: { input: 0, output: 600, cacheWrite: 0, cacheRead: 0, unsplit: 0 }, durationMs: 300, reverts: 0, redos: 0 }],
  todos: [],
  plans: null,
  mergeDecisions: [],
  readings: [],
  accounts: [],
  sessionTitles: { x1: 'Studio work' },
  accountNames: {},
};

type FanOut = { machine: { id: string; name: string; state: 'online' }; body: unknown; reason: string | null };

function scripted(state: 'online' | 'offline', answer: () => Promise<FanOut>) {
  const calls: string[] = [];
  return {
    calls,
    peers: {
      machines: async () => [{ id: 'm2', name: 'Studio', state }] as never,
      fanOutGet: async (path: string) => {
        calls.push(path);
        return [await answer()] as never;
      },
    },
  };
}

function service(peers: ReturnType<typeof scripted>['peers']): InsightsService {
  const backfill = new InsightsBackfill(store);
  return new InsightsService({ store, backfill, accounts: { usageOf: async () => null, identityOf: async () => null }, peers });
}

const QUERY = { period: '7d', from: utcDay(Date.now() - 6 * 86_400_000), to: today, folder: null, cli: null, model: null, account: null } as const;

describe('D108 ruling · merged machines (scripted peer)', () => {
  it('cached never waits: this machine first (pending), then filled in; the rows are cached', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const peer = scripted('online', async () => {
      await gate;
      return { machine: { id: 'm2', name: 'Studio', state: 'online' }, body: PEER_ROWS, reason: null };
    });
    const insights = service(peer.peers);
    const first = await insights.answer(QUERY, { scope: 'all', peers: 'cached' });
    expect(first.time.totals).toMatchObject({ turns: 1, tokens: 1_000 });
    expect(first.machines).toMatchObject({ scope: 'all', pending: [{ id: 'm2', name: 'Studio' }], missing: [] });
    release();
    const filled = await insights.answer(QUERY, { scope: 'all', peers: 'wait' });
    expect(filled.time.totals).toMatchObject({ turns: 4, tokens: 1_600, sessions: 2 });
    expect(filled.machines.included.map((m) => m.name)).toEqual(['This machine', 'Studio']);
    expect(filled.machines.pending).toEqual([]);
    // Same-named folders on two machines carry their machine.
    expect(filled.time.byFolder.map((r) => r.label).sort()).toEqual(['acme · Studio', 'acme · This machine']);
    expect(filled.cost.period.byModel.map((r) => r.key)).toEqual(['claude-opus-5-5', 'claude-haiku-4-5']);
    // Within the TTL the peer is not asked again.
    await insights.answer(QUERY, { scope: 'all', peers: 'wait' });
    expect(peer.calls).toHaveLength(1);
    expect(peer.calls[0]).toBe(`/api/insights/rows?from=${QUERY.from}&to=${QUERY.to}`);
    // This machine alone.
    expect((await insights.answer(QUERY, { scope: 'local' })).time.totals.turns).toBe(1);
  });

  it('an offline machine: this machine only, with the reason', async () => {
    const peer = scripted('offline', async () => {
      throw new Error('not asked');
    });
    const answer = await service(peer.peers).answer(QUERY, { scope: 'all', peers: 'wait' });
    expect(answer.time.totals.turns).toBe(1);
    expect(answer.machines).toMatchObject({ included: [{ id: null }], missing: [{ id: 'm2', name: 'Studio', reason: 'offline' }] });
    expect(peer.calls).toEqual([]);
  });

  it('an older Switchboard (no rows route) or a timeout: missing with its reason', async () => {
    const older = scripted('online', async () => ({ machine: { id: 'm2', name: 'Studio', state: 'online' }, body: null, reason: 'an older Switchboard without search' }));
    expect((await service(older.peers).answer(QUERY, { scope: 'all', peers: 'wait' })).machines.missing).toEqual([{ id: 'm2', name: 'Studio', reason: 'an older Switchboard (no merged Insights)' }]);
    const slow = scripted('online', async () => ({ machine: { id: 'm2', name: 'Studio', state: 'online' }, body: null, reason: 'did not answer in time' }));
    const answer = await service(slow.peers).answer(QUERY, { scope: 'all', peers: 'wait' });
    expect(answer.machines.missing).toEqual([{ id: 'm2', name: 'Studio', reason: 'did not answer in time' }]);
    expect(answer.time.totals.turns).toBe(1);
  });

  it('1.24 perf: keeps the newest PEER_COPIES_MAX copies (machine × period); an older one is asked again', async () => {
    const peer = scripted('online', async () => ({ machine: { id: 'm2', name: 'Studio', state: 'online' }, body: PEER_ROWS, reason: null }));
    const insights = service(peer.peers);
    // One copy per period, as a page left open for days asks for (its `to` moves every day).
    const periods = Array.from({ length: PEER_COPIES_MAX + 1 }, (_, i) => ({ ...QUERY, from: utcDay(Date.now() - (i + 7) * 86_400_000) }));
    for (const query of periods) await insights.answer(query, { scope: 'all', peers: 'wait' });
    expect(peer.calls).toHaveLength(PEER_COPIES_MAX + 1);
    // The newest is still kept (within the TTL: not asked again) ...
    await insights.answer(periods.at(-1) ?? QUERY, { scope: 'all', peers: 'wait' });
    expect(peer.calls).toHaveLength(PEER_COPIES_MAX + 1);
    // ... the oldest was dropped.
    await insights.answer(periods[0] ?? QUERY, { scope: 'all', peers: 'wait' });
    expect(peer.calls).toHaveLength(PEER_COPIES_MAX + 2);
  });
});
