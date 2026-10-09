import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DRAFTS_PER_SESSION_MAX, DRAFT_VALUE_MAX, type SessionDraft } from '../../../src/core/drafts.ts';
import { peerAnswerKind, peerHubEvent } from '../../../src/core/peer-wire.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { isLocalOnly } from '../../../src/server/devices/local-only.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HubBus, type HubMessage } from '../../../src/server/hub/bus.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D88 oracle (`docs/chat.md` → *Drafts*): the repository, the routes (save, read,
 * clear, an emptied value clears, validation, the 64 KB limit, the per-session cap),
 * the composer's chips kept only while their upload exists, removal with the session,
 * the `draftChanged` hub event, the peer allow-list and event mapping, and the
 * device allow-list.
 */

const PORT = 4900; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;
const MACHINE = { id: 'abcdefghijkl', name: 'studio-pc', state: 'online' as const };

let tmp: string;
let store: Store;
let app: FastifyInstance;
let token: string;
let published: HubMessage[];

beforeEach(async () => {
  tmp = await makeTempDir('api-drafts');
  store = await openTempStore(tmp);
  token = generateToken();
  const bus = new HubBus();
  published = [];
  bus.subscribe((message) => published.push(message));
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
  app = await buildApp({ config, token, store, webRoot: tmp, bus });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await store.close();
  await removeTempDir(tmp);
});

function ui(method: InjectOptions['method'], url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

async function session(name: string): Promise<string> {
  return (await store.sessions.create({ name, claudeSessionId: randomUUID() })).id;
}

function drafted(): Array<{ sessionId: string; field: string; client: string | null }> {
  return published.filter((m) => m.name === 'draftChanged').map((m) => m.payload as { sessionId: string; field: string; client: string | null });
}

describe('the repository (0038)', () => {
  it('puts (last write wins), lists by field, deletes; rows go with their session', async () => {
    const id = await session('repo');
    const other = await session('other');
    await store.drafts.put(id, 'composer', { text: 'one', attachments: [] }, 'local');
    await store.drafts.put(id, 'composer', { text: 'two', attachments: [] }, 'device:x/abc');
    await store.drafts.put(id, 'review:r1', { comment: 'c' }, 'local');
    await store.drafts.put(other, 'composer', { text: 'other', attachments: [] }, 'local');
    expect((await store.drafts.list(id)).map((d) => [d.field, d.value, d.updatedBy])).toEqual([
      ['composer', { text: 'two', attachments: [] }, 'device:x/abc'],
      ['review:r1', { comment: 'c' }, 'local'],
    ]);
    expect(await store.drafts.count(id)).toBe(2);
    expect(await store.drafts.delete(id, 'review:r1')).toBe(true);
    expect(await store.drafts.delete(id, 'review:r1')).toBe(false);
    expect(await store.sessions.delete(id)).toBe(true);
    expect(await store.drafts.list(id)).toEqual([]);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM session_drafts WHERE session_id = ?').get(id)).toEqual({ n: 0 });
    expect(await store.drafts.list(other)).toHaveLength(1);
  });
});

describe('the routes (D88)', () => {
  it('save, read, overwrite, clear; an emptied value clears; each change publishes draftChanged with the page id', async () => {
    const id = await session('routes');
    expect((await ui('GET', `/api/sessions/${id}/drafts`)).json()).toEqual([]);

    const saved = await ui('PUT', `/api/sessions/${id}/drafts/composer`, { value: { text: 'half a thought', attachments: [] }, client: 'page1' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ field: 'composer', value: { text: 'half a thought', attachments: [] }, updatedBy: 'local/page1' });

    await ui('PUT', `/api/sessions/${id}/drafts/todo-add`, { value: { title: 'Fix it', description: '', plan: 'No plan', priority: 'high', estimate: '30m' } });
    await ui('PUT', `/api/sessions/${id}/drafts/question:b1`, { value: { picks: { q1: 1, q2: { text: 'mine', editing: true } } } });
    await ui('PUT', `/api/sessions/${id}/drafts/review:r1`, { value: { comment: 'Please rename it' } });
    await ui('PUT', `/api/sessions/${id}/drafts/todo-edit:t1`, { value: { title: 'Edited', description: 'd', plan: 'p', priority: 'low', estimate: '' } });
    const all = (await ui('GET', `/api/sessions/${id}/drafts`)).json() as SessionDraft[];
    expect(all.map((d) => d.field)).toEqual(['composer', 'question:b1', 'review:r1', 'todo-add', 'todo-edit:t1']);
    expect(all.find((d) => d.field === 'question:b1')?.value).toEqual({ picks: { q1: 1, q2: { text: 'mine', editing: true } } });

    // Overwrite (last write wins), then empty it: cleared (204), gone from the list.
    expect((await ui('PUT', `/api/sessions/${id}/drafts/composer`, { value: { text: 'better', attachments: [] } })).json()).toMatchObject({ value: { text: 'better' }, updatedBy: 'local' });
    expect((await ui('PUT', `/api/sessions/${id}/drafts/composer`, { value: { text: '   ', attachments: [] }, client: 'page2' })).statusCode).toBe(204);
    // The + Add form as it opens (No plan, medium, nothing typed) is empty too.
    expect((await ui('PUT', `/api/sessions/${id}/drafts/todo-add`, { value: { title: '', description: '', plan: 'No plan', priority: 'medium', estimate: '' } })).statusCode).toBe(204);
    expect((await ui('DELETE', `/api/sessions/${id}/drafts/review:r1?client=page3`)).statusCode).toBe(204);
    // Idempotent: nothing there, nothing published.
    expect((await ui('DELETE', `/api/sessions/${id}/drafts/review:r1`)).statusCode).toBe(204);
    expect(((await ui('GET', `/api/sessions/${id}/drafts`)).json() as SessionDraft[]).map((d) => d.field)).toEqual(['question:b1', 'todo-edit:t1']);

    expect(drafted()).toEqual([
      { sessionId: id, field: 'composer', client: 'page1' },
      { sessionId: id, field: 'todo-add', client: null },
      { sessionId: id, field: 'question:b1', client: null },
      { sessionId: id, field: 'review:r1', client: null },
      { sessionId: id, field: 'todo-edit:t1', client: null },
      { sessionId: id, field: 'composer', client: null },
      { sessionId: id, field: 'composer', client: 'page2' },
      { sessionId: id, field: 'todo-add', client: null },
      { sessionId: id, field: 'review:r1', client: 'page3' },
    ]);
  });

  it('refuses: no session 404, a bad field or value 422, over 64 KB 413, past the per-session cap 409', async () => {
    const id = await session('refusals');
    expect((await ui('GET', `/api/sessions/${randomUUID()}/drafts`)).statusCode).toBe(404);
    expect((await ui('PUT', `/api/sessions/${randomUUID()}/drafts/composer`, { value: { text: 'x' } })).statusCode).toBe(404);
    for (const field of ['nope', 'question:', 'review:a~b', 'composer:x']) {
      expect((await ui('PUT', `/api/sessions/${id}/drafts/${encodeURIComponent(field)}`, { value: { text: 'x' } })).statusCode, field).toBe(422);
    }
    expect((await ui('PUT', `/api/sessions/${id}/drafts/composer`, { text: 'no value' })).statusCode).toBe(422);
    expect((await ui('PUT', `/api/sessions/${id}/drafts/composer`, { value: 'a string' })).statusCode).toBe(422);
    expect((await ui('PUT', `/api/sessions/${id}/drafts/question:b1`, { value: { picks: { q1: 'blue' } } })).statusCode).toBe(422);
    expect((await ui('PUT', `/api/sessions/${id}/drafts/composer`, { value: { text: 'x', attachments: [{ id: 'a' }] } })).statusCode).toBe(422);

    // The size limit: the JSON of the value, at most 64 KB (a todo plan near it is fine, the composer's text is capped lower).
    const big = await ui('PUT', `/api/sessions/${id}/drafts/composer`, { value: { text: 'x'.repeat(DRAFT_VALUE_MAX), attachments: [] } });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ error: 'too-large' });
    expect((await ui('PUT', `/api/sessions/${id}/drafts/composer`, { value: { text: 'é'.repeat(40_000), attachments: [] } })).statusCode).toBe(413);
    expect((await ui('PUT', `/api/sessions/${id}/drafts/composer`, { value: { text: 'y'.repeat(50_000), attachments: [] } })).statusCode).toBe(200);

    for (let i = 1; i < DRAFTS_PER_SESSION_MAX; i += 1) await store.drafts.put(id, `review:r${i}`, { comment: 'c' }, 'local');
    const over = await ui('PUT', `/api/sessions/${id}/drafts/review:one-more`, { value: { comment: 'c' } });
    expect(over.statusCode).toBe(409);
    // An existing draft can still be saved.
    expect((await ui('PUT', `/api/sessions/${id}/drafts/review:r1`, { value: { comment: 'd' } })).statusCode).toBe(200);
  });

  it("the composer's chips are answered only while their upload exists in the session (as stored)", async () => {
    const id = await session('chips');
    const other = await session('chips-other');
    await store.attachments.create({ id: 'att-1', sessionId: id, name: 'shot.png', mediaType: 'image/png', kind: 'image', size: 10, file: 'att-1-shot.png', pages: null });
    await store.attachments.create({ id: 'att-3', sessionId: other, name: 'theirs.pdf', mediaType: 'application/pdf', kind: 'pdf', size: 30, file: 'att-3-theirs.pdf', pages: 1 });
    const chips = [
      { id: 'att-1', name: 'renamed.png', size: 1, kind: 'image', mediaType: '' },
      { id: 'att-2', name: 'gone.txt', size: 2, kind: 'file' },
      { id: 'att-3', name: 'theirs.pdf', size: 30, kind: 'pdf', mediaType: 'application/pdf' },
    ];
    expect((await ui('PUT', `/api/sessions/${id}/drafts/composer`, { value: { text: 'see the screenshot', attachments: chips } })).statusCode).toBe(200);
    const [draft] = (await ui('GET', `/api/sessions/${id}/drafts`)).json() as SessionDraft[];
    expect(draft?.value).toEqual({ text: 'see the screenshot', attachments: [{ id: 'att-1', name: 'shot.png', size: 10, kind: 'image', mediaType: 'image/png' }] });
    // Chips only, every upload gone: nothing left to restore.
    await ui('PUT', `/api/sessions/${id}/drafts/composer`, { value: { text: '', attachments: [chips[1]] } });
    expect((await ui('GET', `/api/sessions/${id}/drafts`)).json()).toEqual([]);
  });

  it('deleting the session removes its drafts', async () => {
    const id = await session('gone');
    await ui('PUT', `/api/sessions/${id}/drafts/composer`, { value: { text: 'keep me', attachments: [] } });
    expect(await store.sessions.delete(id)).toBe(true);
    expect(await store.drafts.list(id)).toEqual([]);
    expect((await ui('GET', `/api/sessions/${id}/drafts`)).statusCode).toBe(404);
  });
});

describe('peers and devices (D48, D73)', () => {
  it("a paired machine's UI reaches the drafts through the peer API; draftChanged is forwarded with the remote session id", () => {
    expect(peerApiAllowed('GET', '/api/sessions/s1/drafts')).toBe(true);
    expect(peerApiAllowed('PUT', '/api/sessions/s1/drafts/composer')).toBe(true);
    expect(peerApiAllowed('DELETE', '/api/sessions/s1/drafts/review%3Ar1?client=p')).toBe(true);
    expect(peerApiAllowed('POST', '/api/sessions/s1/drafts/composer')).toBe(false);
    expect(peerApiAllowed('GET', '/api/sessions/r~abcdefghijkl~s1/drafts')).toBe(false);
    expect(peerAnswerKind('GET', '/api/sessions/s1/drafts')).toBe('none');
    expect(peerAnswerKind('PUT', '/api/sessions/s1/drafts/composer')).toBe('none');
    expect(peerHubEvent(MACHINE, 'draftChanged', { sessionId: 's1', field: 'question:b1', client: 'p' })).toEqual({ sessionId: 'r~abcdefghijkl~s1', field: 'question:b1', client: 'p' });
  });

  it('a paired device may read, save and clear drafts', () => {
    expect(isLocalOnly('GET', '/api/sessions/s1/drafts')).toBe(false);
    expect(isLocalOnly('PUT', '/api/sessions/s1/drafts/composer')).toBe(false);
    expect(isLocalOnly('DELETE', '/api/sessions/s1/drafts/composer')).toBe(false);
  });
});
