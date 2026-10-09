import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Artifact, ArtifactDetail, ArtifactListItem, ArtifactSaveResult, HubEvents } from '../../../src/core/api.ts';
import { ARTIFACT_TEXT_MAX, ARTIFACT_VERSIONS_MAX } from '../../../src/core/artifacts.ts';
import { AGENT_SESSION_HEADER } from '../../../src/core/todos.ts';
import { HTML_ARTIFACT_CSP, STATIC_ARTIFACT_CSP, filterArtifacts } from '../../../src/server/api/artifacts.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { agentTokenFor } from '../../../src/server/todos/agent-token.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D89 oracle (`docs/artifacts.md`): artifacts saved on purpose. The developer's
 * routes (`/api/sessions/{id}/artifacts…`, `/api/artifacts`) and the agent's
 * (`/agent/v1/artifacts`, the session token): create, versions, the `path` copy
 * (inside the session's folders only, symbolic links resolved), images, limits,
 * the raw route's headers (the HTML sandbox CSP), delete, the global list's filters
 * and the `artifactsChanged` events.
 */

const PORT = 4910; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

let tmp: string;
let work: string;
let store: Store;
let app: FastifyInstance;
let token: string;
let session: string;
let other: string;
const events: Array<HubEvents['artifactsChanged']> = [];
let clock = Date.parse('2026-10-09T10:00:00.000Z');

async function ui(method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) {
  const response = await app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}`, ...(method === 'GET' ? {} : { origin: `http://${HOST}` }) },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
  return { status: response.statusCode, body: response.body ? (response.headers['content-type']?.includes('json') ? response.json() : response.body) : null, headers: response.headers, raw: response.rawPayload };
}

async function agent(method: 'GET' | 'POST', url: string, body?: unknown, as = session) {
  const response = await app.inject({
    method,
    url,
    headers: { host: HOST, authorization: `Bearer ${agentTokenFor(token, as)}`, [AGENT_SESSION_HEADER]: as },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
  return { status: response.statusCode, body: response.body ? response.json() : null };
}

beforeAll(async () => {
  tmp = await makeTempDir('api-artifacts');
  work = path.join(tmp, 'work');
  await mkdir(path.join(work, 'docs'), { recursive: true });
  await writeFile(path.join(work, 'docs', 'report.md'), '# Report\n\nAll green.\n');
  await writeFile(path.join(work, 'shot.png'), PNG);
  await writeFile(path.join(work, 'bin.dat'), Buffer.from([1, 0, 2]));
  await writeFile(path.join(tmp, 'secret.txt'), 'outside');
  await symlink(path.join(tmp, 'secret.txt'), path.join(work, 'link.txt'));
  store = await openTempStore(tmp, { now: () => new Date((clock += 60_000)) });
  token = generateToken();
  const bus = new HubBus();
  bus.subscribe((message) => {
    if (message.name === 'artifactsChanged') events.push(message.payload as HubEvents['artifactsChanged']);
  });
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
  app = await buildApp({ config, token, store, webRoot: tmp, bus });
  await app.ready();
  session = (await store.sessions.create({ name: 'pay-flow', claudeSessionId: '00000000-0000-4000-8000-000000000001', root: work, cwd: work })).id;
  other = (await store.sessions.create({ name: 'qa-pay', title: 'QA of pay', claudeSessionId: '00000000-0000-4000-8000-000000000002' })).id;
});

afterAll(async () => {
  await app?.close();
  await removeTempDir(tmp);
});

describe('D89 · saving', () => {
  let planId = '';

  it('the agent saves a new artifact (artifact_save) and a new version with its id; the developer saves from a message', async () => {
    const created = await agent('POST', '/agent/v1/artifacts', { title: 'Release plan', kind: 'markdown', content: '# Plan\n\n1. Ship\n' });
    expect(created.status).toBe(201);
    const result = created.body as ArtifactSaveResult;
    expect(result).toMatchObject({ version: 1, created: true, artifact: { title: 'Release plan', kind: 'markdown', createdBy: 'agent', versions: 1, sessionId: session, language: null } });
    expect(result.artifact.id).toMatch(/^[a-f0-9]{10}$/);
    planId = result.artifact.id;
    const again = await agent('POST', '/agent/v1/artifacts', { id: `[${planId}]`, title: 'Release plan v2', kind: 'markdown', content: '# Plan\n\n1. Ship\n2. Tell\n' });
    expect(again.body).toMatchObject({ version: 2, created: false, artifact: { id: planId, title: 'Release plan v2', versions: 2 } });
    const mine = await ui('POST', `/api/sessions/${session}/artifacts`, { title: 'Snippet', kind: 'code', language: 'TS', content: 'export const a = 1;\n' });
    expect(mine.status).toBe(201);
    expect(mine.body).toMatchObject({ created: true, artifact: { kind: 'code', language: 'ts', createdBy: 'developer' } });
    expect(events.filter((event) => event.sessionId === session).map((event) => event.change)).toEqual(['saved', 'saved', 'saved']);
  });

  it('lists the session\'s artifacts newest first; the detail has every version and one version\'s text', async () => {
    const list = (await ui('GET', `/api/sessions/${session}/artifacts`)).body as Artifact[];
    expect(list.map((a) => a.title)).toEqual(['Snippet', 'Release plan v2']);
    const latest = (await ui('GET', `/api/sessions/${session}/artifacts/${planId}`)).body as ArtifactDetail;
    expect(latest.versionList.map((v) => [v.n, v.createdBy])).toEqual([[1, 'agent'], [2, 'agent']]);
    expect(latest.version).toMatchObject({ n: 2, content: '# Plan\n\n1. Ship\n2. Tell\n' });
    expect(((await ui('GET', `/api/sessions/${session}/artifacts/${planId}?version=1`)).body as ArtifactDetail).version.content).toBe('# Plan\n\n1. Ship\n');
    expect((await ui('GET', `/api/sessions/${session}/artifacts/${planId}?version=9`)).status).toBe(404);
    // Another session does not see it; the agent of another session cannot name it.
    expect((await ui('GET', `/api/sessions/${other}/artifacts/${planId}`)).status).toBe(404);
    expect((await agent('POST', '/agent/v1/artifacts', { id: planId, title: 'x', kind: 'markdown', content: 'y' }, other)).status).toBe(404);
    // The session detail carries the summaries (the header's count).
    const detail = (await ui('GET', `/api/sessions/${session}`)).body as { artifacts: Artifact[] };
    expect(detail.artifacts).toHaveLength(2);
  });

  it('copies a path from the session\'s working folders (text and image); refuses outside, a link out, binaries and a developer path', async () => {
    const doc = await agent('POST', '/agent/v1/artifacts', { title: 'Report', kind: 'markdown', path: 'docs/report.md' });
    expect(doc.status).toBe(201);
    const docId = (doc.body as ArtifactSaveResult).artifact.id;
    expect(((await ui('GET', `/api/sessions/${session}/artifacts/${docId}`)).body as ArtifactDetail).version.content).toBe('# Report\n\nAll green.\n');
    const image = await agent('POST', '/agent/v1/artifacts', { title: 'Screen', kind: 'image', path: path.join(work, 'shot.png') });
    expect(image.status).toBe(201);
    const imageId = (image.body as ArtifactSaveResult).artifact.id;
    expect(await readdir(path.join(tmp, 'artifacts', imageId))).toEqual(['1.png']);
    const raw = await ui('GET', `/api/sessions/${session}/artifacts/${imageId}/versions/1/raw`);
    expect(raw.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(raw.raw, PNG)).toBe(0);
    for (const [body, words] of [
      [{ title: 'x', kind: 'markdown', path: path.join(tmp, 'secret.txt') }, 'outside the session'],
      [{ title: 'x', kind: 'markdown', path: 'link.txt' }, 'outside the session'],
      [{ title: 'x', kind: 'markdown', path: '../secret.txt' }, 'outside the session'],
      [{ title: 'x', kind: 'markdown', path: 'bin.dat' }, 'not text'],
      [{ title: 'x', kind: 'image', path: 'docs/report.md' }, 'not a png'],
      [{ title: 'x', kind: 'image', content: 'abc' }, 'needs path'],
      [{ title: 'x', kind: 'markdown', path: 'nope.md' }, 'no file'],
      [{ title: 'x', kind: 'markdown', content: 'a', path: 'docs/report.md' }, 'not both'],
    ] as const) {
      const refused = await agent('POST', '/agent/v1/artifacts', body);
      expect(refused.status, JSON.stringify(body)).toBe(422);
      expect(String((refused.body as { message: string }).message), JSON.stringify(body)).toContain(words);
    }
    expect((await ui('POST', `/api/sessions/${session}/artifacts`, { title: 'x', kind: 'markdown', path: 'docs/report.md' })).status).toBe(422);
  });

  it('checks the fields and the limits', async () => {
    for (const body of [
      { kind: 'markdown', content: 'x' },
      { title: 'a\nb', kind: 'markdown', content: 'x' },
      { title: 'x'.repeat(121), kind: 'markdown', content: 'x' },
      { title: 'x', kind: 'pdf', content: 'x' },
      { title: 'x', kind: 'markdown', content: '   ' },
      { title: 'x', kind: 'svg', content: '<div>no svg</div>' },
      { title: 'x', kind: 'code', language: 'not a language!', content: 'x' },
      { title: 'x', kind: 'markdown' },
    ]) {
      expect((await ui('POST', `/api/sessions/${session}/artifacts`, body)).status, JSON.stringify(body)).toBe(422);
    }
    expect((await ui('POST', `/api/sessions/${session}/artifacts`, { title: 'big', kind: 'markdown', content: 'x'.repeat(ARTIFACT_TEXT_MAX + 1) })).status).toBe(413);
    // A new version keeps the kind.
    const csv = (await ui('POST', `/api/sessions/${session}/artifacts`, { title: 'T', kind: 'csv', content: 'a,b\n1,2\n' })).body as ArtifactSaveResult;
    expect((await ui('POST', `/api/sessions/${session}/artifacts`, { id: csv.artifact.id, title: 'T', kind: 'markdown', content: 'x' })).status).toBe(422);
    expect((await ui('POST', '/api/sessions/nope/artifacts', { title: 'x', kind: 'markdown', content: 'x' })).status).toBe(404);
    expect(ARTIFACT_VERSIONS_MAX).toBe(100);
  });

  it('serves a version: html under the sandbox CSP, svg as an image, other text as text/plain; ?download names the file', async () => {
    const html = (await agent('POST', '/agent/v1/artifacts', { title: 'Mock', kind: 'html', content: '<!doctype html><p>hi</p><script>document.cookie</script>' })).body as ArtifactSaveResult;
    const page = await ui('GET', `/api/sessions/${session}/artifacts/${html.artifact.id}/versions/1/raw`);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['content-security-policy']).toBe(HTML_ARTIFACT_CSP);
    expect(HTML_ARTIFACT_CSP).toMatch(/^sandbox allow-scripts;/);
    expect(HTML_ARTIFACT_CSP).not.toContain('allow-same-origin');
    expect(HTML_ARTIFACT_CSP).toContain("default-src 'none'");
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    const svg = (await agent('POST', '/agent/v1/artifacts', { title: 'Logo', kind: 'svg', content: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' })).body as ArtifactSaveResult;
    const image = await ui('GET', `/api/sessions/${session}/artifacts/${svg.artifact.id}/versions/1/raw`);
    expect(image.headers['content-type']).toBe('image/svg+xml');
    expect(image.headers['content-security-policy']).toBe(STATIC_ARTIFACT_CSP);
    const md = (await ui('GET', `/api/sessions/${session}/artifacts`)).body as Artifact[];
    const plan = md.find((a) => a.title === 'Release plan v2')!;
    const text = await ui('GET', `/api/sessions/${session}/artifacts/${plan.id}/versions/2/raw?download`);
    expect(text.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(text.headers['content-disposition']).toContain('attachment; filename="Release plan v2.md"');
    expect((await ui('GET', `/api/sessions/${session}/artifacts/${plan.id}/versions/3/raw`)).status).toBe(404);
  });

  it('D89 ruling: `?render` on a Mermaid version is a sandboxed page with the inlined bundle; other kinds ignore it', async () => {
    await mkdir(path.join(tmp, 'vendor'), { recursive: true });
    await writeFile(path.join(tmp, 'vendor', 'mermaid.min.js'), 'globalThis.mermaid = { stub: "</script>" };');
    const diagram = (await agent('POST', '/agent/v1/artifacts', { title: 'Flow <1>', kind: 'mermaid', content: 'graph TD; A-->B<script>' })).body as ArtifactSaveResult;
    const page = await ui('GET', `/api/sessions/${session}/artifacts/${diagram.artifact.id}/versions/1/raw?render`);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['content-security-policy']).toBe(HTML_ARTIFACT_CSP);
    const html = String(page.body);
    expect(html).toContain('<title>Flow &lt;1&gt;</title>');
    expect(html).toContain('<pre id="src">graph TD; A--&gt;B&lt;script&gt;</pre>');
    expect(html).toContain('globalThis.mermaid = { stub: "<\\/script>" };');
    expect(html).toContain("securityLevel: 'strict'");
    // Download stays the source (.mmd), plain text.
    const source = await ui('GET', `/api/sessions/${session}/artifacts/${diagram.artifact.id}/versions/1/raw?download&render`);
    expect(source.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(source.headers['content-disposition']).toContain('.mmd');
    const md = ((await ui('GET', `/api/sessions/${session}/artifacts`)).body as Artifact[]).find((a) => a.kind === 'markdown')!;
    expect((await ui('GET', `/api/sessions/${session}/artifacts/${md.id}/versions/1/raw?render`)).headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  it('the agent lists and reads; the routes need the session\'s own token', async () => {
    const list = await agent('GET', '/agent/v1/artifacts');
    expect(list.status).toBe(200);
    const plan = (list.body as Artifact[]).find((a) => a.title === 'Release plan v2')!;
    expect(((await agent('GET', `/agent/v1/artifacts/${plan.id}?version=1`)).body as ArtifactDetail).version.content).toBe('# Plan\n\n1. Ship\n');
    const forged = await app.inject({ method: 'GET', url: '/agent/v1/artifacts', headers: { host: HOST, authorization: `Bearer ${agentTokenFor(token, other)}`, [AGENT_SESSION_HEADER]: session } });
    expect(forged.statusCode).toBe(401);
  });
});

describe('D89 · the Artifacts page and delete', () => {
  it('lists every session\'s artifacts with their session; filters by kind, session and text', async () => {
    await ui('POST', `/api/sessions/${other}/artifacts`, { title: 'Coverage', kind: 'csv', content: 'a\n1\n' });
    const all = (await ui('GET', '/api/artifacts')).body as ArtifactListItem[];
    expect(all[0]).toMatchObject({ title: 'Coverage', sessionId: other, sessionName: 'qa-pay', sessionTitle: 'QA of pay' });
    expect(((await ui('GET', '/api/artifacts?kind=csv')).body as ArtifactListItem[]).map((a) => a.title)).toEqual(['Coverage', 'T']);
    expect(((await ui('GET', `/api/artifacts?session=${other}`)).body as ArtifactListItem[]).map((a) => a.title)).toEqual(['Coverage']);
    expect(((await ui('GET', '/api/artifacts?q=qa%20of')).body as ArtifactListItem[]).map((a) => a.title)).toEqual(['Coverage']);
    expect(((await ui('GET', '/api/artifacts?kind=nope')).body as ArtifactListItem[])).toEqual([]);
    expect(filterArtifacts(all, { kind: 'markdown,code' }).map((a) => a.kind).every((kind) => kind === 'markdown' || kind === 'code')).toBe(true);
  });

  it('deletes an artifact with its versions and files', async () => {
    const list = (await ui('GET', `/api/sessions/${session}/artifacts`)).body as Artifact[];
    const image = list.find((a) => a.kind === 'image')!;
    const before = events.length;
    expect((await ui('DELETE', `/api/sessions/${session}/artifacts/${image.id}`)).status).toBe(204);
    expect((await ui('GET', `/api/sessions/${session}/artifacts/${image.id}`)).status).toBe(404);
    expect(await readdir(path.join(tmp, 'artifacts'))).not.toContain(image.id);
    expect(events.slice(before)).toEqual([{ sessionId: session, artifactId: image.id, change: 'deleted' }]);
    expect((await ui('DELETE', `/api/sessions/${session}/artifacts/${image.id}`)).status).toBe(404);
  });

  it('an artifact outlives its session (no session any more)', async () => {
    await store.sessions.delete(other);
    const all = (await ui('GET', '/api/artifacts')).body as ArtifactListItem[];
    expect(all.find((a) => a.title === 'Coverage')).toMatchObject({ sessionId: null, sessionName: null });
  });
});
