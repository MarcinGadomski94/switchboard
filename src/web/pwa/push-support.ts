/**
 * D73 (`docs/devices.md` → *Notifications*): what a paired device can do about web
 * push, decided from facts passed in (no browser API here, so `tests/web` checks it
 * in Node). The browser part is `push.ts`.
 */

/** What the device can do about notifications right now. */
export type PushSupport =
  /** Not a secure context (plain http on a real host): no service worker, no push. */
  | 'insecure'
  /** iPhone / iPad in a Safari tab: web push needs the app on the Home Screen. */
  | 'ios-install'
  /** The browser has no web push. */
  | 'unsupported'
  /** The site's notifications are blocked in the browser's settings. */
  | 'denied'
  /** Can be switched on. */
  | 'ready';

/** What {@link pushSupport} looks at (passed in, so it is testable without a browser). */
export interface PushEnvironment {
  readonly secureContext: boolean;
  readonly userAgent: string;
  readonly maxTouchPoints: number;
  readonly standalone: boolean;
  readonly hasServiceWorker: boolean;
  readonly hasPushManager: boolean;
  readonly hasNotification: boolean;
  /** `Notification.permission` (`default` when there is no Notification API). */
  readonly permission: 'default' | 'granted' | 'denied';
}

/** `true` on iPhone / iPad / iPod (iPadOS reports a Mac with touch). */
export function isIos(userAgent: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/** What the device can do (see {@link PushSupport}). */
export function pushSupport(env: PushEnvironment): PushSupport {
  if (!env.secureContext) return 'insecure';
  if (isIos(env.userAgent, env.maxTouchPoints) && !env.standalone) return 'ios-install';
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return 'unsupported';
  if (env.permission === 'denied') return 'denied';
  return 'ready';
}

/** The explanation shown for a state other than `ready`. */
export function pushSupportText(support: PushSupport): string | null {
  switch (support) {
    case 'insecure':
      return 'Notifications need HTTPS. Open Switchboard through its https://…ts.net address (Settings → Devices on the computer).';
    case 'ios-install':
      return 'On iPhone and iPad, notifications work only from the Home Screen app: tap Share → Add to Home Screen, open Switchboard from the Home Screen (pair it there if it asks), then enable notifications.';
    case 'unsupported':
      return 'This browser does not support web push notifications.';
    case 'denied':
      return "Notifications are blocked for this site. Allow them in the browser's site settings, then come back.";
    case 'ready':
      return null;
  }
}

/** A base64url VAPID key as the bytes `applicationServerKey` takes. */
export function vapidKeyBytes(key: string): Uint8Array<ArrayBuffer> {
  const base64 = key.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(key.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

