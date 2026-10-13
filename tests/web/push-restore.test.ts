import { describe, expect, it } from 'vitest';
import { DEFAULT_PUSH_EVENTS, type DeviceSelfView, type PushSubscriptionInput } from '../../src/core/devices.ts';
import { type BrowserSubscription, type PushRestoreHost, isPushGoneError, pushRestoreState, restorePush } from '../../src/web/pwa/push-restore.ts';
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
/** `serverGone`: endpoints Switchboard refuses as gone (409 `push-gone`, as `ApiError` carries it). */
function host(options: { permission?: 'default' | 'granted' | 'denied'; turnedOff?: boolean; subscription?: BrowserSubscription | null; view?: DeviceSelfView; serverGone?: readonly string[]; goneEndpoint?: string | null } = {}) {
  const calls: string[] = [];
  const saved: PushSubscriptionInput[] = [];
  const view = options.view ?? FRESH;
  const state = { subscription: options.subscription === undefined ? BROWSER : options.subscription, gone: options.goneEndpoint ?? null };
  const value: PushRestoreHost = {
    permission: () => {
      calls.push('permission');
      return options.permission ?? 'granted';
    },
    turnedOff: () => options.turnedOff ?? false,
    goneEndpoint: () => state.gone,
    markGone: (endpoint) => {
      calls.push('markGone');
      state.gone = endpoint;
    },
    unsubscribe: async () => {
      calls.push('unsubscribe');
      state.subscription = null;
    },
    subscription: async () => {
      calls.push('getSubscription');
      return state.subscription;
    },
    deviceSelf: async () => {
      calls.push('deviceSelf');
      return view;
    },
    save: async (subscription) => {
      calls.push('save');
      if (options.serverGone?.includes(subscription.endpoint)) {
        throw Object.assign(new Error('This push subscription expired.'), { status: 409, body: { error: 'push-gone', message: 'expired' } });
      }
      saved.push(subscription);
      return { ...view, device: { ...DEVICE, push: true }, pushEndpoint: subscription.endpoint };
    },
  };
  return { value, calls, saved, state };
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
    expect(pushRestoreState({ view: FRESH, permission: 'granted', turnedOff: false, goneEndpoint: null, subscription: { input: SUB, key: null } })).toBe('unknown-key');
  });

  it('does nothing on this machine’s own UI or while device access is off', async () => {
    const desktop = host({ view: { device: null, vapidPublicKey: null, events: DEFAULT_PUSH_EVENTS, pushEndpoint: null } });
    expect((await restorePush(desktop.value)).state).toBe('unavailable');
    expect(desktop.calls).not.toContain('getSubscription');
    const accessOff = host({ view: { ...FRESH, vapidPublicKey: null } });
    expect((await restorePush(accessOff.value)).state).toBe('unavailable');
    expect(accessOff.calls).not.toContain('save');
  });

  it('a subscription Switchboard refuses as gone (409 push-gone) is unsubscribed and never sent again', async () => {
    const h = host({ serverGone: [SUB.endpoint] });
    const first = await restorePush(h.value);
    expect(first.state).toBe('gone');
    // The view stays the server's (no subscription): the switch shows off.
    expect(first.view).toEqual(FRESH);
    expect(h.calls.filter((call) => call === 'save')).toHaveLength(1);
    expect(h.calls).toContain('unsubscribe');
    expect(h.state).toEqual({ subscription: null, gone: SUB.endpoint });
    // The next start / visible event: nothing left to send.
    expect((await restorePush(h.value)).state).toBe('none');
    expect(h.calls.filter((call) => call === 'save')).toHaveLength(1);
  });

  it('stops even when unsubscribing fails: the noted endpoint is not sent again', async () => {
    const h = host({ serverGone: [SUB.endpoint] });
    h.value.unsubscribe = async () => {
      throw new Error('unsubscribe failed');
    };
    expect((await restorePush(h.value)).state).toBe('gone');
    expect(h.state.subscription).toEqual(BROWSER);
    for (let i = 0; i < 3; i += 1) expect((await restorePush(h.value)).state).toBe('gone');
    expect(h.calls.filter((call) => call === 'save')).toHaveLength(1);
  });

  it('a fresh subscription (another endpoint) is restored even with a gone endpoint noted; other errors still fail the run', async () => {
    const fresh = host({ goneEndpoint: 'https://fcm.googleapis.com/fcm/send/dead' });
    expect((await restorePush(fresh.value)).state).toBe('restore');
    expect(fresh.saved).toEqual([SUB]);
    const failing = host();
    failing.value.save = async () => {
      throw Object.assign(new Error('nope'), { status: 409, body: { error: 'no-subscription' } });
    };
    await expect(restorePush(failing.value)).rejects.toThrow('nope');
    expect(failing.calls).not.toContain('unsubscribe');
    expect(isPushGoneError({ status: 409, body: { error: 'push-gone' } })).toBe(true);
    expect(isPushGoneError({ status: 410, body: { error: 'push-gone' } })).toBe(false);
    expect(isPushGoneError(null)).toBe(false);
  });
});
