import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/server/db/store.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { UserProfileService, USER_PROFILE_PEER_DEFAULTS_SETTING, USER_PROFILE_SELF_WIRE_SETTING, homeDefaultId } from '../../../src/server/user-profiles/service.ts';
import { hashPassword } from '../../../src/server/user-profiles/password.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D172 (`docs/profiles.md` → *Identity across computers*, *Merging profiles*): this computer's Default
 * keeps the local id `default` and travels as its own id (`default-<machine>`); a paired computer's
 * `default` (an older computer) or its Default's id is that computer's Default here, never this one's;
 * a merge is on purpose (both passwords, the picked name / colour / password) and re-keys the data.
 */

const SELF = 'machine-self';
const PEER = 'machine-peer';

let tmp: string;
let store: Store;
let service: UserProfileService;
let synced: unknown[][];

beforeEach(async () => {
  tmp = await makeTempDir('user-profile-identity');
  store = await openTempStore(tmp);
  synced = [];
  service = new UserProfileService({ store, bus: new HubBus(), secret: 'secret', selfId: async () => SELF, synced: (records) => synced.push([...records]) });
  await service.ready();
});

afterEach(async () => {
  await store.close();
  await removeTempDir(tmp);
});

const wireOf = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, color: 'blue', passwordHash: null, clock: `9${id}`, createdAt: '2026-11-01T00:00:00.000Z', deletedAt: null, ...extra });

describe('D172 · identity across computers', () => {
  it('this computer’s Default travels as its own id with homeOf; a renamed Default never overwrites another computer’s', async () => {
    const wire = await service.wire();
    expect(wire.find((record) => record.homeOf === SELF)).toMatchObject({ id: homeDefaultId(SELF), name: 'Default' });
    expect(wire.some((record) => record.id === 'default')).toBe(false);
    // A new paired computer's renamed Default (its own id, homeOf) is a profile of its own here.
    await service.merge([wireOf(homeDefaultId(PEER), 'Claudiu', { homeOf: PEER })], PEER);
    const list = await service.list();
    expect(list.map((profile) => [profile.name, profile.isDefault])).toEqual([['Default', true], ['Claudiu', false]]);
    expect(service.fromRemote(PEER, 'default')).toBe(homeDefaultId(PEER));
    expect(service.fromRemote(PEER, homeDefaultId(SELF))).toBe('default');
  });

  it('an older computer (D165) sending its Default as `default` does not collide: it is that computer’s Default here', async () => {
    await service.merge([wireOf('default', 'Claudiu')], PEER);
    const list = await service.list();
    expect(list.map((profile) => profile.name)).toEqual(['Default', 'Claudiu']);
    expect((await store.userProfiles.get('default'))?.name).toBe('Default');
    expect(await store.settings.get(USER_PROFILE_PEER_DEFAULTS_SETTING)).toEqual({ [PEER]: homeDefaultId(PEER) });
    // Its sessions and requests that say `default` mean its Default, never this computer's.
    expect(service.fromRemote(PEER, 'default')).toBe(homeDefaultId(PEER));
    expect(service.fromRemote(PEER, undefined)).toBe(homeDefaultId(PEER));
    // Its own Default is never sent back to it (it would add it twice).
    expect((await service.wire(PEER)).some((record) => record.id === homeDefaultId(PEER))).toBe(false);
  });

  it('this computer’s own Default echoed back by a peer updates the local Default (one profile, last write wins)', async () => {
    await service.merge([wireOf(homeDefaultId(SELF), 'Marcin', { homeOf: SELF, clock: '99' })], PEER);
    expect((await store.userProfiles.get('default'))?.name).toBe('Marcin');
    expect((await service.list()).map((profile) => profile.name)).toEqual(['Marcin']);
  });

  it('a paired computer’s Default can’t be deleted here (merge it instead)', async () => {
    await service.merge([wireOf(homeDefaultId(PEER), 'Claudiu', { homeOf: PEER })], PEER);
    await expect(service.remove(homeDefaultId(PEER), {})).rejects.toMatchObject({ status: 409, code: 'default' });
  });
});

describe('D172 · merging profiles on purpose', () => {
  async function profile(name: string, password: string | null, createdAt: string): Promise<string> {
    const id = randomUUID();
    await store.userProfiles.put({ id, name, color: 'green', passwordHash: password ? await hashPassword(password) : null, clock: '1', createdAt, updatedAt: createdAt, deletedAt: null, mergedInto: null, admin: false, computers: null, decidedFor: null, github: null });
    return id;
  }

  it('needs both passwords; keeps the picked name, colour and password; the older survives; the data of the other moves', async () => {
    const ann = await profile('Ann', 'ann-secret', '2026-11-01T00:00:00.000Z');
    const bo = await profile('Bo', 'bo-secret', '2026-11-02T00:00:00.000Z');
    // Fresh service so the records above are read.
    service = new UserProfileService({ store, bus: new HubBus(), secret: 'secret', selfId: async () => SELF, synced: (records) => synced.push([...records]) });
    await service.ready();
    const agent = (await store.sessions.create({ name: 'bo-agent', claudeSessionId: randomUUID(), userProfileId: bo })).id;
    await store.settings.set('userProfiles.startProfileId', bo);
    await expect(service.mergeProfiles({ a: ann, b: bo, passwordA: 'ann-secret', passwordB: 'nope', keep: { name: 'b', color: 'a', password: 'b' } })).rejects.toMatchObject({ status: 401 });
    await expect(service.mergeProfiles({ a: ann, b: bo, passwordA: 'nope', passwordB: 'bo-secret', keep: {} })).rejects.toMatchObject({ status: 401 });
    const merged = await service.mergeProfiles({ a: ann, b: bo, passwordA: 'ann-secret', passwordB: 'bo-secret', keep: { name: 'b', color: 'a', password: 'b' } });
    expect(merged.survivor).toMatchObject({ id: ann, name: 'Bo', color: 'green', hasPassword: true });
    expect(merged.mergedAway).toBe(bo);
    // The survivor's password is now Bo's.
    await expect(service.switchTo({ id: ann, password: 'ann-secret' })).rejects.toMatchObject({ status: 401 });
    await expect(service.switchTo({ id: ann, password: 'bo-secret' })).resolves.toBeTruthy();
    // Bo's agent and the start profile moved; Bo is a tombstone naming Ann; its cookie no longer signs a browser in.
    expect((await store.sessions.get(agent))?.userProfileId).toBe(ann);
    expect(service.profileOfSession(agent)).toBe(ann);
    expect(await store.settings.get('userProfiles.startProfileId')).toBe(ann);
    expect(await store.userProfiles.get(bo)).toMatchObject({ mergedInto: ann });
    expect((await service.list()).map((p) => p.name)).toEqual(['Default', 'Bo']);
    // The paired computers get both records (the tombstone names the survivor).
    expect(synced.at(-1)).toEqual(expect.arrayContaining([expect.objectContaining({ id: ann, name: 'Bo' }), expect.objectContaining({ id: bo, mergedInto: ann })]));
  });

  it('this computer’s Default always survives a merge with another profile', async () => {
    const ann = await profile('Ann', null, '2020-01-01T00:00:00.000Z');
    service = new UserProfileService({ store, bus: new HubBus(), secret: 'secret', selfId: async () => SELF });
    await service.ready();
    const merged = await service.mergeProfiles({ a: ann, b: 'default', keep: { name: 'a', color: 'a', password: 'a' } });
    expect(merged.survivor).toMatchObject({ id: 'default', name: 'Ann', isDefault: true });
  });

  it('a paired computer merged this computer’s Default into its own: this Default adopts that id (data and name follow)', async () => {
    const peerDefault = homeDefaultId(PEER);
    await service.merge([wireOf(peerDefault, 'Claudiu', { homeOf: PEER, clock: '5' })], PEER);
    const theirs = (await store.sessions.create({ name: 'moved-in', claudeSessionId: randomUUID(), userProfileId: peerDefault })).id;
    // The peer merged: its Default survives (renamed), this computer's Default is its tombstone.
    await service.merge([wireOf(peerDefault, 'Team', { homeOf: PEER, clock: '7' }), wireOf(homeDefaultId(SELF), 'Default', { deletedAt: '2026-11-17T00:00:00.000Z', mergedInto: peerDefault, clock: '7' })], PEER);
    expect(await store.settings.get(USER_PROFILE_SELF_WIRE_SETTING)).toBe(peerDefault);
    expect((await service.list()).map((p) => [p.id, p.name])).toEqual([['default', 'Team']]);
    expect((await store.sessions.get(theirs))?.userProfileId).toBe('default');
    expect(service.fromRemote(PEER, 'default')).toBe('default');
    expect((await service.wire()).find((record) => record.id === peerDefault)).toMatchObject({ name: 'Team' });
  });
});
