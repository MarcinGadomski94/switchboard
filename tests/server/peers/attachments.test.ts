import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Attachment, Session } from '../../../src/core/api.ts';
import { remoteId } from '../../../src/core/peers.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { TOKEN_FILE } from '../../../src/server/token.ts';
import { PNG_1X1, b64 } from '../../helpers/attachments.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D57 × D48: attachments of a peer's session go through the proxy and live on
 * that machine: B uploads to A's session (a file over the peer API's usual 1 MiB
 * body limit), sends it, reads it back (bytes and serving headers intact), and
 * starts a session on A whose first message carries a staged upload made there.
 * Two real Switchboard processes, fake-claude.
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-attachments');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function raw(node: PeerNode, route: string): Promise<Response> {
  const token = (await readFile(path.join(node.dataDir, TOKEN_FILE), 'utf8')).trim();
  return fetch(`${node.baseUrl}${route}`, { headers: { cookie: `sb_token=${token}` } });
}

describe('D57 on a peer\'s session (D48 proxy)', () => {
  it('the attachment routes are on the peer API allow-list', () => {
    expect(peerApiAllowed('POST', '/api/sessions/abc/attachments')).toBe(true);
    expect(peerApiAllowed('GET', '/api/sessions/abc/attachments/def')).toBe(true);
    expect(peerApiAllowed('POST', '/api/attachments')).toBe(true);
    expect(peerApiAllowed('GET', '/api/attachments')).toBe(false);
  });

  it('B uploads to A\'s session, sends it, and reads it back; the file lives in A\'s data folder', async () => {
    const { a, b, aId } = await pairedNodes(tmp);
    nodes.push(a, b);
    const created = await a.call('POST', '/api/sessions', { name: 'att-on-a', task: 'Hello.', folder: a.folderId, worktrees: false, ultracode: false });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const local = created.body as Session;
    const id = remoteId(aId, local.id);

    // 1.5 MiB of text (2 MiB as base64): more than the peer API's usual body limit.
    const text = 'x'.repeat(1.5 * 1024 * 1024);
    const log = await b.call('POST', `/api/sessions/${encodeURIComponent(id)}/attachments`, { name: 'big.log', data: b64(text) });
    expect(log.status, JSON.stringify(log.body)).toBe(201);
    const image = await b.call('POST', `/api/sessions/${encodeURIComponent(id)}/attachments`, { name: 'shot.png', data: PNG_1X1 });
    expect(image.status).toBe(201);
    const logId = (log.body as Attachment).id as string;
    const imageId = (image.body as Attachment).id as string;
    expect((await readdir(path.join(a.dataDir, 'attachments', local.id))).sort()).toEqual([`${imageId}-shot.png`, `${logId}-big.log`].sort());
    expect(await readdir(path.join(b.dataDir, 'attachments')).catch(() => [])).toEqual([]);

    const served = await raw(b, `/api/sessions/${encodeURIComponent(id)}/attachments/${imageId}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(Buffer.from(await served.arrayBuffer())).toEqual(Buffer.from(PNG_1X1, 'base64'));
    const download = await raw(b, `/api/sessions/${encodeURIComponent(id)}/attachments/${logId}`);
    expect(download.headers.get('content-type')).toBe('application/octet-stream');
    expect(download.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect((await download.arrayBuffer()).byteLength).toBe(text.length);
    expect((await raw(b, `/api/sessions/${encodeURIComponent(id)}/attachments/nope`)).status).toBe(404);

    const sent = await b.call('POST', `/api/sessions/${encodeURIComponent(id)}/messages`, { text: 'Look.', attachments: [imageId, logId] });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await waitFor('A\'s agent answers with what it got', async () =>
      ((await a.call('GET', `/api/sessions/${local.id}/events`)).body as Array<{ payload: { text?: string } }>).some((event) => event.payload.text === '[fake: 1 image, 0 documents, 1 file path]'),
    );
  });

  it('a start on A carries an upload staged on A', async () => {
    const { a, b, aId } = await pairedNodes(tmp);
    nodes.push(a, b);
    const staged = await b.call('POST', `/api/machines/${aId}/api/attachments`, { name: 'mock.png', data: PNG_1X1 });
    expect(staged.status, JSON.stringify(staged.body)).toBe(201);
    const imageId = (staged.body as Attachment).id as string;
    const created = await b.call('POST', '/api/sessions', { machine: aId, name: 'start-on-a', task: 'Build this.', folder: a.folderId, worktrees: false, ultracode: false, attachments: [imageId] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const session = created.body as Session;
    const localId = session.id.split('~').at(-1) as string;
    expect(await readdir(path.join(a.dataDir, 'attachments', localId))).toEqual([`${imageId}-mock.png`]);
    await waitFor('A\'s agent saw the image', async () =>
      ((await a.call('GET', `/api/sessions/${localId}/events`)).body as Array<{ payload: { text?: string } }>).some((event) => event.payload.text === '[fake: 1 image, 0 documents]'),
    );
  });
});
