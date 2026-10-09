import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import type { SessionDraft } from '../../../src/core/drafts.ts';
import { remoteId } from '../../../src/core/peers.ts';
import { TOKEN_FILE } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes } from '../../helpers/peers.ts';
import { type HubStream, openHub } from '../../helpers/sse.ts';

/**
 * D88 × D48: the drafts of a paired machine's session live on THAT machine. With two
 * real Switchboard processes, B saves a draft of A's session through the proxy (it is
 * stored on A, B keeps nothing), A's own UI reads it, a change on A reaches B's `/hub`
 * as `draftChanged` with the remote session id, and B clears it on A.
 */

let tmp: string;
let nodes: PeerNode[] = [];
let streams: HubStream[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-drafts');
});
afterEach(async () => {
  for (const stream of streams) stream.close();
  streams = [];
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

describe("D88 on a peer's session (D48 proxy)", () => {
  it('B saves, A reads; A changes, B hears it; B clears it on A', async () => {
    const { a, b, aId } = await pairedNodes(tmp);
    nodes.push(a, b);
    const created = await a.call('POST', '/api/sessions', { name: 'drafts-on-a', task: 'Say hi.', folder: a.folderId, worktrees: false, ultracode: false });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const local = (created.body as Session).id;
    const id = encodeURIComponent(remoteId(aId, local));

    const saved = await b.call('PUT', `/api/sessions/${id}/drafts/composer`, { value: { text: 'typed on B', attachments: [] }, client: 'pageB' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    // Stored on A (by the peer API), nothing on B.
    const onA = (await a.call('GET', `/api/sessions/${local}/drafts`)).body as SessionDraft[];
    expect(onA.map((d) => [d.field, d.value, d.updatedBy])).toEqual([['composer', { text: 'typed on B', attachments: [] }, 'peer/pageB']]);
    expect(((await b.call('GET', `/api/sessions/${id}/drafts`)).body as SessionDraft[]).map((d) => d.value)).toEqual([{ text: 'typed on B', attachments: [] }]);

    const token = (await readFile(path.join(b.dataDir, TOKEN_FILE), 'utf8')).trim();
    const hub = await openHub({ port: b.server.port, cookie: `sb_token=${token}`, headers: { host: `127.0.0.1:${b.server.port}` } });
    streams.push(hub);
    expect(hub.status).toBe(200);
    expect((await a.call('PUT', `/api/sessions/${local}/drafts/review:r1`, { value: { comment: 'from A' }, client: 'pageA' })).status).toBe(200);
    const event = await hub.waitFor(
      () => hub.payloads<{ sessionId: string; field: string; client: string | null }>('draftChanged').find((p) => p.field === 'review:r1'),
      'draftChanged from A',
      15_000,
    );
    expect(event).toEqual({ sessionId: remoteId(aId, local), field: 'review:r1', client: 'pageA' });

    expect((await b.call('DELETE', `/api/sessions/${id}/drafts/composer?client=pageB`)).status).toBe(204);
    expect(((await a.call('GET', `/api/sessions/${local}/drafts`)).body as SessionDraft[]).map((d) => d.field)).toEqual(['review:r1']);
    // An emptied value through the proxy clears too (204 passed on).
    expect((await b.call('PUT', `/api/sessions/${id}/drafts/review%3Ar1`, { value: { comment: '' } })).status).toBe(204);
    expect((await a.call('GET', `/api/sessions/${local}/drafts`)).body).toEqual([]);
  });
});
