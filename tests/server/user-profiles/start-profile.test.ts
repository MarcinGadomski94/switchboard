import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import { USER_PROFILE_COOKIE_MAX_AGE_S, type UserProfile, type UserProfilesView } from '../../../src/core/user-profiles.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * 2026-11-16 (`docs/profiles.md` → *Staying signed in, and Open in*): a browser stays in its profile
 * across a restart of Switchboard, password or not (a 400-day cookie signed with the install token);
 * a browser that never chose opens in Settings → Profiles → *Open in*, or asks when that one has a
 * password; a new password still signs browsers out.
 */

const PORT = 4878;
const HOST = `127.0.0.1:${PORT}`;

let tmp: string;
let store: Store;
let app: FastifyInstance;
let token: string;
let ann: UserProfile;
let bo: UserProfile;
let ids: { d: string; a: string; b: string };

async function start(): Promise<void> {
  store = await openTempStore(tmp);
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
  app = await buildApp({ config, token, store, webRoot: tmp, bus: new HubBus() });
  await app.ready();
}

async function stop(): Promise<void> {
  await app.close();
  await store.close();
}

beforeEach(async () => {
  tmp = await makeTempDir('start-profile');
  token = generateToken();
  await start();
  ann = (await call('POST', '/api/user-profiles', { name: 'Ann', color: 'green', password: 'ann-secret' })).json() as UserProfile;
  bo = (await call('POST', '/api/user-profiles', { name: 'Bo', color: 'amber' })).json() as UserProfile;
  ids = {
    d: (await store.sessions.create({ name: 'dee', claudeSessionId: randomUUID() })).id,
    a: (await store.sessions.create({ name: 'ann-agent', claudeSessionId: randomUUID(), userProfileId: ann.id })).id,
    b: (await store.sessions.create({ name: 'bo-agent', claudeSessionId: randomUUID(), userProfileId: bo.id })).id,
  };
});

afterEach(async () => {
  await stop();
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

async function listed(cookie?: string): Promise<string[]> {
  return ((await call('GET', '/api/sessions?closed=include', undefined, cookie)).json() as Session[]).map((session) => session.id).sort();
}

describe('staying signed in, and Open in', () => {
  it('the profile cookie is kept 400 days, and a browser stays in its locked profile after Switchboard restarts', async () => {
    const answer = await call('POST', '/api/user-profiles/switch', { id: ann.id, password: 'ann-secret' });
    const set = String(answer.headers['set-cookie']);
    expect(set).toContain(`Max-Age=${USER_PROFILE_COOKIE_MAX_AGE_S}`);
    expect(USER_PROFILE_COOKIE_MAX_AGE_S).toBe(400 * 24 * 3600);
    const cookie = set.split(';')[0] as string;
    await stop();
    await start();
    // The same install token signs it: no password asked again.
    expect(await listed(cookie)).toEqual([ids.a]);
    expect(((await call('GET', '/api/user-profiles', undefined, cookie)).json() as UserProfilesView).activeId).toBe(ann.id);
    // A new password still signs that browser out (it then opens in Default, which has none).
    expect((await call('PUT', `/api/user-profiles/${ann.id}`, { password: 'new-secret', currentPassword: 'ann-secret' }, cookie)).statusCode).toBe(200);
    expect(await listed(cookie)).toEqual([ids.d]);
  });

  it('Open in: a browser that never chose opens in it; with a password it must choose (asks once); a deleted one falls back to Default', async () => {
    expect(((await call('GET', '/api/user-profiles')).json() as UserProfilesView).startId).toBe('default');
    expect((await call('PUT', '/api/user-profiles/start', { id: bo.id })).json()).toEqual({ startId: bo.id });
    expect(((await call('GET', '/api/user-profiles')).json() as UserProfilesView)).toMatchObject({ startId: bo.id, activeId: bo.id });
    expect(await listed()).toEqual([ids.b]);
    // A locked one: no profile until the browser switches (then it stays).
    await call('PUT', '/api/user-profiles/start', { id: ann.id });
    expect(((await call('GET', '/api/user-profiles')).json() as UserProfilesView)).toMatchObject({ startId: ann.id, activeId: null });
    expect(await listed()).toEqual([]);
    // Unknown → 404; the start profile deleted → Default.
    expect((await call('PUT', '/api/user-profiles/start', { id: 'nope' })).statusCode).toBe(404);
    await call('PUT', '/api/user-profiles/start', { id: bo.id });
    expect((await call('DELETE', `/api/user-profiles/${bo.id}`, {})).statusCode).toBe(200);
    expect(((await call('GET', '/api/user-profiles')).json() as UserProfilesView)).toMatchObject({ startId: 'default', activeId: 'default' });
  });
});
