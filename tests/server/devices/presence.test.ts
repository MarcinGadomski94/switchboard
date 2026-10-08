import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { HubMessage } from '../../../src/server/hub/bus.ts';
import type { Session } from '../../../src/core/api.ts';
import { PRESENCE_HEARTBEAT_MS, PRESENCE_LAPSE_MS } from '../../../src/core/devices.ts';
import { DevicePresence, MAX_CLIENTS } from '../../../src/server/devices/presence.ts';
import { type DeviceWorld, startDeviceWorld } from '../../helpers/devices.ts';
import { type FakePushService, startFakePush } from '../../helpers/fake-push.ts';
import { freeTestPorts } from '../../helpers/net.ts';

/**
 * D87 (`docs/devices.md` → *No notifications while Switchboard is open*): a
 * paired device with Switchboard open in front (a page that reported `visible`
 * within the last 75 s and whose `/hub?client=` stream is open) gets no system
 * notification; the happening goes out as the `/hub` `notice` event instead (its
 * page shows a toast). Hidden, closed, lapsed or disconnected: the push goes as
 * before. What happened while in front is not sent later.
 */

describe('D87 presence tracking', () => {
  it('a page is in front while it reported visible, its stream is open and the report is fresh', () => {
    let now = 1_000_000;
    const presence = new DevicePresence({ now: () => now });
    expect(PRESENCE_HEARTBEAT_MS).toBe(30_000);
    expect(PRESENCE_LAPSE_MS).toBe(75_000);
    expect(presence.inFront('d1')).toBe(false);
    // A report without a stream is not enough (the page could not show a toast).
    presence.report('d1', 'page-aaaaaaaa', { visible: true, focused: true });
    expect(presence.inFront('d1')).toBe(false);
    const release = presence.connect('d1', 'page-aaaaaaaa');
    expect(presence.inFront('d1')).toBe(true);
    expect(presence.inFront('d2')).toBe(false);
    // Hidden.
    presence.report('d1', 'page-aaaaaaaa', { visible: false, focused: false });
    expect(presence.inFront('d1')).toBe(false);
    // Visible again; focus is recorded but not needed.
    presence.report('d1', 'page-aaaaaaaa', { visible: true, focused: false });
    expect(presence.inFront('d1')).toBe(true);
    // The heartbeat lapses.
    now += PRESENCE_LAPSE_MS;
    expect(presence.inFront('d1')).toBe(true);
    now += 1;
    expect(presence.inFront('d1')).toBe(false);
    presence.report('d1', 'page-aaaaaaaa', { visible: true, focused: true });
    expect(presence.inFront('d1')).toBe(true);
    // The stream drops: not in front; it reconnects within the lapse: in front again (no new report needed).
    release();
    release();
    expect(presence.inFront('d1')).toBe(false);
    const again = presence.connect('d1', 'page-aaaaaaaa');
    expect(presence.inFront('d1')).toBe(true);
    again();
  });

  it('several pages per device: in front while any of them is; revoking forgets them', () => {
    let now = 5_000_000;
    const presence = new DevicePresence({ now: () => now });
    const tab = presence.connect('d1', 'tab-aaaaaaaa');
    const app = presence.connect('d1', 'app-bbbbbbbb');
    presence.report('d1', 'tab-aaaaaaaa', { visible: false, focused: false });
    presence.report('d1', 'app-bbbbbbbb', { visible: true, focused: true });
    expect(presence.inFrontCount('d1')).toBe(1);
    expect(presence.inFront('d1')).toBe(true);
    presence.report('d1', 'tab-aaaaaaaa', { visible: true, focused: true });
    expect(presence.inFrontCount('d1')).toBe(2);
    app();
    expect(presence.inFrontCount('d1')).toBe(1);
    presence.report('d1', 'tab-aaaaaaaa', { visible: false, focused: false });
    expect(presence.inFront('d1')).toBe(false);
    presence.report('d1', 'tab-aaaaaaaa', { visible: true, focused: true });
    presence.forget('d1');
    expect(presence.inFront('d1')).toBe(false);
    tab();
    // A runaway device cannot grow the map without bound.
    for (let i = 0; i < MAX_CLIENTS + 10; i++) presence.report('d2', `page-${String(i).padStart(8, '0')}`, { visible: false, focused: false });
    now += 1;
    expect(presence.inFrontCount('d2')).toBe(0);
  });
});

function session(id: string, status: Session['status'], extra: Partial<Session> = {}): Session {
  return { id, name: 'web', status, ...extra } as unknown as Session;
}

/** Opens `/hub?client=<id>` on the device listener as the device; resolves once the stream is open; `close()` drops it. */
async function openHub(w: DeviceWorld, cookie: string, client: string): Promise<{ readonly close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: w.devicePort, method: 'GET', path: `/hub?client=${client}`, agent: false, headers: { host: `localhost:${w.devicePort}`, cookie, accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`hub: ${res.statusCode}`));
        return;
      }
      res.on('data', () => undefined);
      resolve({
        close: () =>
          new Promise<void>((done) => {
            res.once('close', () => done());
            req.destroy();
          }),
      });
    });
    req.once('error', reject);
    req.end();
  });
}

let world: DeviceWorld | null = null;
let push: FakePushService | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
  await push?.close();
  push = null;
});

const settle = (ms = 300): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('D87 no system notification while Switchboard is open on the device', () => {
  it('skips the devices in front (this machine’s and the paired machines’ happenings), sends to the others, and never sends the skipped ones later', async () => {
    push = await startFakePush((await freeTestPorts()).at(-1) as number);
    world = await startDeviceWorld({ env: { SWITCHBOARD_PUSH_TEST_ENDPOINTS: push.origin } });
    const w = world;
    const fake = push;
    const a = await w.pair('A');
    const b = await w.pair('B');
    const subA = fake.subscribe();
    const subB = fake.subscribe();
    expect((await w.device('PUT', '/api/device/push', { cookie: a.cookie, body: { subscription: { endpoint: subA.endpoint, keys: subA.keys } } })).status).toBe(200);
    expect((await w.device('PUT', '/api/device/push', { cookie: b.cookie, body: { subscription: { endpoint: subB.endpoint, keys: subB.keys } } })).status).toBe(200);
    const notices: HubMessage[] = [];
    w.bus.subscribe((message) => {
      if (message.name === 'notice') notices.push(message);
    });
    const pathOf = (endpoint: string): string => new URL(endpoint).pathname;

    // A has Switchboard open in front: a visible report and its hub stream.
    const hubA = await openHub(w, a.cookie, 'page-a-000001');
    const reported = await w.device('PUT', '/api/device/presence', { cookie: a.cookie, headers: { origin: w.origin }, body: { client: 'page-a-000001', visible: true, focused: true } });
    expect(reported.status, reported.text).toBe(204);
    expect(w.devices.inFront(a.id)).toBe(true);
    expect(w.devices.inFront(b.id)).toBe(false);

    // A finished turn: only B gets the push; the hub carries the notice (same id as the push) for A's toast.
    w.bus.publish('sessionUpdated', session('s1', 'run'));
    w.bus.publish('sessionUpdated', session('s1', 'idle'));
    const [first] = await fake.waitFor(1);
    expect(first?.path).toBe(pathOf(subB.endpoint));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toMatchObject({ kind: 'turnFinished', url: '/sessions/s1', title: 'web finished' });
    expect((first?.payload as { id: string }).id).toBe((notices[0]?.payload as { id: string }).id);

    // A paired machine's session: the same rule.
    const machine = { id: 'abcdefghijkl', name: 'pc-office', state: 'online' as const };
    w.bus.publish('sessionUpdated', session('r~abcdefghijkl~s9', 'run', { machine } as Partial<Session>));
    w.bus.publish('sessionUpdated', session('r~abcdefghijkl~s9', 'fail', { machine } as Partial<Session>));
    const second = (await fake.waitFor(2))[1];
    expect(second?.path).toBe(pathOf(subB.endpoint));
    expect(second?.payload).toMatchObject({ kind: 'errors', url: '/sessions/r~abcdefghijkl~s9' });
    await settle();
    expect(fake.received.map((p) => p.path)).toEqual([pathOf(subB.endpoint), pathOf(subB.endpoint)]);

    // B opens Switchboard too: nobody gets a push.
    const hubB = await openHub(w, b.cookie, 'page-b-000001');
    expect((await w.device('PUT', '/api/device/presence', { cookie: b.cookie, headers: { origin: w.origin }, body: { client: 'page-b-000001', visible: true } })).status).toBe(204);
    w.bus.publish('sessionUpdated', session('s2', 'run'));
    w.bus.publish('sessionUpdated', session('s2', 'done'));
    await settle();
    expect(fake.received).toHaveLength(2);
    expect(notices).toHaveLength(3);

    // A's page goes to the background (hidden), B closes its page (the stream drops): both get the next one.
    expect((await w.device('PUT', '/api/device/presence', { cookie: a.cookie, headers: { origin: w.origin }, body: { client: 'page-a-000001', visible: false, focused: false } })).status).toBe(204);
    await hubB.close();
    const deadline = Date.now() + 5_000;
    while (w.devices.inFront(b.id) && Date.now() < deadline) await settle(20);
    expect(w.devices.inFront(a.id)).toBe(false);
    expect(w.devices.inFront(b.id)).toBe(false);
    w.bus.publish('sessionUpdated', session('s3', 'run'));
    w.bus.publish('sessionUpdated', session('s3', 'idle'));
    const after = await fake.waitFor(4);
    expect(after.slice(2).map((p) => p.path).sort()).toEqual([pathOf(subA.endpoint), pathOf(subB.endpoint)].sort());
    // Only s3: what happened while in front (s1 for A, s2 for both) was not kept for later.
    expect(after.slice(2).map((p) => (p.payload as { url: string }).url)).toEqual(['/sessions/s3', '/sessions/s3']);
    await settle();
    expect(fake.received).toHaveLength(4);
    await hubA.close();
  });

  it('the test notification is sent while the page is open (it was asked for there)', async () => {
    push = await startFakePush((await freeTestPorts()).at(-1) as number);
    world = await startDeviceWorld({ env: { SWITCHBOARD_PUSH_TEST_ENDPOINTS: push.origin } });
    const a = await world.pair('A');
    const sub = push.subscribe();
    await world.device('PUT', '/api/device/push', { cookie: a.cookie, body: { subscription: { endpoint: sub.endpoint, keys: sub.keys } } });
    const hub = await openHub(world, a.cookie, 'page-a-000002');
    await world.device('PUT', '/api/device/presence', { cookie: a.cookie, headers: { origin: world.origin }, body: { client: 'page-a-000002', visible: true } });
    expect(world.devices.inFront(a.id)).toBe(true);
    expect((await world.device('POST', '/api/device/push/test', { cookie: a.cookie })).body).toEqual({ ok: true });
    expect((await push.waitFor(1))[0]?.payload).toMatchObject({ kind: 'test' });
    await hub.close();
  });

  it('PUT /api/device/presence: validated; this machine’s UI gets 204 and records nothing; a hub stream without a client id or on the UI changes nothing', async () => {
    world = await startDeviceWorld();
    const a = await world.pair('A');
    for (const body of [null, {}, { client: 'short', visible: true }, { client: 'page-a-000003', visible: 'yes' }, { client: 'page-a-000003', visible: true, focused: 1 }, { client: 'bad id with spaces', visible: true }]) {
      const answer = await world.device('PUT', '/api/device/presence', { cookie: a.cookie, headers: { origin: world.origin }, body });
      expect(answer.status, JSON.stringify(body)).toBe(422);
      expect(answer.body.error).toBe('invalid');
    }
    // No credential: 401 as for any device API call.
    expect((await world.device('PUT', '/api/device/presence', { headers: { origin: world.origin }, body: { client: 'page-a-000003', visible: true } })).status).toBe(401);
    // This machine's UI: accepted, nothing recorded.
    expect((await world.ui('PUT', '/api/device/presence', { client: 'desk-0000001', visible: true })).status).toBe(204);
    // A stream without a client id does not count.
    const bare = await openHub(world, a.cookie, '');
    await world.device('PUT', '/api/device/presence', { cookie: a.cookie, headers: { origin: world.origin }, body: { client: 'page-a-000003', visible: true } });
    expect(world.devices.inFront(a.id)).toBe(false);
    await bare.close();
    // Revoking the device forgets its pages.
    const hub = await openHub(world, a.cookie, 'page-a-000003');
    expect(world.devices.inFront(a.id)).toBe(true);
    expect((await world.ui('DELETE', `/api/devices/${a.id}`)).status).toBe(204);
    expect(world.devices.inFront(a.id)).toBe(false);
    await hub.close().catch(() => undefined);
  });
});
