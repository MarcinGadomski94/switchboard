import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UserProfile, UserProfilesView } from '../../../src/core/user-profiles.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { generateToken } from '../../../src/server/token.ts';
import { USER_PROFILE_REPAIRS_SETTING } from '../../../src/server/user-profiles/service.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D179 follow-up (2026-11-23, the Mac Studio report "agents on Eskil's profile disappear at every
 * update"): a profile deleted without a merge used to hand its agents to this computer's Default at
 * start, which can be another person ("Claudiu"). Now: its merge survivor, else the one live profile
 * of the same name, else nowhere (its agents stay, listed under Settings › Profiles to move by hand).
 * A new agent never lands on a deleted profile, and every repair records the agents it moved.
 */

const PORT = 4881;
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
  tmp = await makeTempDir('repair-same-name');
  store = await openTempStore(tmp);
  token = generateToken();
  await start();
});

afterEach(async () => {
  await app.close();
  await store.close();
  await removeTempDir(tmp);
});

function call(method: InjectOptions['method'], url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

describe('D179 follow-up · a removed profile’s agents never go to another person’s Default', () => {
  it('at start they move to the live profile of the same name (the Eskil report), and the move is recorded', async () => {
    // This computer's Default is another person.
    expect((await call('PUT', '/api/user-profiles/default', { name: 'Claudiu' })).statusCode).toBe(200);
    const eskil = (await call('POST', '/api/user-profiles', { name: 'Eskil' })).json() as UserProfile;
    const old = (await call('POST', '/api/user-profiles', { name: 'Eskil (old)' })).json() as UserProfile;
    const agent = (await store.sessions.create({ name: 'eskil-agent', claudeSessionId: randomUUID(), userProfileId: old.id })).id;
    // Deleted without a merge (a duplicate removed, its name the same: names come over the sync), its agent left on it.
    await store.userProfiles.update(old.id, { name: 'Eskil', deletedAt: new Date().toISOString() });
    await app.close();
    await start();
    expect((await store.sessions.get(agent))?.userProfileId).toBe(eskil.id);
    const repairs = (await store.settings.get(USER_PROFILE_REPAIRS_SETTING)) as Array<{ from: string; to: string; sessionIds: string[] }>;
    expect(repairs.at(-1)).toMatchObject({ from: old.id, to: eskil.id, sessionIds: [agent] });
  });

  it('a new agent created for a deleted profile (a phone, a schedule, a paired computer) lands on its live namesake', async () => {
    const eskil = (await call('POST', '/api/user-profiles', { name: 'Eskil' })).json() as UserProfile;
    const old = (await call('POST', '/api/user-profiles', { name: 'Eskil (old)' })).json() as UserProfile;
    await store.userProfiles.update(old.id, { name: 'eskil', deletedAt: new Date().toISOString() });
    await app.close();
    await start();
    const agent = await store.sessions.create({ name: 'late-agent', claudeSessionId: randomUUID(), userProfileId: old.id });
    expect(agent.userProfileId).toBe(eskil.id);
  });

  it('with no namesake it stays where it is, listed to move by hand (never Default)', async () => {
    const bob = (await call('POST', '/api/user-profiles', { name: 'Bob' })).json() as UserProfile;
    const ann = (await call('POST', '/api/user-profiles', { name: 'Ann' })).json() as UserProfile;
    const agent = (await store.sessions.create({ name: 'bob-agent', claudeSessionId: randomUUID(), userProfileId: bob.id })).id;
    await store.userProfiles.update(bob.id, { deletedAt: new Date().toISOString() });
    await app.close();
    await start();
    expect((await store.sessions.get(agent))?.userProfileId).toBe(bob.id);
    const view = (await call('GET', '/api/user-profiles')).json() as UserProfilesView;
    expect(view.orphans).toEqual([{ id: bob.id, name: 'Bob', sessions: 1 }]);
    const moved = await call('POST', `/api/user-profiles/orphans/${bob.id}/move`, { to: ann.id });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await store.sessions.get(agent))?.userProfileId).toBe(ann.id);
    expect(((await call('GET', '/api/user-profiles')).json() as UserProfilesView).orphans).toEqual([]);
  });
});
