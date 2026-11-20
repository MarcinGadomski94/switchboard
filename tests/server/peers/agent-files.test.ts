import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentFileRoot } from '../../../src/core/agent-files.ts';
import type { Session, SessionDetail } from '../../../src/core/api.ts';
import { remoteId } from '../../../src/core/peers.ts';
import { TOKEN_FILE } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../../helpers/peers.ts';

/**
 * D180 follow-up 2026-11-20 (developer: "work across computers"): B reads A's agent's side
 * panel Files and turn changes through the peer API, read-only, with A's own checks: the
 * folders, the tree, a file's text and bytes (its serving rules come along), the turn list;
 * a secret-looking file held back until asked; a path outside the agent's folders refused;
 * `POST …/files/open` refused (it would open an app on A).
 */
let tmp: string;
let nodes: PeerNode[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('peers-agent-files');
});
afterEach(async () => {
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

async function rawGet(node: PeerNode, route: string): Promise<Response> {
  const token = (await readFile(path.join(node.dataDir, TOKEN_FILE), 'utf8')).trim();
  return fetch(`${node.baseUrl}${route}`, { headers: { cookie: `sb_token=${token}` } });
}

describe('D180 follow-up · a paired computer’s agent’s files', () => {
  it('B reads A’s agent’s folders, tree, text, bytes and turns; secrets held back; outside paths and Open in its app refused', async () => {
    const { a, b, aId } = await pairedNodes(tmp);
    nodes.push(a, b);
    const repo = a.repo as string;
    await writeFile(path.join(repo, '.env'), 'PLACEHOLDER=not-a-real-value\n');
    const outside = path.join(tmp, 'outside.txt');
    await writeFile(outside, 'not the agent’s\n');
    const created = await a.call('POST', '/api/sessions', { name: 'files-on-a', task: '[fake:write notes.md] Write it.', folder: a.folderId, worktrees: false, ultracode: false });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const local = created.body as Session;
    await waitFor('A’s turn ended', async () => (((await a.call('GET', `/api/sessions/${local.id}`)).body as SessionDetail).status === 'done' ? true : null), 30_000);
    const id = encodeURIComponent(remoteId(aId, local.id));
    const q = (file: string): string => `path=${encodeURIComponent(file)}`;

    const roots = await b.call('GET', `/api/sessions/${id}/files/roots`);
    expect(roots.status, JSON.stringify(roots.body)).toBe(200);
    const root = ((roots.body as { roots: AgentFileRoot[] }).roots[0] as AgentFileRoot).path;
    const dir = await b.call('GET', `/api/sessions/${id}/files/dir?${q(root)}`);
    expect(dir.status, JSON.stringify(dir.body)).toBe(200);
    expect(JSON.stringify(dir.body)).toContain('notes.md');
    const notes = path.join(root, 'notes.md');
    const text = await b.call('GET', `/api/sessions/${id}/files/text?${q(notes)}`);
    expect(text.status, JSON.stringify(text.body)).toBe(200);
    const list = await b.call('GET', `/api/sessions/${id}/files`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(JSON.stringify(list.body)).toContain('notes.md');

    // The bytes and their serving rules (as on A: never a page of this app).
    const raw = await rawGet(b, `/api/sessions/${id}/files/raw?${q(notes)}`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-security-policy')).toContain('sandbox');
    expect(raw.headers.get('x-content-type-options')).toBe('nosniff');
    expect(raw.headers.get('cache-control')).toBe('no-store');
    expect((await raw.text()).length).toBeGreaterThan(0);

    // A secret-looking file: held back as on A, shown when asked again.
    const secret = await b.call('GET', `/api/sessions/${id}/files/text?${q(path.join(root, '.env'))}`);
    expect(secret.status).toBe(409);
    expect((secret.body as { error: string }).error).toBe('secret');
    const secretRaw = await rawGet(b, `/api/sessions/${id}/files/raw?${q(path.join(root, '.env'))}`);
    expect(secretRaw.status).toBe(409);
    await secretRaw.text();
    expect((await b.call('GET', `/api/sessions/${id}/files/text?${q(path.join(root, '.env'))}&confirm=1`)).status).toBe(200);

    // Outside the agent's folders: refused by A.
    const away = await b.call('GET', `/api/sessions/${id}/files/text?${q(outside)}`);
    expect(away.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(away.body)).not.toContain('not the agent');

    // An HTML file as a page: its rules (CSP header) come along through the proxy.
    await writeFile(path.join(root, 'index.html'), '<!doctype html><title>Acme</title><p>Acme page</p>\n');
    const page = await rawGet(b, `/api/sessions/${id}/files/page?${q(path.join(root, 'index.html'))}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('Acme page');

    // Open in its app / Show in folder would act on A: refused.
    const open = await b.call('POST', `/api/sessions/${id}/files/open`, { path: notes, how: 'folder' });
    expect(open.status).toBe(403);

    // A turn's changes.
    const turns = await b.call('GET', `/api/sessions/${id}/turn-changes`);
    expect(turns.status, JSON.stringify(turns.body)).toBe(200);
  }, 120_000);
});
