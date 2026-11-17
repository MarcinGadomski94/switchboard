import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Folder, FolderBindPreview, Session } from '../../../src/core/api.ts';
import type { UserProfile } from '../../../src/core/user-profiles.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { generateToken } from '../../../src/server/token.ts';
import { INTERNAL_SCOPE_HEADER, INTERNAL_SECRET, USER_PROFILE_HEADER } from '../../../src/server/user-profiles/scope.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D169 (`docs/profiles.md` → *A folder bound to a profile*): a saved folder bound to Ann (with a
 * password) is hidden from Bo and Default: not listed, no agent starts there, no take-over target,
 * not a chat's folder to look at; binding needs Ann's password and moves Bo's agent working there to
 * Ann; unbinding needs it too and shares it again. A paired computer's request in Bo's profile is
 * refused the same way on this computer.
 */

const PORT = 4879;
const HOST = `127.0.0.1:${PORT}`;

let tmp: string;
let store: Store;
let app: FastifyInstance;
let token: string;
let ann: UserProfile;
let bo: UserProfile;
let bound: Folder;
let shared: Folder;
let boAgent: string;
let boElsewhere: string;
let annCookie: string;
let boCookie: string;

beforeEach(async () => {
  tmp = await makeTempDir('folder-binding');
  store = await openTempStore(tmp);
  token = generateToken();
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
  app = await buildApp({ config, token, store, webRoot: tmp, bus: new HubBus() });
  await app.ready();
  ann = (await call('POST', '/api/user-profiles', { name: 'Ann', color: 'green', password: 'ann-secret' })).json() as UserProfile;
  bo = (await call('POST', '/api/user-profiles', { name: 'Bo', color: 'amber' })).json() as UserProfile;
  await mkdir(path.join(tmp, 'clinic', 'api'), { recursive: true });
  await mkdir(path.join(tmp, 'tools'), { recursive: true });
  shared = (await call('POST', '/api/folders', { path: path.join(tmp, 'tools') })).json() as Folder;
  bound = (await call('POST', '/api/folders', { path: path.join(tmp, 'clinic') })).json() as Folder;
  const clinic = await realpath(path.join(tmp, 'clinic'));
  boAgent = (await store.sessions.create({ name: 'bo-in-clinic', claudeSessionId: randomUUID(), userProfileId: bo.id, folderId: bound.id, root: clinic, cwd: path.join(clinic, 'api') })).id;
  boElsewhere = (await store.sessions.create({ name: 'bo-in-tools', claudeSessionId: randomUUID(), userProfileId: bo.id, folderId: shared.id, root: shared.canonicalPath, cwd: shared.canonicalPath })).id;
  annCookie = await cookieOf(ann.id, 'ann-secret');
  boCookie = await cookieOf(bo.id);
});

afterEach(async () => {
  await app.close();
  await store.close();
  await removeTempDir(tmp);
});

function call(method: InjectOptions['method'], url: string, payload?: unknown, profileCookie?: string, headers: Record<string, string> = {}) {
  return app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}${profileCookie ? `; ${profileCookie}` : ''}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

async function cookieOf(id: string, password?: string): Promise<string> {
  const answer = await call('POST', '/api/user-profiles/switch', { id, ...(password ? { password } : {}) });
  expect(answer.statusCode, answer.body).toBe(200);
  return String(answer.headers['set-cookie']).split(';')[0] as string;
}

async function folderIds(cookie?: string): Promise<string[]> {
  return ((await call('GET', '/api/folders', undefined, cookie)).json() as Folder[]).map((folder) => folder.id).sort();
}

async function bind(cookie: string, body: Record<string, unknown>) {
  return call('PUT', `/api/folders/${bound.id}/user-profile`, body, cookie);
}

describe('D169 · a folder bound to a profile', () => {
  it('binding needs the owner’s password; it moves the other profiles’ agents in the folder; then only the owner sees and uses it', async () => {
    expect(await folderIds(boCookie)).toEqual([bound.id, shared.id].sort());
    // The preview lists Bo's agent working in the folder (not the one in another folder).
    const preview = (await call('GET', `/api/folders/${bound.id}/user-profile/preview?to=${ann.id}`, undefined, boCookie)).json() as FolderBindPreview;
    expect(preview.agents.map((agent) => agent.sessionId)).toEqual([boAgent]);
    // Without (or with a wrong) password of Ann: refused, nothing moves.
    expect((await bind(boCookie, { userProfileId: ann.id })).statusCode).toBe(401);
    expect((await bind(boCookie, { userProfileId: ann.id, password: 'nope' })).statusCode).toBe(401);
    expect(((await store.sessions.get(boAgent))?.userProfileId)).toBe(bo.id);
    const answer = await bind(boCookie, { userProfileId: ann.id, password: 'ann-secret' });
    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.json()).toMatchObject({ folderId: bound.id, userProfileId: ann.id, moved: [boAgent] });
    expect((await store.sessions.get(boAgent))?.userProfileId).toBe(ann.id);
    expect((await store.sessions.get(boElsewhere))?.userProfileId).toBe(bo.id);

    // Ann sees it (with its owner); Bo and Default don't.
    const annFolders = (await call('GET', '/api/folders', undefined, annCookie)).json() as Folder[];
    expect(annFolders.find((folder) => folder.id === bound.id)?.userProfileId).toBe(ann.id);
    expect(await folderIds(boCookie)).toEqual([shared.id]);
    expect(await folderIds()).toEqual([shared.id]);
    // The moved agent shows in Ann's list now, not Bo's.
    const listed = async (cookie?: string): Promise<string[]> => ((await call('GET', '/api/sessions?closed=include', undefined, cookie)).json() as Session[]).map((session) => session.id);
    expect(await listed(annCookie)).toContain(boAgent);
    expect(await listed(boCookie)).not.toContain(boAgent);
  });

  it('for the other profiles it is as if it did not exist: every folder route, a new agent there, a scan, a take-over target, a chat’s folders', async () => {
    expect((await bind(annCookie, { userProfileId: ann.id, password: 'ann-secret' })).statusCode).toBe(200);
    for (const [method, url, body] of [
      ['PUT', `/api/folders/${bound.id}/label`, { label: 'Clinic' }],
      ['PUT', `/api/folders/${bound.id}/default`, {}],
      ['DELETE', `/api/folders/${bound.id}`, undefined],
      ['GET', `/api/folders/${bound.id}/user-profile/preview?to=${bo.id}`, undefined],
      ['PUT', `/api/folders/${bound.id}/user-profile`, { userProfileId: bo.id }],
    ] as const) {
      expect((await call(method, url, body, boCookie)).statusCode, `${method} ${url}`).toBe(404);
    }
    // A scan of it, by id or by its path.
    expect((await call('GET', `/api/solutions?folder=${bound.id}`, undefined, boCookie)).statusCode).toBe(404);
    expect((await call('GET', `/api/solutions?folder=${encodeURIComponent(bound.canonicalPath)}`, undefined, boCookie)).statusCode).toBe(404);
    // A new agent there: the folder is unknown (the start's 422 on field folder).
    const start = await call('POST', '/api/sessions', { folder: bound.id, task: 'Fix it', workType: 'feature' }, boCookie);
    expect(start.statusCode).toBe(422);
    expect(start.body).toContain('no saved folder');
    // Saving the same folder again is refused, not a second entry.
    expect((await call('POST', '/api/folders', { path: path.join(tmp, 'clinic') }, boCookie)).statusCode).toBe(422);
    // The take-over target listing (D110): not among the places; listing it (or inside it) is outside.
    const places = (await call('POST', '/api/takeover/folders', {}, boCookie)).json() as { places: Array<{ path: string }> };
    expect(places.places.map((place) => place.path)).not.toContain(bound.canonicalPath);
    expect((await call('POST', '/api/takeover/folders', { path: bound.canonicalPath }, boCookie)).statusCode).toBe(403);
    expect((await call('POST', '/api/takeover/folders', { path: path.join(bound.canonicalPath, 'api') }, boCookie)).statusCode).toBe(403);
    const parent = (await call('POST', '/api/takeover/folders', { path: tmp }, boCookie)).json() as { entries: Array<{ path: string }> };
    expect(parent.entries.map((entry) => path.basename(entry.path))).not.toContain('clinic');
    // A chat may not look at it.
    const chat = await call('POST', '/api/chats', { message: 'Read it', lookAt: [bound.canonicalPath] }, boCookie);
    expect(chat.statusCode).toBe(422);
    expect(chat.body).toContain('not available in this profile');
    // Ann may.
    expect((await call('POST', '/api/takeover/folders', { path: bound.canonicalPath }, annCookie)).statusCode).toBe(200);
    expect((await call('GET', `/api/solutions?folder=${bound.id}`, undefined, annCookie)).statusCode).not.toBe(404);
  });

  it('a paired computer’s request in Bo’s profile is refused on this computer too; in Ann’s it works', async () => {
    expect((await bind(annCookie, { userProfileId: ann.id, password: 'ann-secret' })).statusCode).toBe(200);
    const peer = (profile: string) => ({ [INTERNAL_SCOPE_HEADER]: INTERNAL_SECRET, [USER_PROFILE_HEADER]: profile });
    const asPeer = async (profile: string): Promise<string[]> => ((await call('GET', '/api/folders', undefined, undefined, peer(profile))).json() as Folder[]).map((folder) => folder.id).sort();
    expect(await asPeer(bo.id)).toEqual([shared.id]);
    expect(await asPeer(ann.id)).toEqual([bound.id, shared.id].sort());
    expect((await call('POST', '/api/takeover/folders', { path: bound.canonicalPath }, undefined, peer(bo.id))).statusCode).toBe(403);
  });

  it('unbinding needs the owner’s password and shares it again; a deleted owner’s folders are shared again', async () => {
    expect((await bind(annCookie, { userProfileId: ann.id, password: 'ann-secret' })).statusCode).toBe(200);
    expect((await bind(annCookie, { userProfileId: null })).statusCode).toBe(401);
    expect((await bind(annCookie, { userProfileId: null, password: 'ann-secret' })).json()).toMatchObject({ userProfileId: null });
    expect(await folderIds(boCookie)).toEqual([bound.id, shared.id].sort());
    // Bound to Bo (no password), then Bo is deleted: shared again.
    expect((await bind(boCookie, { userProfileId: bo.id })).statusCode).toBe(200);
    expect(await folderIds(annCookie)).toEqual([shared.id]);
    expect((await call('DELETE', `/api/user-profiles/${bo.id}`, {})).statusCode).toBe(200);
    expect(await folderIds(annCookie)).toEqual([bound.id, shared.id].sort());
  });

  it('a phone may not bind or preview (local only)', async () => {
    const { DEVICE_REFUSED, matchesRule } = await import('../../../src/server/devices/local-only.ts');
    expect(matchesRule(DEVICE_REFUSED, 'PUT', `/api/folders/${bound.id}/user-profile`)).toBe(true);
    expect(matchesRule(DEVICE_REFUSED, 'GET', `/api/folders/${bound.id}/user-profile/preview`)).toBe(true);
  });
});
