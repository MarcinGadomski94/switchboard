import type { PushSubscriptionInput } from '../../core/devices.ts';
import { type PushEnvironment, vapidKeyBytes } from './push-support.ts';

/**
 * D73 (`docs/devices.md` → *Notifications*): turning web push on and off on a
 * paired device: asks for the permission, subscribes through the service worker
 * (`sw.js` shows the notifications) and unsubscribes. What the device can do at
 * all is decided in `push-support.ts`.
 */

/** The environment of this page. */
export function currentPushEnvironment(): PushEnvironment {
  const nav = navigator as Navigator & { readonly standalone?: boolean };
  return {
    secureContext: window.isSecureContext,
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    standalone: window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true,
    hasServiceWorker: 'serviceWorker' in nav,
    hasPushManager: 'PushManager' in window,
    hasNotification: 'Notification' in window,
    permission: 'Notification' in window ? Notification.permission : 'default',
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** A subscription's JSON as the API takes it; `null` when it lacks its keys. */
export function subscriptionInput(subscription: PushSubscription): PushSubscriptionInput | null {
  const json = subscription.toJSON();
  const p256dh = json.keys?.['p256dh'];
  const auth = json.keys?.['auth'];
  if (!json.endpoint || !p256dh || !auth) return null;
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

/**
 * Asks for the permission (must run in a click), subscribes with `vapidPublicKey`
 * and returns the subscription to store; throws with a readable message when the
 * permission is refused or subscribing fails.
 */
export async function subscribePush(vapidPublicKey: string): Promise<PushSubscriptionInput> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed.');
  const registration = await navigator.serviceWorker.ready;
  const key = vapidKeyBytes(vapidPublicKey);
  let existing = await registration.pushManager.getSubscription();
  // A subscription made for another key (VAPID keys made anew) cannot be used: replace it.
  const existingKey = existing?.options.applicationServerKey;
  if (existing && existingKey && !sameBytes(new Uint8Array(existingKey), key)) {
    await existing.unsubscribe();
    existing = null;
  }
  const subscription = existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  const input = subscriptionInput(subscription);
  if (!input) throw new Error('The browser gave an incomplete push subscription.');
  return input;
}

/** Unsubscribes this browser (if subscribed). */
export async function unsubscribePush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  await subscription?.unsubscribe();
}
