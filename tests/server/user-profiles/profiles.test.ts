import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import type { SidebarLayout } from '../../../src/core/sidebar-layout.ts';
import type { UserProfile, UserProfilesView } from '../../../src/core/user-profiles.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HubBus, type HubMessage } from '../../../src/server/hub/bus.ts';
import { generateToken } from '../../../src/server/token.ts';
import { runInProfileScope } from '../../../src/server/user-profiles/context.ts';
import { hubTransform } from '../../../src/server/user-profiles/scope.ts';
import { UserProfileService } from '../../../src/server/user-profiles/service.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D165 (`docs/profiles.md`): many profiles on one Switchboard, strictly only mine. Three profiles
 * here (Default, Ann with a password, Bo without), each with its own agent: what each browser sees,
 * the password switch (wrong, right, too many tries, a changed password), the guard on an agent of
 * another profile, a folder of one profile, moving an agent, deleting a profile (its agents are
 * archived), a locked Default, a new agent's profile, the hub filter and the peers' merge.
 */

const PORT = 4877;
const HOST = `127.0.0.1:${PORT}`;

let tmp: string;
let store: Store;
let app: FastifyInstance;
let token: string;
let ann: UserProfile;
let bo: UserProfile;
let ids: { d: string; a: string; b: string };

beforeEach(async () => {
  tmp = await makeTempDir('user-profiles');
  store = await openTempStore(tmp);
  token = generateToken();
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
  app = await buildApp({ config, token, store, webRoot: tmp, bus: new HubBus() });
  await app.ready();
  ann = (await call('POST', '/api/user-profiles', { name: 'Ann', color: 'green', password: 'ann-secret' })).json() as UserProfile;
  bo = (await call('POST', '/api/user-profiles', { name: 'Bo', color: 'amber' })).json() as UserProfile;
  ids = {
    d: (await store.sessions.create({ name: 'dee', claudeSessionId: randomUUID() })).id,
    a: (await store.sessions.create({ name: 'ann-agent', claudeSessionId: randomUUID(), userProfileId: ann.id })).id,
    b: (await store.sessions.create({ name: 'bo-agent', claudeSessionId: randomUUID(), userProfileId: bo.id })).id,
  };
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

async function cookieOf(id: string, password?: string): Promise<string> {
  const answer = await call('POST', '/api/user-profiles/switch', { id, ...(password ? { password } : {}) });
  expect(answer.statusCode, answer.body).toBe(200);
  const set = String(answer.headers['set-cookie']);
  expect(set).toMatch(/HttpOnly; SameSite=Strict/);
  return set.split(';')[0] as string;
}

async function listed(cookie?: string): Promise<string[]> {
  return ((await call('GET', '/api/sessions?closed=include', undefined, cookie)).json() as Session[]).map((session) => session.id).sort();
}

describe('D165 · many profiles, strictly only mine', () => {
  it('lists the profiles without any hash; each browser sees only its profile’s agents', async () => {
    const view = (await call('GET', '/api/user-profiles')).json() as UserProfilesView;
    expect(view.profiles.map((p) => [p.name, p.hasPassword, p.isDefault])).toEqual([['Default', false, true], ['Ann', true, false], ['Bo', false, false]]);
    expect(view.activeId).toBe('default');
    expect(JSON.stringify(view)).not.toMatch(/scrypt|ann-secret/);
    // No profile cookie: Default (it has no password).
    expect(await listed()).toEqual([ids.d]);
    expect(await listed(await cookieOf(ann.id, 'ann-secret'))).toEqual([ids.a]);
    expect(await listed(await cookieOf(bo.id))).toEqual([ids.b]);
  });

  it('the password switch: none, wrong, then too many tries; the right one works; a new password signs that browser out', async () => {
    expect((await call('POST', '/api/user-profiles/switch', { id: ann.id })).statusCode).toBe(401);
    for (let i = 0; i < 4; i += 1) expect((await call('POST', '/api/user-profiles/switch', { id: ann.id, password: 'nope' })).statusCode).toBe(401);
    expect((await call('POST', '/api/user-profiles/switch', { id: ann.id, password: 'ann-secret' })).statusCode).toBe(429);
    // A forged cookie (another profile's id, a wrong signature) is no profile: the browser stays in Default.
    expect(await listed(`sb_profile=${ann.id}.-.AAAA`)).toEqual([ids.d]);
    expect((await call('POST', '/api/user-profiles/switch', { id: bo.id })).statusCode).toBe(200);
    const boCookie = await cookieOf(bo.id);
    expect((await call('PUT', `/api/user-profiles/${bo.id}`, { password: 'bo-pass' }, boCookie)).statusCode).toBe(200);
    // The old cookie no longer names Bo.
    expect(await listed(boCookie)).toEqual([ids.d]);
    expect(await listed(await cookieOf(bo.id, 'bo-pass'))).toEqual([ids.b]);
  });

  it('an agent of another profile is not found: its detail, its actions and its todos', async () => {
    const boCookie = await cookieOf(bo.id);
    expect((await call('GET', `/api/sessions/${ids.a}`, undefined, boCookie)).statusCode).toBe(404);
    expect((await call('GET', `/api/sessions/${ids.a}/todos`, undefined, boCookie)).statusCode).toBe(404);
    expect((await call('PUT', `/api/sessions/${ids.a}/title`, { title: 'x' }, boCookie)).statusCode).toBe(404);
    expect((await call('GET', `/api/sessions/${ids.b}`, undefined, boCookie)).statusCode).toBe(200);
    // Placing another profile's agent in the sidebar is refused too.
    expect((await call('POST', '/api/sidebar/place', { sessionId: ids.a, place: 'pinned' }, boCookie)).statusCode).toBe(404);
  });

  it('each profile has its own folders', async () => {
    const boCookie = await cookieOf(bo.id);
    const made = (await call('POST', '/api/sidebar/folders', { name: 'Bo stuff' }, boCookie)).json() as SidebarLayout;
    expect(made.folders.map((f) => f.name)).toEqual(['Bo stuff']);
    expect(((await call('GET', '/api/sidebar')).json() as SidebarLayout).folders).toEqual([]);
    expect(((await call('GET', '/api/sidebar', undefined, await cookieOf(ann.id, 'ann-secret'))).json() as SidebarLayout).folders).toEqual([]);
    expect(((await call('GET', '/api/sidebar', undefined, boCookie)).json() as SidebarLayout).folders.map((f) => f.name)).toEqual(['Bo stuff']);
  });

  it('moves an agent to another profile (its password when it has one)', async () => {
    expect((await call('PUT', `/api/sessions/${ids.d}/user-profile`, { userProfileId: ann.id })).statusCode).toBe(401);
    expect((await call('PUT', `/api/sessions/${ids.d}/user-profile`, { userProfileId: ann.id, password: 'ann-secret' })).json()).toEqual({ sessionId: ids.d, userProfileId: ann.id });
    expect(await listed()).toEqual([]);
    expect(await listed(await cookieOf(ann.id, 'ann-secret'))).toEqual([ids.a, ids.d].sort());
  });

  it('moves a conversation (D106 chat) to another profile the same way (2026-11-17)', async () => {
    const chat = (await store.sessions.create({ name: 'chat-x', claudeSessionId: randomUUID(), kind: 'chat' })).id;
    expect(await listed()).toEqual([ids.d, chat].sort());
    expect((await call('PUT', `/api/sessions/${chat}/user-profile`, { userProfileId: bo.id })).json()).toEqual({ sessionId: chat, userProfileId: bo.id });
    expect(await listed()).toEqual([ids.d]);
    expect(await listed(await cookieOf(bo.id))).toEqual([ids.b, chat].sort());
  });

  it('deleting a profile archives its agents and leaves Default; Default can’t go', async () => {
    expect((await call('DELETE', '/api/user-profiles/default')).statusCode).toBe(409);
    const answer = await call('DELETE', `/api/user-profiles/${bo.id}`);
    expect(answer.json()).toMatchObject({ archived: 1 });
    expect((await store.sessions.get(ids.b))?.closedAt).not.toBeNull();
    expect(((await call('GET', '/api/user-profiles')).json() as UserProfilesView).profiles.map((p) => p.name)).toEqual(['Default', 'Ann']);
    // Ann's needs her password to delete.
    expect((await call('DELETE', `/api/user-profiles/${ann.id}`)).statusCode).toBe(401);
  });

  it('a Default with a password: a browser without a profile sees nothing until it switches', async () => {
    expect((await call('PUT', '/api/user-profiles/default', { password: 'dflt-pass' })).statusCode).toBe(200);
    expect(await listed()).toEqual([]);
    expect(((await call('GET', '/api/user-profiles')).json() as UserProfilesView).activeId).toBeNull();
    expect(await listed(await cookieOf('default', 'dflt-pass'))).toEqual([ids.d]);
  });

  it('a new agent takes the profile its request works in, or its source’s', async () => {
    const made = await runInProfileScope(bo.id, () => store.sessions.create({ name: 'made-in-bo', claudeSessionId: randomUUID() }));
    expect(made.userProfileId).toBe(bo.id);
    const continued = await store.sessions.create({ name: 'continued', claudeSessionId: randomUUID(), continuedFrom: ids.a });
    expect(continued.userProfileId).toBe(ann.id);
    expect((await store.sessions.create({ name: 'outside', claudeSessionId: randomUUID() })).userProfileId).toBe('default');
  });
});

describe('D165 · the hub filter and the peers’ merge', () => {
  it('a hub client in one profile gets only its agents’ events', async () => {
    const service = new UserProfileService({ store, bus: new HubBus(), secret: 'test-secret' });
    const seen = (scope: string, message: HubMessage): boolean => hubTransform(service, scope)(message) !== null;
    const updated = (id: string): HubMessage => ({ name: 'sessionUpdated', payload: { id } as Session }) as HubMessage;
    expect(seen(ann.id, updated(ids.a))).toBe(true);
    expect(seen(ann.id, updated(ids.b))).toBe(false);
    expect(seen(bo.id, { name: 'todosChanged', payload: { sessionId: ids.b, openCount: 1, doneCount: 0 } } as HubMessage)).toBe(true);
    expect(seen('default', { name: 'todosChanged', payload: { sessionId: ids.b, openCount: 1, doneCount: 0 } } as HubMessage)).toBe(false);
    expect(seen('default', { name: 'notice', payload: { url: `/sessions/${ids.a}` } } as unknown as HubMessage)).toBe(false);
    // Not about a session: everyone.
    expect(seen(bo.id, { name: 'system', payload: {} } as HubMessage)).toBe(true);
  });

  it('merges a paired computer’s profiles: the later clock wins; Default is never deleted; a bad hash is dropped', async () => {
    const service = new UserProfileService({ store, bus: new HubBus(), secret: 'test-secret' });
    const wire = await service.wire();
    const annWire = wire.find((p) => p.id === ann.id);
    expect(annWire?.passwordHash).toMatch(/^scrypt\$/);
    await service.merge([
      { ...annWire, name: 'Ann B', clock: `${annWire?.clock}z` },
      { id: 'default', name: 'Default', color: 'blue', passwordHash: null, clock: 'zzzzzzzzz.0000.x', createdAt: '', deletedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'evil', name: 'Evil', color: 'red', passwordHash: 'plain-text', clock: 'zzzzzzzzz.0000.x', createdAt: '', deletedAt: null },
      { id: 'cara', name: 'Cara', color: 'teal', passwordHash: null, clock: 'zzzzzzzzz.0000.x', createdAt: '', deletedAt: null },
    ]);
    expect((await service.list()).map((p) => p.name)).toEqual(['Default', 'Ann B', 'Bo', 'Cara']);
  });
});
