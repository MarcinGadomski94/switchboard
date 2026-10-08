import { stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import { encryptPayload, generateVapidKeys, vapidAuthorization } from '../../../src/server/devices/push/crypto.ts';
import { isAllowedPushEndpoint, validSubscription } from '../../../src/server/devices/push/sender.ts';
import { VAPID_FILE, loadOrCreateVapidKeys } from '../../../src/server/devices/service.ts';
import { type DeviceWorld, startDeviceWorld } from '../../helpers/devices.ts';
import { type FakePushService, decryptPush, startFakePush, verifyVapid } from '../../helpers/fake-push.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';

/**
 * D73 web push (`docs/devices.md` → *Notifications*): RFC 8291 encryption and RFC
 * 8292 VAPID with Node's crypto, checked by an independent receiver (the fake
 * push service decrypts and verifies every message), the event → push selection
 * with per-device toggles, and the removal of expired subscriptions.
 */

let world: DeviceWorld | null = null;
let push: FakePushService | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
  await push?.close();
  push = null;
});

describe('D73 push crypto', () => {
  it('matches the RFC 8291 appendix A example exactly', () => {
    const body = encryptPayload(Buffer.from('When I grow up, I want to be a watermelon'), 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg', {
      senderPrivateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'),
      salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
    });
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
    expect(decryptPush(body, 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94', 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg').toString()).toBe(
      'When I grow up, I want to be a watermelon',
    );
  });

  it('signs a VAPID JWT (ES256) for the push service origin, valid for 12 hours', () => {
    const keys = generateVapidKeys();
    const now = Date.parse('2026-10-08T12:00:00Z');
    const header = vapidAuthorization(keys, 'https://web.push.apple.com/QWxs?x=1', 'https://example.com', now);
    const { key, claims } = verifyVapid(header, 'https://web.push.apple.com', now);
    expect(key).toBe(keys.publicKey);
    expect(claims).toEqual({ aud: 'https://web.push.apple.com', exp: now / 1000 + 12 * 3600, sub: 'https://example.com' });
    // Another key's signature is refused.
    const other = generateVapidKeys();
    expect(() => verifyVapid(header.replace(keys.publicKey, other.publicKey), 'https://web.push.apple.com', now)).toThrow('signature');
  });

  it('keeps the VAPID keys in the data folder (0600), the same pair across restarts', async () => {
    const dir = await makeTempDir('vapid');
    try {
      const first = await loadOrCreateVapidKeys(dir);
      const again = await loadOrCreateVapidKeys(dir);
      expect(again).toEqual(first);
      expect((await stat(path.join(dir, VAPID_FILE))).mode & 0o777).toBe(0o600);
    } finally {
      await removeTempDir(dir);
    }
  });

  it('accepts only the browser vendors push services as endpoints', () => {
    for (const ok of ['https://web.push.apple.com/abc', 'https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://wns2-par02p.notify.windows.com/w/?token=x']) {
      expect(isAllowedPushEndpoint(ok), ok).toBe(true);
    }
    for (const bad of ['http://web.push.apple.com/abc', 'https://push.apple.com.evil.example/x', 'https://evil.example/fcm.googleapis.com', 'https://127.0.0.1/x', 'https://fcm.googleapis.com:8443/x', 'https://u:p@fcm.googleapis.com/x', 'http://127.0.0.1:4925/push/x', 'not a url']) {
      expect(isAllowedPushEndpoint(bad), bad).toBe(false);
    }
    expect(isAllowedPushEndpoint('http://127.0.0.1:4925/push/x', ['http://127.0.0.1:4925'])).toBe(true);
    const keys = { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') };
    expect(validSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys })).toBe(true);
    expect(validSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { ...keys, auth: 'short' } })).toBe(false);
  });
});

function session(id: string, status: Session['status'], name = 'web'): Session {
  return { id, name, status } as unknown as Session;
}

async function pushWorld(): Promise<{ w: DeviceWorld; fake: FakePushService }> {
  const { freeTestPorts } = await import('../../helpers/net.ts');
  const port = (await freeTestPorts()).at(-1) as number;
  push = await startFakePush(port);
  world = await startDeviceWorld({ env: { SWITCHBOARD_PUSH_TEST_ENDPOINTS: push.origin } });
  return { w: world, fake: push };
}

describe('D73 push delivery', () => {
  it('delivers encrypted, VAPID-signed notifications for the toggled events only', async () => {
    const { w, fake } = await pushWorld();
    const { cookie } = await w.pair();
    const subscription = fake.subscribe();
    // A subscription off the known push services is refused.
    const bad = await w.device('PUT', '/api/device/push', { cookie, body: { subscription: { ...subscription, endpoint: 'https://evil.example/push' } } });
    expect(bad.status).toBe(422);
    // Toggles before a subscription: refused.
    expect((await w.device('PUT', '/api/device/push', { cookie, body: { events: { inbox: false } } })).status).toBe(409);
    const saved = await w.device('PUT', '/api/device/push', { cookie, body: { subscription: { endpoint: subscription.endpoint, keys: subscription.keys } } });
    expect(saved.status).toBe(200);
    expect(saved.body.device.push).toBe(true);
    expect(saved.body.events).toEqual({ permission: true, questions: true, turnFinished: true, errors: true, inbox: true });

    // Test notification.
    expect((await w.device('POST', '/api/device/push/test', { cookie })).body).toEqual({ ok: true });
    const [test] = await fake.waitFor(1);
    expect(test?.payload).toMatchObject({ kind: 'test', title: 'Switchboard', url: '/settings/devices' });
    expect(test?.vapidKey).toBe((await w.devices.vapidKeys()).publicKey);
    expect(test?.claims.aud).toBe(fake.origin);
    expect(test?.ttl).toBe('3600');

    // A turn finished: run → idle.
    w.bus.publish('sessionUpdated', session('s1', 'run'));
    w.bus.publish('sessionUpdated', session('s1', 'idle'));
    const turn = (await fake.waitFor(2))[1];
    expect(turn?.payload).toEqual({ kind: 'turnFinished', title: 'web finished', body: 'The turn is done; the session is waiting for you.', url: '/sessions/s1', tag: 'session-s1' });
    // An error.
    w.bus.publish('sessionUpdated', session('s1', 'fail'));
    expect((await fake.waitFor(3))[2]?.payload).toMatchObject({ kind: 'errors', url: '/sessions/s1' });
    // A paired machine's session never notifies here.
    w.bus.publish('sessionUpdated', session('r~abcdefghijkl~s9', 'run'));
    w.bus.publish('sessionUpdated', session('r~abcdefghijkl~s9', 'idle'));

    // A permission request: a new Inbox item after inboxChanged; high urgency; the tool named.
    const record = await w.store.sessions.create({ name: 'api', claudeSessionId: 'c-1' });
    await w.store.permissions.create({ sessionId: record.id, requestId: 'r1', toolName: 'Bash', input: { command: 'rm -rf build' } });
    w.bus.publish('inboxChanged', { count: 1 });
    const permission = (await fake.waitFor(4))[3];
    expect(permission?.payload).toMatchObject({ kind: 'permission', url: `/sessions/${record.id}` });
    expect((permission?.payload as { title: string }).title).toContain('needs permission');
    expect(permission?.urgency).toBe('high');
    // The same item again announces nothing.
    w.bus.publish('inboxChanged', { count: 1 });

    // Toggle "Turn finished" off: no push for it, the rest still.
    const toggled = await w.device('PUT', '/api/device/push', { cookie, body: { events: { turnFinished: false } } });
    expect(toggled.body.events.turnFinished).toBe(false);
    w.bus.publish('sessionUpdated', session('s2', 'run'));
    w.bus.publish('sessionUpdated', session('s2', 'done'));
    await w.store.systemItems.create({ kind: 'schedule-run-failed', source: 'nightly', title: 'Scheduled run failed' });
    w.bus.publish('inboxChanged', { count: 2 });
    const inbox = (await fake.waitFor(5))[4];
    expect(inbox?.payload).toMatchObject({ kind: 'inbox', url: '/inbox' });
    await w.devices.notifierIdle();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fake.received).toHaveLength(5);
    expect(fake.refused).toEqual([]);
  });

  it('removes a subscription the push service says is gone (410 / 404) and sends nothing while device access is off', async () => {
    const { w, fake } = await pushWorld();
    const a = await w.pair('A');
    const b = await w.pair('B');
    const subA = fake.subscribe();
    const subB = fake.subscribe();
    await w.device('PUT', '/api/device/push', { cookie: a.cookie, body: { subscription: { endpoint: subA.endpoint, keys: subA.keys } } });
    await w.device('PUT', '/api/device/push', { cookie: b.cookie, body: { subscription: { endpoint: subB.endpoint, keys: subB.keys } } });
    fake.expire(subA, 410);
    fake.expire(subB, 404);
    w.bus.publish('sessionUpdated', session('s1', 'run'));
    w.bus.publish('sessionUpdated', session('s1', 'idle'));
    const deadline = Date.now() + 5_000;
    while ((await w.store.devices.pushList()).length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await w.store.devices.pushList()).toEqual([]);
    expect((await w.ui('GET', '/api/devices')).body.devices.map((d: { push: boolean }) => d.push)).toEqual([false, false]);

    // Subscribed again, then access off: nothing is sent.
    const again = fake.subscribe();
    await w.device('PUT', '/api/device/push', { cookie: a.cookie, body: { subscription: { endpoint: again.endpoint, keys: again.keys } } });
    await w.ui('PUT', '/api/devices/access', { enabled: false });
    w.bus.publish('sessionUpdated', session('s3', 'run'));
    w.bus.publish('sessionUpdated', session('s3', 'idle'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fake.received).toEqual([]);
    // Notifications off for a device removes its subscription.
    await w.enableAccess();
    expect((await w.device('DELETE', '/api/device/push', { cookie: a.cookie })).body.device.push).toBe(false);
  });
});
