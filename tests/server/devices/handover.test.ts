import { afterEach, describe, expect, it } from 'vitest';
import { HANDOVER_TTL_MS, type SharedDevice } from '../../../src/core/devices-sync.ts';
import { hashDeviceSecret, newDeviceSecret } from '../../../src/server/devices/credentials.ts';
import { type DeviceWorld, deviceCookieOf, startDeviceWorld } from '../../helpers/devices.ts';

/**
 * D189 (docs/devices.md → One pairing for all your computers): the target computer's side of a
 * handover, in one process with a controllable clock. A paired computer offers a phone with a
 * token's hash; the phone redeems the token once, before it expires, and only while it is still
 * paired; then this computer gives it its own credential.
 */

let world: DeviceWorld | null = null;
let clock = Date.parse('2026-11-24T10:00:00.000Z');

afterEach(async () => {
  await world?.close();
  world = null;
});

const OTHER = 'bbbbbbbbbbbb';

function phone(over: Partial<SharedDevice> = {}): SharedDevice {
  return { id: 'phonephone22', name: 'Phone', userAgent: null, tailscaleLogin: null, userProfileId: 'default', pairedAt: '2026-11-24T09:00:00.000Z', pairedOn: OTHER, clock: '00000000a.0000.other', ...over };
}

async function offer(w: DeviceWorld, device: SharedDevice = phone(), from = OTHER): Promise<{ token: string; status: number; body: any }> {
  const token = newDeviceSecret();
  const answer = await w.devices.acceptOffer(from, { device, tokenHash: hashDeviceSecret(token), ttlMs: HANDOVER_TTL_MS });
  return { token, status: answer.status, body: answer.body };
}

function redeem(w: DeviceWorld, token: string, headers: Record<string, string> = {}) {
  return w.device('POST', '/device/v1/handover', { body: { token }, headers: { origin: w.origin, ...headers } });
}

describe('D189 handover · the target computer', () => {
  it('a token works once, gives the phone its own credential here, and a replay is refused', async () => {
    world = await startDeviceWorld({ now: () => clock });
    const w = world;
    const offered = await offer(w);
    expect(offered).toMatchObject({ status: 200, body: { origin: w.origin } });
    // The record came with the offer, without a credential of this computer.
    expect((await w.store.devices.get('phonephone22'))?.setUpHere).toBe(false);
    const page = await w.device('GET', '/handover');
    expect(page.status).toBe(200);
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    const first = await redeem(w, offered.token);
    expect(first.status).toBe(200);
    const cookie = deviceCookieOf(first) as string;
    expect(cookie).toMatch(/^__Host-sb_device=phonephone22\./);
    expect((await w.device('GET', '/api/device', { cookie })).status).toBe(200);
    expect((await w.store.devices.get('phonephone22'))?.setUpHere).toBe(true);
    // The cookie carries a secret this computer made, never the token.
    expect(cookie).not.toContain(offered.token);
    expect((await redeem(w, offered.token)).body.error).toBe('expired');
    expect(w.devices.pendingOffers()).toBe(0);
  });

  it('expires; a malformed or unknown token is refused; a revoked phone is refused at the offer and at the redeem', async () => {
    world = await startDeviceWorld({ now: () => clock });
    const w = world;
    const late = await offer(w);
    clock += HANDOVER_TTL_MS + 1;
    expect((await redeem(w, late.token)).body.error).toBe('expired');
    expect((await redeem(w, 'short')).status).toBe(400);
    expect((await redeem(w, newDeviceSecret())).status).toBe(400);
    // A sender's long wait is capped at the TTL from this computer's now.
    const token = newDeviceSecret();
    await w.devices.acceptOffer(OTHER, { device: phone(), tokenHash: hashDeviceSecret(token), ttlMs: 24 * 3_600_000 });
    clock += HANDOVER_TTL_MS + 1;
    expect((await redeem(w, token)).body.error).toBe('expired');
    // Revoked after the offer: its waiting offers go with it, the redeem is refused.
    const pending = await offer(w);
    expect(w.devices.pendingOffers()).toBe(1);
    expect((await w.ui('DELETE', '/api/devices/phonephone22')).status).toBe(204);
    expect(w.devices.pendingOffers()).toBe(0);
    const refused = await redeem(w, pending.token);
    expect(refused.status).toBe(400);
    expect(deviceCookieOf(refused)).toBeNull();
    // Revoked here: a later offer is refused (a revoke always wins).
    expect((await offer(w)).body.error).toBe('revoked');
    expect((await w.devices.acceptOffer(OTHER, { device: phone(), tokenHash: 'x', ttlMs: 'later' })).status).toBe(422);
  });

  it('a phone recorded with a Tailscale login must come with that login', async () => {
    world = await startDeviceWorld({ now: () => clock });
    const w = world;
    const offered = await offer(w, phone({ tailscaleLogin: 'dev@example.com' }));
    expect((await redeem(w, offered.token, { 'tailscale-user-login': 'other@example.com' })).body.error).toBe('other-login');
    const again = await offer(w, phone({ tailscaleLogin: 'dev@example.com' }));
    expect((await redeem(w, again.token, { 'tailscale-user-login': 'dev@example.com' })).status).toBe(200);
  });

  it('review · only the phone’s own computer (or one it is signed in on) may offer it', async () => {
    world = await startDeviceWorld({ now: () => clock });
    const w = world;
    const stranger = 'cccccccccccc';
    expect((await offer(w, phone(), stranger)).body.error).toBe('not-allowed');
    // Known here as paired on OTHER: a stranger's record naming itself does not change who may offer it.
    expect((await offer(w)).status).toBe(200);
    expect((await offer(w, phone({ pairedOn: stranger, clock: '00000000z.0000.other' }), stranger)).body.error).toBe('not-allowed');
    expect((await w.store.devices.get('phonephone22'))?.pairedOn).toBe(OTHER);
    // A computer that says it has the phone signed in may (the phone switches on from there).
    await w.devices.mergeShared(stranger, { v: 1, origin: null, devices: [], tombstones: [], setUp: ['phonephone22'] });
    expect((await offer(w, phone(), stranger)).status).toBe(200);
  });

  it('review · a handover never replaces the credential of a phone signed in here', async () => {
    world = await startDeviceWorld({ now: () => clock });
    const w = world;
    const local = await w.pair('Local phone');
    const before = (await w.store.devices.get(local.id))?.credentialHash;
    const record = await w.store.devices.get(local.id);
    const offered = await offer(w, phone({ id: local.id, pairedOn: OTHER, clock: '00000000z.0000.other' }));
    expect(offered.body.error).toBe('already-set-up');
    expect(w.devices.pendingOffers()).toBe(0);
    expect((await w.store.devices.get(local.id))?.credentialHash).toBe(before);
    expect((await w.store.devices.get(local.id))?.tailscaleLogin).toBe(record?.tailscaleLogin);
    expect((await w.device('GET', '/api/device', { cookie: local.cookie })).status).toBe(200);
  });

  it('review · a peer record never drops the recorded Tailscale login, nor gives a pattern or unknown profile', async () => {
    world = await startDeviceWorld({ now: () => clock });
    const w = world;
    const first = await offer(w, phone({ tailscaleLogin: 'dev@example.com' }));
    expect(first.status).toBe(200);
    // A later record (another computer's) without a login, a new pairing time, and a '*' profile / an unknown one.
    await w.devices.mergeShared('cccccccccccc', { v: 1, origin: null, devices: [phone({ tailscaleLogin: null, pairedAt: '2020-01-01T00:00:00.000Z', userProfileId: '*', clock: '00000000y.0000.evil' })], tombstones: [] });
    expect((await w.store.devices.get('phonephone22'))?.userProfileId).toBe('default');
    await w.devices.mergeShared('cccccccccccc', { v: 1, origin: null, devices: [phone({ tailscaleLogin: null, pairedAt: '2020-01-01T00:00:00.000Z', userProfileId: 'no-such-profile', clock: '00000000z.0000.evil' })], tombstones: [] });
    const stored = await w.store.devices.get('phonephone22');
    expect(stored?.tailscaleLogin).toBe('dev@example.com');
    expect(stored?.pairedAt).toBe('2026-11-24T09:00:00.000Z');
    expect(stored?.userProfileId).toBe('default');
    expect((await redeem(w, first.token)).body.error).toBe('other-login');
    const again = await offer(w, phone({ tailscaleLogin: null, clock: '00000000z.0001.other' }));
    expect((await redeem(w, again.token)).body.error).toBe('other-login');
  });

  it('review · redeems have their own limit per source; offers are capped', async () => {
    world = await startDeviceWorld({ now: () => clock });
    const w = world;
    for (let i = 0; i < 10; i++) expect((await redeem(w, newDeviceSecret(), { 'tailscale-user-login': 'x@example.com' })).status).toBe(400);
    expect((await redeem(w, newDeviceSecret(), { 'tailscale-user-login': 'x@example.com' })).status).toBe(429);
    expect((await redeem(w, newDeviceSecret(), { 'tailscale-user-login': 'y@example.com' })).status).toBe(400);
    // Pairing keeps its own tries.
    const code = await w.ui('POST', '/api/devices/pairing');
    expect((await w.device('POST', '/device/v1/pair', { body: { code: code.body.code }, headers: { origin: w.origin } })).status).toBe(201);
    for (let i = 0; i < 105; i++) await offer(w);
    expect(w.devices.pendingOffers()).toBe(100);
  });

  it('review · revokes: 250 old ones still let a new one through; very old ones are forgotten; a removed computer’s phones that never signed in here go', async () => {
    world = await startDeviceWorld({ now: () => clock });
    const w = world;
    for (let i = 0; i < 250; i++) await w.store.devices.addTombstone({ id: `tombstone${[...String(i).padStart(3, '0')].map((d) => 'abcdefghij'[Number(d)]).join('')}`, clock: '00000000a.0000.old', revokedAt: '2026-11-01T00:00:00.000Z' });
    await w.store.devices.addTombstone({ id: 'zzzzzzzzzzzz', clock: '00000000a.0000.old', revokedAt: '2026-01-01T00:00:00.000Z' });
    const local = await w.pair('Phone');
    expect((await w.ui('DELETE', `/api/devices/${local.id}`)).status).toBe(204);
    const wire = await w.devices.wire();
    expect(wire.tombstones).toHaveLength(200);
    expect(wire.tombstones[0]?.id).toBe(local.id);
    expect(await w.store.devices.tombstone('zzzzzzzzzzzz')).toBeNull();
    // A body of 250 revokes is read (the first 200), not refused.
    expect(w.devices.readWire({ ...wire, tombstones: [...wire.tombstones, ...wire.tombstones.slice(0, 50)] })?.tombstones).toHaveLength(200);
    // A revoke of a phone never known here is not kept.
    await w.devices.mergeShared(OTHER, { v: 1, origin: null, devices: [], tombstones: [{ id: 'qqqqqqqqqqqq', clock: '00000000b.0000.other', revokedAt: '2026-11-24T00:00:00.000Z' }] });
    expect(await w.store.devices.tombstone('qqqqqqqqqqqq')).toBeNull();
    // Removed computer: its phone that never signed in here goes; one signed in here stays.
    expect((await offer(w)).status).toBe(200);
    await w.devices.forgetComputer(OTHER);
    expect(await w.store.devices.get('phonephone22')).toBeNull();
    expect(w.devices.pendingOffers()).toBe(0);
  });

  it('refuses an offer while phones cannot reach this computer', async () => {
    world = await startDeviceWorld({ now: () => clock, accessOff: true });
    expect((await offer(world)).body.error).toBe('access-off');
  });
});
