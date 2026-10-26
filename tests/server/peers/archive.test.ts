import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryItem, Session, SessionDetail } from '../../../src/core/api.ts';
import { remoteId } from '../../../src/core/peers.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D137 follow-up 2026-10-26 × D48 with two real Switchboard processes: B lists A's archived
 * sessions (`GET /api/sessions?closed=include|only`, History) with A's machine tag and A's own
 * countdown / Kept reason (A's period, not B's), never in the open list; Restore from B goes
 * through the proxy (A reopens it) and the row leaves B's archived list; an Archive on A joins
 * it at once; an unreachable A's archived rows stay listed from the snapshot, tagged.
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-archive');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function archivedOn(node: PeerNode, name: string): Promise<Session> {
  const created = await node.call('POST', '/api/sessions', { name, task: 'Say OK.', folder: node.folderId, worktrees: false, ultracode: false });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = (created.body as Session).id;
  await waitFor(`${name}'s turn done`, async () => ['idle', 'done'].includes(((await node.call('GET', `/api/sessions/${id}`)).body as SessionDetail).status));
  const closed = await node.call('POST', `/api/sessions/${id}/close`, { confirm: true });
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  return closed.body as Session;
}

describe('D137 follow-up · a paired computer\'s archived sessions', () => {
  it('B lists A\'s archived sessions with A\'s countdown and Kept reason; never in the open list; Restore through the proxy; an Archive on A joins at once; offline A stays listed', async () => {
    const { a, b, aId } = await pairedNodes(tmp);
    nodes.push(a, b);
    // A's own period (7 days) differs from B's default (14): the countdown B shows is A's.
    expect((await a.call('PUT', '/api/settings', { 'sessions.archiveDays': 7 })).status).toBe(200);
    const plain = await archivedOn(a, 'old-checkout');
    // A pinned session is kept on A ("Kept: pinned").
    const pinnedCreated = await a.call('POST', '/api/sessions', { name: 'pinned-pricing', task: 'Say OK.', folder: a.folderId, worktrees: false, ultracode: false });
    const pinnedId = (pinnedCreated.body as Session).id;
    await waitFor('pinned turn done', async () => ['idle', 'done'].includes(((await a.call('GET', `/api/sessions/${pinnedId}`)).body as SessionDetail).status));
    expect((await a.call('POST', '/api/sidebar/place', { sessionId: pinnedId, place: 'pinned' })).status).toBe(200);
    expect((await a.call('POST', `/api/sessions/${pinnedId}/close`, { confirm: true })).status).toBe(200);
    const onA = ((await a.call('GET', '/api/sessions?closed=only')).body as Session[]).find((session) => session.id === plain.id);
    expect(onA?.deletesAt).toBeTruthy();

    const plainRemote = remoteId(aId, plain.id);
    const pinnedRemote = remoteId(aId, pinnedId);
    const listed = await waitFor('A\'s archived sessions on B', async () => {
      const all = (await b.call('GET', '/api/sessions?closed=include')).body as Session[];
      const mine = all.filter((session) => session.machine?.id === aId && session.closedAt);
      return mine.length === 2 ? mine : null;
    });
    const plainRow = listed.find((session) => session.id === plainRemote);
    // Computed on A, passed on unchanged.
    expect(plainRow).toMatchObject({ machine: { id: aId, state: 'online' }, deletesAt: onA?.deletesAt, keptReason: null });
    expect(Date.parse(plainRow?.deletesAt ?? '') - Date.parse(plainRow?.closedAt ?? '')).toBeLessThanOrEqual(7 * 86_400_000 + 1000);
    // The Kept reason as A computes it (the list is fetched again after an update; A reuses its kept set for 2 s).
    await waitFor('A\'s Kept reason on B', async () => {
      const row = ((await b.call('GET', '/api/sessions?closed=only')).body as Session[]).find((session) => session.id === pinnedRemote);
      return row?.keptReason === 'pinned' && row.deletesAt === null;
    }, 30_000);
    expect(listed.every((session) => session.agents === undefined)).toBe(true);
    // `?closed=only` too; the open list (the sidebar's) never carries them.
    expect(((await b.call('GET', '/api/sessions?closed=only')).body as Session[]).map((session) => session.id).sort()).toEqual([pinnedRemote, plainRemote].sort());
    expect(((await b.call('GET', '/api/sessions')).body as Session[]).some((session) => session.machine?.id === aId && session.closedAt)).toBe(false);
    // Classic History: the rows, tagged, with A's countdown; the search matches them.
    const history = (await b.call('GET', '/api/history')).body as HistoryItem[];
    expect(history.find((item) => item.sessionId === plainRemote)).toMatchObject({ machine: { id: aId }, deletesAt: onA?.deletesAt, keptReason: null, closedAt: plain.closedAt });
    expect(((await b.call('GET', '/api/history?q=pricing')).body as HistoryItem[]).map((item) => item.sessionId)).toEqual([pinnedRemote]);

    // Restore from B: A reopens it; it leaves B's archived list and shows as open.
    const restored = await b.call('POST', `/api/sessions/${encodeURIComponent(plainRemote)}/reopen`);
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(((await a.call('GET', `/api/sessions/${plain.id}`)).body as SessionDetail).closedAt ?? null).toBeNull();
    await waitFor('restored on B', async () => {
      const all = (await b.call('GET', '/api/sessions?closed=include')).body as Session[];
      const row = all.filter((session) => session.id === plainRemote);
      return row.length === 1 && !row[0]?.closedAt;
    });
    expect(((await b.call('GET', '/api/sessions?closed=only')).body as Session[]).map((session) => session.id)).toEqual([pinnedRemote]);
    // Archived again on A: back in B's list at once (the event), newest first.
    expect((await a.call('POST', `/api/sessions/${plain.id}/close`, { confirm: true })).status).toBe(200);
    await waitFor('archived again on B', async () => ((await b.call('GET', '/api/sessions?closed=only')).body as Session[])[0]?.id === plainRemote);

    // A goes away: its archived rows stay listed (last known), tagged as not online; Restore is refused.
    await a.server.stop();
    nodes = nodes.filter((node) => node !== a);
    const offline = await waitFor('A offline on B', async () => {
      const rows = ((await b.call('GET', '/api/sessions?closed=only')).body as Session[]).filter((session) => session.machine?.id === aId);
      return rows.length === 2 && rows.every((session) => session.machine?.state === 'offline') ? rows : null;
    });
    expect(offline.find((session) => session.id === pinnedRemote)?.keptReason).toBe('pinned');
    expect((await b.call('POST', `/api/sessions/${encodeURIComponent(pinnedRemote)}/reopen`)).status).toBe(502);
  }, 120_000);

  it('each computer lists the other\'s archived sessions newest first and never sends on its peer\'s (no chains; the cap: tests/server/api/sessions-archived.test.ts)', async () => {
    const { a, b, aId, bId } = await pairedNodes(tmp);
    nodes.push(a, b);
    const first = await archivedOn(b, 'first-archived');
    const second = await archivedOn(b, 'second-archived');
    // A's peer read of B (what A's archived list holds): B's own, newest first; B's open sessions and A's never.
    const onA = await waitFor('B\'s archived sessions on A', async () => {
      const rows = ((await a.call('GET', '/api/sessions?closed=only')).body as Session[]).filter((session) => session.machine?.id === bId);
      return rows.length === 2 ? rows : null;
    });
    expect(onA.map((session) => session.id)).toEqual([remoteId(bId, second.id), remoteId(bId, first.id)]);
    expect(((await b.call('GET', '/api/sessions?closed=only')).body as Session[]).some((session) => session.machine?.id === aId)).toBe(false);
  }, 120_000);
});
