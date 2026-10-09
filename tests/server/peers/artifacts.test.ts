import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Artifact, ArtifactDetail, ArtifactListItem, ArtifactSaveResult, Session, SessionDetail } from '../../../src/core/api.ts';
import { remoteId } from '../../../src/core/peers.ts';
import { peerAnswerKind } from '../../../src/core/peer-wire.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D89 × D48 with two real Switchboard processes: B reads A's session's saved
 * artifacts through the proxy (the list, one artifact with its versions, a
 * version's bytes with its serving headers, the sandbox CSP included), saves a
 * message there (Save as artifact) and deletes one; B's Artifacts page lists A's
 * artifacts with A's machine tag and remote session ids.
 */

let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-artifacts');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

describe('D89 · a peer\'s artifacts', () => {
  it('the artifact routes are part of the peer API, answers are namespaced', () => {
    for (const [method, url] of [
      ['GET', '/api/artifacts'],
      ['GET', '/api/sessions/s1/artifacts'],
      ['POST', '/api/sessions/s1/artifacts'],
      ['GET', '/api/sessions/s1/artifacts/a1b2c3d4e5'],
      ['DELETE', '/api/sessions/s1/artifacts/a1b2c3d4e5'],
      ['GET', '/api/sessions/s1/artifacts/a1b2c3d4e5/versions/2/raw?download'],
    ] as const) {
      expect(peerApiAllowed(method, url), `${method} ${url}`).toBe(true);
    }
    expect(peerApiAllowed('PUT', '/api/sessions/s1/artifacts/a1')).toBe(false);
    expect(peerAnswerKind('GET', '/api/sessions/s1/artifacts')).toBe('artifacts');
    expect(peerAnswerKind('POST', '/api/sessions/s1/artifacts')).toBe('artifact-save');
    expect(peerAnswerKind('GET', '/api/sessions/s1/artifacts/a1?version=2')).toBe('artifact');
  });

  it('B reads, saves into and deletes from A\'s session; B\'s Artifacts page lists A\'s with its machine', async () => {
    const { a, b, aId } = await pairedNodes(tmp);
    nodes.push(a, b);
    const created = await a.call('POST', '/api/sessions', { name: 'art-on-a', task: 'Hi.', folder: a.folderId, worktrees: false, ultracode: false });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const localId = (created.body as Session).id;
    const id = remoteId(aId, localId);
    const page = await a.call('POST', `/api/sessions/${localId}/artifacts`, { title: 'Mockup', kind: 'html', content: '<!doctype html><p>hi</p>' });
    expect(page.status).toBe(201);
    const pageId = (page.body as ArtifactSaveResult).artifact.id;

    const list = await waitFor('B lists A\'s session\'s artifacts', async () => {
      const answer = await b.call('GET', `/api/sessions/${encodeURIComponent(id)}/artifacts`);
      return answer.status === 200 && (answer.body as Artifact[]).length === 1 ? (answer.body as Artifact[]) : null;
    });
    expect(list[0]).toMatchObject({ id: pageId, sessionId: id, title: 'Mockup', kind: 'html' });
    const detail = await b.call('GET', `/api/sessions/${encodeURIComponent(id)}/artifacts/${pageId}`);
    expect(detail.body as ArtifactDetail).toMatchObject({ sessionId: id, version: { n: 1, content: '<!doctype html><p>hi</p>' } });
    // The bytes, with the headers that keep the page sandboxed.
    const token = (await readFile(path.join(b.dataDir, 'sb_token'), 'utf8')).trim();
    const raw = await fetch(`${b.baseUrl}/api/sessions/${encodeURIComponent(id)}/artifacts/${pageId}/versions/1/raw`, { headers: { cookie: `sb_token=${token}` } });
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(raw.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts;/);
    expect(await raw.text()).toBe('<!doctype html><p>hi</p>');

    // Save as artifact from B into A's session; the detail on B counts it.
    const saved = await b.call('POST', `/api/sessions/${encodeURIComponent(id)}/artifacts`, { title: 'Notes', kind: 'markdown', content: '# Notes\n' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body as ArtifactSaveResult).toMatchObject({ created: true, artifact: { sessionId: id, createdBy: 'developer' } });
    expect(((await a.call('GET', `/api/sessions/${localId}/artifacts`)).body as Artifact[]).map((x) => x.title)).toEqual(['Notes', 'Mockup']);
    expect(((await b.call('GET', `/api/sessions/${encodeURIComponent(id)}`)).body as SessionDetail).artifacts.map((x) => x.sessionId)).toEqual([id, id]);

    // B's Artifacts page: A's artifacts, tagged with A, their session id remote.
    const everything = await waitFor('B\'s Artifacts page lists A\'s', async () => {
      const answer = await b.call('GET', '/api/artifacts');
      const items = answer.body as ArtifactListItem[];
      return items.length === 2 ? items : null;
    });
    expect(everything.map((x) => [x.title, x.sessionId, x.machine?.id])).toEqual([
      ['Notes', id, aId],
      ['Mockup', id, aId],
    ]);
    expect(everything[0]?.sessionName).toBe('art-on-a');

    // Delete from B.
    expect((await b.call('DELETE', `/api/sessions/${encodeURIComponent(id)}/artifacts/${pageId}`)).status).toBe(204);
    expect(((await a.call('GET', `/api/sessions/${localId}/artifacts`)).body as Artifact[]).map((x) => x.title)).toEqual(['Notes']);
    await waitFor('B\'s page follows the delete', async () => ((await b.call('GET', '/api/artifacts')).body as ArtifactListItem[]).length === 1);
  }, 60_000);
});
