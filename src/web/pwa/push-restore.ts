import type { DeviceSelfView, PushSubscriptionInput } from '../../core/devices.ts';
import { sameKey, vapidKeyBytes } from './push-support.ts';

/**
 * D73 fix, 2026-10-13 (`docs/devices.md` → *Notifications* → *Restoring the
 * subscription*): a paired device restores its push subscription by itself.
 *
 * A subscription belongs to one device record, so re-pairing a phone (removing it
 * and pairing again) leaves Switchboard with none, while the browser still has the
 * permission and its subscription. When the page starts on a paired device, comes
 * back into view, or opens Settings → Devices, it sends that existing subscription
 * back (`PUT /api/device/push` without toggles: the server's defaults, as a fresh
 * opt-in gets). It never asks for the permission and never subscribes anew.
 *
 * It restores only when ALL hold ({@link pushRestoreState}):
 * - this is a paired device and device access is on (a VAPID key is offered);
 * - `Notification.permission` is `granted`;
 * - notifications were not turned off on this device on purpose (the local
 *   marker {@link PUSH_OFF_KEY}, set by Disable, cleared by Enable);
 * - the browser has a subscription made with the current VAPID key;
 * - the server stores none for this device, or one with another endpoint.
 *
 * A subscription made with another key (VAPID keys made anew) cannot be reused
 * without subscribing again, which needs a click: it is left to the Enable button,
 * and the page shows notifications as off meanwhile (`other-key`).
 *
 * The page wiring is `push-restore-page.ts`; this module has no DOM, so
 * `tests/web` runs it in Node.
 */

/** `localStorage` key: notifications were turned off on this device on purpose (`'1'`). */
export const PUSH_OFF_KEY = 'switchboard.push.off';

/** What {@link pushRestoreState} found. */
export type PushRestoreState =
  /** Not a paired device, or device access is off: nothing to do. */
  | 'unavailable'
  /** The permission is not granted (restoring would need a prompt). */
  | 'no-permission'
  /** Turned off on this device on purpose: never re-enabled by itself. */
  | 'off'
  /** The browser has no subscription. */
  | 'none'
  /** The browser does not say which key its subscription was made with: left alone. */
  | 'unknown-key'
  /** The browser's subscription was made with another VAPID key: off until Enable. */
  | 'other-key'
  /** The server already stores this subscription. */
  | 'in-sync'
  /** The browser's subscription is to be sent to the server. */
  | 'restore';

/** The browser's subscription as {@link pushRestoreState} needs it. */
export interface BrowserSubscription {
  readonly input: PushSubscriptionInput | null;
  /** Its `options.applicationServerKey` (`null` when the browser does not say). */
  readonly key: Uint8Array | null;
}

/** What {@link pushRestoreState} decides from. */
export interface PushRestoreFacts {
  readonly view: DeviceSelfView;
  readonly permission: 'default' | 'granted' | 'denied';
  readonly turnedOff: boolean;
  readonly subscription: BrowserSubscription | null;
}

/** Whether to restore (see the module's rules). */
export function pushRestoreState(facts: PushRestoreFacts): PushRestoreState {
  const { view, subscription } = facts;
  if (!view.device || !view.vapidPublicKey) return 'unavailable';
  if (facts.permission !== 'granted') return 'no-permission';
  if (facts.turnedOff) return 'off';
  if (!subscription?.input) return 'none';
  if (!subscription.key) return 'unknown-key';
  if (!sameKey(subscription.key, vapidKeyBytes(view.vapidPublicKey))) return 'other-key';
  if (view.pushEndpoint === subscription.input.endpoint) return 'in-sync';
  return 'restore';
}

/** What {@link restorePush} reads and does (passed in, so tests run in Node). */
export interface PushRestoreHost {
  /** `Notification.permission` (`default` without the API). */
  permission(): 'default' | 'granted' | 'denied';
  /** The {@link PUSH_OFF_KEY} marker is set. */
  turnedOff(): boolean;
  /** The service worker's current subscription (`pushManager.getSubscription()`), never a new one. */
  subscription(): Promise<BrowserSubscription | null>;
  deviceSelf(): Promise<DeviceSelfView>;
  /** `PUT /api/device/push` with the subscription only (the server keeps or defaults the toggles). */
  save(subscription: PushSubscriptionInput): Promise<DeviceSelfView>;
}

/** What {@link restorePush} did: the state, and the device's view after it (`null` when not read). */
export interface PushRestoreResult {
  readonly state: PushRestoreState;
  readonly view: DeviceSelfView | null;
}

/** Restores the device's subscription when {@link pushRestoreState} says so. */
export async function restorePush(host: PushRestoreHost): Promise<PushRestoreResult> {
  const permission = host.permission();
  // Nothing to restore without the permission: spare the requests.
  if (permission !== 'granted') return { state: 'no-permission', view: null };
  const view = await host.deviceSelf();
  if (!view.device || !view.vapidPublicKey) return { state: 'unavailable', view };
  const subscription = await host.subscription();
  const state = pushRestoreState({ view, permission, turnedOff: host.turnedOff(), subscription });
  if (state !== 'restore' || !subscription?.input) return { state, view };
  return { state, view: await host.save(subscription.input) };
}
