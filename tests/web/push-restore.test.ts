import { describe, expect, it } from 'vitest';
import { DEFAULT_PUSH_EVENTS, type DeviceSelfView, type PushSubscriptionInput } from '../../src/core/devices.ts';
import { type BrowserSubscription, type PushRestoreHost, pushRestoreState, restorePush } from '../../src/web/pwa/push-restore.ts';
import { vapidKeyBytes } from '../../src/web/pwa/push-support.ts';

/** D73 fix, 2026-10-13: a paired device restores a push subscription Switchboard lost (re-pairing). */

const VAPID = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
const OTHER_VAPID = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]).toString('base64url');
const SUB: PushSubscriptionInput = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'BCx', auth: 'Tmx' } };
const DEVICE = { id: 'k3v7q2m9x4ab', name: 'Pixel', userAgent: null, pairedAt: '2026-10-13T10:00:00.000Z', lastSeenAt: null, push: false };
/** A freshly re-paired device: Switchboard stores no subscription for it. */
const FRESH: DeviceSelfView = { device: DEVICE, vapidPublicKey: VAPID, events: DEFAULT_PUSH_EVENTS, pushEndpoint: null };
const BROWSER: BrowserSubscription = { input: SUB, key: vapidKeyBytes(VAPID) };

/** A host whose every call is recorded; it has no way to prompt or subscribe at all. */
function host(options: { permission?: 'default' | 'granted' | 'denied'; turnedOff?: boolean; subscription?: BrowserSubscription | null; view?: DeviceSelfView } = {}) {
  const calls: string[] = [];
  const saved: PushSubscriptionInput[] = [];
  const view = options.view ?? FRESH;
  const value: PushRestoreHost = {
    permission: () => {
      calls.push('permission');
      return options.permission ?? 'granted';
    },
    turnedOff: () => options.turnedOff ?? false,
    subscription: async () => {
      calls.push('getSubscription');
      return options.subscription === undefined ? BROWSER : options.subscription;
    },
    deviceSelf: async () => {
      calls.push('deviceSelf');
      return view;
    },
    save: async (subscription) => {
      calls.push('save');
      saved.push(subscription);
      return { ...view, device: { ...DEVICE, push: true }, pushEndpoint: subscription.endpoint };
    },
  };
  return { value, calls, saved };
}

describe('D73 fix · restoring a lost push subscription', () => {
  it('restores the existing subscription when the permission is granted and the server has none (re-pairing), with the default toggles', async () => {
    const h = host();
    const result = await restorePush(h.value);
    expect(result.state).toBe('restore');
    expect(h.saved).toEqual([SUB]);
    expect(result.view).toMatchObject({ device: { push: true }, pushEndpoint: SUB.endpoint, events: DEFAULT_PUSH_EVENTS });
  });

  it('restores when the server stores another endpoint, and does nothing when it stores this one', async () => {
    const other = host({ view: { ...FRESH, device: { ...DEVICE, push: true }, pushEndpoint: 'https://fcm.googleapis.com/fcm/send/old' } });
    expect((await restorePush(other.value)).state).toBe('restore');
    expect(other.saved).toEqual([SUB]);
    const same = host({ view: { ...FRESH, device: { ...DEVICE, push: true }, pushEndpoint: SUB.endpoint } });
    expect((await restorePush(same.value)).state).toBe('in-sync');
    expect(same.calls).not.toContain('save');
  });

  it('never re-enables notifications turned off on purpose, even when the browser kept its subscription', async () => {
    const h = host({ turnedOff: true });
    const result = await restorePush(h.value);
    expect(result.state).toBe('off');
    expect(h.calls).not.toContain('save');
    // Disable unsubscribes the browser too: with no subscription there is nothing to restore either.
    const gone = host({ subscription: null });
    expect((await restorePush(gone.value)).state).toBe('none');
    expect(gone.calls).not.toContain('save');
  });

  it('never prompts: without a granted permission it asks nothing and sends nothing', async () => {
    for (const permission of ['default', 'denied'] as const) {
      const h = host({ permission });
      expect((await restorePush(h.value)).state).toBe('no-permission');
      // The host offers no prompt or subscribe at all; only the permission was read.
      expect(h.calls).toEqual(['permission']);
    }
  });

  it('leaves a subscription made with another VAPID key to the Enable button (shown as off)', async () => {
    const h = host({ subscription: { input: SUB, key: vapidKeyBytes(OTHER_VAPID) }, view: { ...FRESH, device: { ...DEVICE, push: true }, pushEndpoint: SUB.endpoint } });
    expect((await restorePush(h.value)).state).toBe('other-key');
    expect(h.calls).not.toContain('save');
    // A browser that does not say which key: left alone, not restored.
    expect(pushRestoreState({ view: FRESH, permission: 'granted', turnedOff: false, subscription: { input: SUB, key: null } })).toBe('unknown-key');
  });

  it('does nothing on this machine’s own UI or while device access is off', async () => {
    const desktop = host({ view: { device: null, vapidPublicKey: null, events: DEFAULT_PUSH_EVENTS, pushEndpoint: null } });
    expect((await restorePush(desktop.value)).state).toBe('unavailable');
    expect(desktop.calls).not.toContain('getSubscription');
    const accessOff = host({ view: { ...FRESH, vapidPublicKey: null } });
    expect((await restorePush(accessOff.value)).state).toBe('unavailable');
    expect(accessOff.calls).not.toContain('save');
  });
});
