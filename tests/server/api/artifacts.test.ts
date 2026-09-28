import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ArtifactListItem } from '../../../src/core/api.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

const PORT = 4876; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

let tmp: string;
let store: Store;
let app: FastifyInstance;
let token: string;
let clock = Date.parse('2026-09-28T10:00:00.000Z');
const ids: Record<string, string> = {};

async function get(url: string): Promise<{ status: number; body: unknown }> {
  const response = await app.inject({ method: 'GET', url, headers: { host: HOST, cookie: `sb_token=${token}` } });
  return { status: response.statusCode, body: response.json() };
}

async function names(url: string): Promise<string[]> {
  const response = await get(url);
  expect(response.status, url).toBe(200);
  return (response.body as ArtifactListItem[]).map((a) => a.name);
}

beforeAll(async () => {
  tmp = await makeTempDir('api-artifacts');
  // A fake clock: every write is one minute after the previous one.
  store = await openTempStore(tmp, { now: () => new Date((clock += 60_000)) });
  token = generateToken();
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
  app = await buildApp({ config, token, store, webRoot: tmp });
  await app.ready();

  const pay = await store.sessions.create({ name: 'pay-flow', claudeSessionId: '00000000-0000-4000-8000-000000000001' });
  const qa = await store.sessions.create({ name: 'qa-pay', claudeSessionId: '00000000-0000-4000-8000-000000000002' });
  const gone = await store.sessions.create({ name: 'gone', claudeSessionId: '00000000-0000-4000-8000-000000000003' });
  ids['pay'] = pay.id;
  ids['qa'] = qa.id;
  const add = async (fields: Parameters<Store['artifacts']['create']>[0]) => (await store.artifacts.create(fields)).id;
  ids['contract'] = await add({ type: 'CONTRACT', name: 'contracts/pay.md', solution: null, sessionId: pay.id, meta: 'locked', path: '/ws/contracts/pay.md' });
  ids['diff'] = await add({ type: 'DIFF', name: 'Pages/Pay · 2 files', solution: 'alpha-front', branch: 'session/pay-flow', sessionId: pay.id, data: { files: ['Pages/Pay/a.razor', 'Pages/Pay/b.razor'] } });
  ids['pr'] = await add({ type: 'PR', name: 'alpha-front #7', solution: 'alpha-front', sessionId: pay.id, meta: 'open', url: 'https://github.com/acme/alpha-front/pull/7' });
  ids['branch'] = await add({ type: 'BRANCH', name: 'feature/pay', solution: 'mobile', branch: 'feature/pay', sessionId: pay.id });
  ids['qaMatrix'] = await add({ type: 'QA', name: 'coverage-matrix.md', solution: null, sessionId: qa.id, meta: '3/5' });
  ids['followup'] = await add({ type: 'FOLLOWUP', name: 'mobile-followups/from-alpha-front.md', solution: 'mobile', sessionId: qa.id });
  ids['doc'] = await add({ type: 'DOC', name: 'notes.md', solution: null, sessionId: gone.id });
  ids['ticket'] = await add({ type: 'TICKET', name: 'Reply draft: Pay copy', solution: null, sessionId: null, meta: 'draft' });
  await store.sessions.delete(gone.id); // ON DELETE SET NULL: the DOC loses its session
  // The DIFF grows later (the recorder upserts it on every write): newest first, same id.
  await store.artifacts.update(ids['diff']!, { name: 'Pages/Pay · 3 files' });
});

afterAll(async () => {
  await app.close();
  await store.close();
  await removeTempDir(tmp);
});

describe('GET /api/artifacts (M7.3)', () => {
  it('lists every artifact, most recently updated first, with the session name and last update', async () => {
    const response = await get('/api/artifacts');
    expect(response.status).toBe(200);
    const items = response.body as ArtifactListItem[];
    expect(items.map((a) => a.name)).toEqual([
      'Pages/Pay · 3 files',
      'Reply draft: Pay copy',
      'notes.md',
      'mobile-followups/from-alpha-front.md',
      'coverage-matrix.md',
      'feature/pay',
      'alpha-front #7',
      'contracts/pay.md',
    ]);
    const diff = items[0]!;
    const stored = await store.artifacts.get(ids['diff']!);
    expect(stored && stored.updatedAt > stored.createdAt).toBe(true);
    expect(diff).toEqual<ArtifactListItem>({
      id: ids['diff']!,
      type: 'DIFF',
      name: 'Pages/Pay · 3 files',
      solution: 'alpha-front',
      branch: 'session/pay-flow',
      sessionId: ids['pay']!,
      meta: null,
      createdAt: stored!.createdAt,
      sessionName: 'pay-flow',
      // D22: the session's display title (no title here: its name).
      sessionTitle: 'pay-flow',
      updatedAt: stored!.updatedAt,
      // D14: the session's folder (these fixture sessions have none).
      folder: null,
      folderPath: null,
    });
    expect(Object.keys(diff).sort()).toEqual(['branch', 'createdAt', 'folder', 'folderPath', 'id', 'meta', 'name', 'sessionId', 'sessionName', 'sessionTitle', 'solution', 'type', 'updatedAt']);
    const bySession = Object.fromEntries(items.map((a) => [a.name, [a.sessionId, a.sessionName]]));
    expect(bySession['coverage-matrix.md']).toEqual([ids['qa'], 'qa-pay']);
    expect(bySession['notes.md']).toEqual([null, null]);
    expect(bySession['Reply draft: Pay copy']).toEqual([null, null]);
  });

  it('type= filters by one type or a comma list (the view sends each pill as a list)', async () => {
    expect(await names('/api/artifacts?type=DIFF')).toEqual(['Pages/Pay · 3 files']);
    expect(await names('/api/artifacts?type=PR,BRANCH')).toEqual(['feature/pay', 'alpha-front #7']);
    expect(await names('/api/artifacts?type=DOC,CONTRACT,QA,FOLLOWUP')).toEqual([
      'notes.md',
      'mobile-followups/from-alpha-front.md',
      'coverage-matrix.md',
      'contracts/pay.md',
    ]);
    expect(await names('/api/artifacts?type=TICKET')).toEqual(['Reply draft: Pay copy']);
    expect(await names('/api/artifacts?type=pr&type=branch')).toEqual(['feature/pay', 'alpha-front #7']);
    expect(await names('/api/artifacts?type=')).toHaveLength(8);
  });

  it('refuses an unknown type with 400', async () => {
    const response = await get('/api/artifacts?type=PR,Diffs');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid', message: 'unknown artifact type: Diffs' });
  });

  it('q= searches type, name, solution · branch, session and status, case-insensitively', async () => {
    expect(await names('/api/artifacts?q=PAY.MD')).toEqual(['contracts/pay.md']);
    expect(await names('/api/artifacts?q=qa-pay')).toEqual(['mobile-followups/from-alpha-front.md', 'coverage-matrix.md']);
    expect(await names(`/api/artifacts?q=${encodeURIComponent('session/pay-flow')}`)).toEqual(['Pages/Pay · 3 files']);
    expect(await names(`/api/artifacts?q=${encodeURIComponent('alpha-front ⎇')}`)).toEqual(['Pages/Pay · 3 files']);
    expect(await names('/api/artifacts?q=locked')).toEqual(['contracts/pay.md']);
    expect(await names('/api/artifacts?q=%20ticket%20')).toEqual(['Reply draft: Pay copy']);
    expect(await names('/api/artifacts?q=root')).toEqual(['Reply draft: Pay copy', 'notes.md', 'coverage-matrix.md', 'contracts/pay.md']);
    expect(await names('/api/artifacts?q=nothing-like-this')).toEqual([]);
    expect(await names('/api/artifacts?q=')).toHaveLength(8);
  });

  it('combines type= and q=', async () => {
    expect(await names('/api/artifacts?type=PR,BRANCH&q=mobile')).toEqual(['feature/pay']);
    expect(await names('/api/artifacts?type=DIFF&q=mobile')).toEqual([]);
  });

  it('answers an empty list when nothing was produced yet', async () => {
    const dir = await makeTempDir('api-artifacts-empty');
    const emptyStore = await openTempStore(dir);
    const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: dir }, platform: 'linux', home: dir, cwd: dir }), port: PORT };
    const emptyApp = await buildApp({ config, token, store: emptyStore, webRoot: dir });
    try {
      const response = await emptyApp.inject({ method: 'GET', url: '/api/artifacts', headers: { host: HOST, cookie: `sb_token=${token}` } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    } finally {
      await emptyApp.close();
      await emptyStore.close();
      await removeTempDir(dir);
    }
  });
});
