import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import { addFolder, placeSession, type SidebarLayout } from '../../../src/core/sidebar-layout.ts';
import { combineSameNamed } from '../../../src/core/sidebar-records.ts';
import type { UserProfile } from '../../../src/core/user-profiles.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D179 (`docs/profiles.md` → *Layout and profiles (D179)*): a layout never hides a profile's agents
 * and never lets one profile act on another's: a session of Ann's that sits in a folder of
 * Default's (a sync or a combine from before 2.4.50) shows loose for Ann; Default deleting that
 * folder with its agents archived leaves Ann's open; the first merge combines same-named folders
 * of one profile only; data left on a merged-away profile moves to its survivor at start.
 */

const PORT = 4879;
const HOST = `127.0.0.1:${PORT}`;

let tmp: string;
let store: Store;
let app: FastifyInstance;
let token: string;

async function start(): Promise<void> {
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
  app = await buildApp({ config, token, store, webRoot: tmp, bus: new HubBus() });
  await app.ready();
}

beforeEach(async () => {
  tmp = await makeTempDir('layout-profiles');
  store = await openTempStore(tmp);
  token = generateToken();
  await start();
});

afterEach(async () => {
  await app.close();
  await store.close();
  await removeTempDir(tmp);
});

function call(method: InjectOptions['method'], url: string, payload?: unknown, profileCookie?: string) {
  return app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}${profileCookie ? `; ${profileCookie}` : ''}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

async function cookieOf(id: string): Promise<string> {
  const answer = await call('POST', '/api/user-profiles/switch', { id });
  expect(answer.statusCode, answer.body).toBe(200);
  return String(answer.headers['set-cookie']).split(';')[0] as string;
}

describe('D179 · the layout and profiles', () => {
  it('a session in another profile’s folder shows loose for its own profile; that folder’s delete with archiving leaves it open', async () => {
    const ann = (await call('POST', '/api/user-profiles', { name: 'Ann' })).json() as UserProfile;
    const annAgent = (await store.sessions.create({ name: 'ann-agent', claudeSessionId: randomUUID(), userProfileId: ann.id })).id;
    const deeAgent = (await store.sessions.create({ name: 'dee-agent', claudeSessionId: randomUUID() })).id;
    // Default's folder (made in Default's scope), holding Default's agent.
    const made = await call('POST', '/api/sidebar/folders', { name: 'Shared work' });
    expect(made.statusCode, made.body).toBe(201);
    const folderId = ((made.json() as SidebarLayout).folders.find((f) => f.name === 'Shared work') as { id: string }).id;
    expect((await call('POST', '/api/sidebar/place', { sessionId: deeAgent, place: 'folder', folderId })).statusCode).toBe(200);
    // Ann's agent lands in it the way a sync or combine from before D179 put it there (no route lets Default place it).
    await store.sidebar.change((layout) => placeSession(layout, { sessionId: annAgent, place: 'folder', folderId }));
    const annCookie = await cookieOf(ann.id);
    // Ann does not see Default's folder, and her agent is not hidden: it is in her loose list.
    const annLayout = (await call('GET', '/api/sidebar', undefined, annCookie)).json() as SidebarLayout;
    expect(annLayout.folders.map((f) => f.name)).toEqual([]);
    expect(annLayout.loose).toContain(annAgent);
    // Default deletes the folder with its agents archived: its own agent is archived, Ann's is not.
    const deleted = await call('DELETE', `/api/sidebar/folders/${folderId}?archive=1`);
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect((deleted.json() as { archived: Array<{ sessionId: string }> }).archived.map((a) => a.sessionId)).toEqual([deeAgent]);
    expect((await store.sessions.get(annAgent))?.closedAt ?? null).toBeNull();
    const annList = (await call('GET', '/api/sessions', undefined, annCookie)).json() as Session[];
    expect(annList.map((s) => s.id)).toContain(annAgent);
  });

  it('the first merge combines same-named folders of one profile only', () => {
    let layout: SidebarLayout = { pinned: [], folders: [], loose: [] };
    layout = addFolder(layout, 'f-a', 'Projects', null) as SidebarLayout;
    layout = addFolder(layout, 'f-b', 'Projects', null) as SidebarLayout;
    layout = addFolder(layout, 'f-c', 'Projects', null) as SidebarLayout;
    layout = placeSession(layout, { sessionId: 'eskil-chat', place: 'folder', folderId: 'f-b' }) as SidebarLayout;
    const profile: Record<string, string> = { 'f-a': 'marcin', 'f-b': 'eskil', 'f-c': 'marcin' };
    const combined = combineSameNamed(layout, (id) => profile[id] ?? '');
    // Marcin's two "Projects" became one; Eskil's stays his, with his conversation in it.
    expect(combined.folders.map((f) => f.id).sort()).toEqual(['f-a', 'f-b']);
    expect(combined.folders.find((f) => f.id === 'f-b')?.sessionIds).toEqual(['eskil-chat']);
  });

  it('data left on a merged-away profile moves to its survivor at start (and reads as the survivor’s before)', async () => {
    const ann = (await call('POST', '/api/user-profiles', { name: 'Ann' })).json() as UserProfile;
    const old = (await call('POST', '/api/user-profiles', { name: 'Ann (old)' })).json() as UserProfile;
    const gone = (await call('POST', '/api/user-profiles', { name: 'Gone' })).json() as UserProfile;
    const onOld = (await store.sessions.create({ name: 'old-chat', claudeSessionId: randomUUID(), userProfileId: old.id })).id;
    const onGone = (await store.sessions.create({ name: 'gone-chat', claudeSessionId: randomUUID(), userProfileId: gone.id })).id;
    // A merge learned without moving the data (the 2026-11-18 report), and a profile deleted with an agent left on it.
    const at = new Date().toISOString();
    await store.userProfiles.update(old.id, { deletedAt: at, mergedInto: ann.id });
    await store.userProfiles.update(gone.id, { deletedAt: at });
    await app.close();
    await start();
    expect((await store.sessions.get(onOld))?.userProfileId).toBe(ann.id);
    expect((await store.sessions.get(onGone))?.userProfileId).toBe('default');
    const annList = (await call('GET', '/api/sessions?closed=include', undefined, await cookieOf(ann.id))).json() as Session[];
    expect(annList.map((s) => s.id)).toEqual([onOld]);
    const deeList = (await call('GET', '/api/sessions?closed=include')).json() as Session[];
    expect(deeList.map((s) => s.id)).toEqual([onGone]);
  });
});
