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

async function offer(w: DeviceWorld, device: SharedDevice = phone()): Promise<{ token: string; status: number; body: any }> {
  const token = newDeviceSecret();
  const answer = await w.devices.acceptOffer(OTHER, { device, tokenHash: hashDeviceSecret(token), expiresAt: new Date(clock + HANDOVER_TTL_MS).toISOString() });
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
    // A sender's long expiry is capped at the TTL from now.
    const token = newDeviceSecret();
    await w.devices.acceptOffer(OTHER, { device: phone(), tokenHash: hashDeviceSecret(token), expiresAt: new Date(clock + 24 * 3_600_000).toISOString() });
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
    expect((await w.devices.acceptOffer(OTHER, { device: phone(), tokenHash: 'x', expiresAt: 'later' })).status).toBe(422);
  });

  it('a phone recorded with a Tailscale login must come with that login', async () => {
    world = await startDeviceWorld({ now: () => clock });
    const w = world;
    const offered = await offer(w, phone({ tailscaleLogin: 'dev@example.com' }));
    expect((await redeem(w, offered.token, { 'tailscale-user-login': 'other@example.com' })).body.error).toBe('other-login');
    const again = await offer(w, phone({ tailscaleLogin: 'dev@example.com' }));
    expect((await redeem(w, again.token, { 'tailscale-user-login': 'dev@example.com' })).status).toBe(200);
  });

  it('refuses an offer while phones cannot reach this computer', async () => {
    world = await startDeviceWorld({ now: () => clock, accessOff: true });
    expect((await offer(world)).body.error).toBe('access-off');
  });
});
