import type { DeviceSelfView } from '../../core/devices.ts';
import { api, onDeviceOrigin } from '../api/client.ts';
import { subscriptionInput } from './push.ts';
import { type BrowserSubscription, PUSH_OFF_KEY, type PushRestoreResult, restorePush } from './push-restore.ts';

/**
 * D73 fix, 2026-10-13: wires {@link restorePush} to this page (`push-restore.ts`
 * has the rules). Runs on a paired device only (the devices' origin), never on
 * this machine's own UI: at start (also right after pairing, which lands on `/`),
 * whenever the page becomes visible again, and when Settings → Devices opens.
 */

/** How long a run waits for the service worker to be ready (none in development builds). */
const READY_TIMEOUT_MS = 10_000;

let running: Promise<PushRestoreResult | null> | null = null;
const listeners = new Set<(view: DeviceSelfView) => void>();

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Records that notifications were turned off on this device on purpose (`true`), or switched on again. */
export function markPushTurnedOff(off: boolean): void {
  try {
    if (off) storage()?.setItem(PUSH_OFF_KEY, '1');
    else storage()?.removeItem(PUSH_OFF_KEY);
  } catch {
    // Storage full or blocked: Disable still unsubscribes the browser, which is what keeps it off.
  }
}

function turnedOff(): boolean {
  try {
    return storage()?.getItem(PUSH_OFF_KEY) === '1';
  } catch {
    return false;
  }
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  const found = await navigator.serviceWorker.getRegistration('/');
  if (found) return found;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), READY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function browserSubscription(): Promise<BrowserSubscription | null> {
  const subscription = await (await registration())?.pushManager.getSubscription();
  if (!subscription) return null;
  const key = subscription.options?.applicationServerKey;
  return { input: subscriptionInput(subscription), key: key ? new Uint8Array(key) : null };
}

/**
 * Restores this device's push subscription if it was lost (one run at a time;
 * `null` off a device origin, without web push, or when a request failed).
 * A restore is announced to {@link onPushRestored}'s listeners.
 */
export function restorePushNow(): Promise<PushRestoreResult | null> {
  if (!onDeviceOrigin() || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return Promise.resolve(null);
  running ??= restorePush({
    permission: () => Notification.permission,
    turnedOff,
    subscription: browserSubscription,
    deviceSelf: api.deviceSelf,
    save: (subscription) => api.saveDevicePush({ subscription }),
  })
    .then((result) => {
      if (result.state === 'restore' && result.view) for (const listener of listeners) listener(result.view);
      return result;
    })
    .catch(() => null)
    .finally(() => {
      running = null;
    });
  return running;
}

/** Calls `listener` with the device's view after each restore; returns the unsubscribe. */
export function onPushRestored(listener: (view: DeviceSelfView) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let started = false;

/** Starts the restore on a paired device: now and whenever the page becomes visible (the web entry calls it once). */
export function startPushRestore(): void {
  if (started || typeof document === 'undefined' || !onDeviceOrigin()) return;
  started = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void restorePushNow();
  });
  void restorePushNow();
}
