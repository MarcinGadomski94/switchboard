/**
 * D73 "Devices" (`docs/devices.md`): phones and tablets paired with this
 * Switchboard, reaching it over Tailscale through `tailscale serve` (HTTPS) and a
 * second loopback listener dedicated to devices. Wire types and pure helpers
 * shared by the server and the UI.
 */

/** Default loopback port of the device listener (the main UI is 13001, the peer listener 13002). */
export const DEFAULT_DEVICE_PORT = 13003;

/**
 * Default HTTPS port `tailscale serve` publishes the device listener on. Tailscale
 * serves HTTPS on 443, 8443 or 10000 only; 8443 leaves a 443 the developer may
 * already serve something else on untouched (ASSUMED D73-https-port).
 */
export const DEFAULT_DEVICE_HTTPS_PORT = 8443;

/** The HTTPS ports `tailscale serve` accepts. */
export const SERVE_HTTPS_PORTS: readonly number[] = [443, 8443, 10000];

/** How long a device pairing code lives (10 minutes). */
export const DEVICE_CODE_TTL_MS = 10 * 60_000;

/** A device pairing code is burned after this many wrong tries. */
export const DEVICE_CODE_MAX_FAILURES = 5;

/** Pairing attempts the device listener takes per {@link DEVICE_PAIR_WINDOW_MS}, from anyone (then 429). */
export const DEVICE_PAIR_MAX_ATTEMPTS = 10;

/** The window of {@link DEVICE_PAIR_MAX_ATTEMPTS}. */
export const DEVICE_PAIR_WINDOW_MS = 10 * 60_000;

/** Longest device name. */
export const DEVICE_NAME_MAX = 40;

/** What a device can be notified about (per-device toggles). */
export const PUSH_EVENT_KINDS = ['permission', 'questions', 'turnFinished', 'errors', 'inbox', 'review'] as const;

/** One push event kind. */
export type PushEventKind = (typeof PUSH_EVENT_KINDS)[number];

/** A device's push toggles. */
export type PushEvents = { readonly [K in PushEventKind]: boolean };

/** Every toggle on (the default when a device enables notifications). */
export const DEFAULT_PUSH_EVENTS: PushEvents = { permission: true, questions: true, turnFinished: true, errors: true, inbox: true, review: true };

/** Labels of the toggles (UI). */
export const PUSH_EVENT_LABELS: { readonly [K in PushEventKind]: string } = {
  permission: 'Permission requests',
  questions: 'Questions',
  turnFinished: 'Turn finished',
  errors: 'Session errors',
  inbox: 'Other Inbox items',
  // D79: a new Review card.
  review: 'Ready for review',
};

/** A paired device as the UI sees it (`GET /api/devices`). Never a credential. */
export interface Device {
  readonly id: string;
  readonly name: string;
  /** The browser's user agent at pairing (shown shortened). */
  readonly userAgent: string | null;
  readonly pairedAt: string;
  readonly lastSeenAt: string | null;
  /** Notifications are switched on for it (a push subscription is stored). */
  readonly push: boolean;
}

/** Why device access over HTTPS is not available, or `ok`. */
export type DeviceHttpsState = 'ok' | 'off' | 'no-tailscale' | 'no-https' | 'serve-failed' | 'port-busy';

/** The device access switch and what it does now (`GET /api/devices` → `access`). */
export interface DeviceAccessState {
  /** The switch (off by default). */
  readonly enabled: boolean;
  /** The loopback port of the device listener. */
  readonly port: number;
  /** The HTTPS port `tailscale serve` publishes it on. */
  readonly httpsPort: number;
  /** `127.0.0.1:<port>` while the device listener runs, else `null`. */
  readonly listening: string | null;
  /** The devices' origin (`https://<machine>.<tailnet>.ts.net:8443`) once known, else `null`. */
  readonly origin: string | null;
  readonly https: DeviceHttpsState;
  /** What is wrong and what to enable, when {@link https} is not `ok` / `off`. */
  readonly message: string | null;
  /** A Tailscale page the developer has to open (e.g. to enable Serve on the tailnet), when the CLI named one. */
  readonly actionUrl: string | null;
}

/** Body of `PUT /api/devices/access`. */
export interface DeviceAccessInput {
  readonly enabled?: boolean;
  readonly port?: number;
  readonly httpsPort?: number;
}

/** A pairing code shown on the desktop (`POST /api/devices/pairing`). */
export interface DevicePairingCode {
  readonly code: string;
  readonly expiresAt: string;
  /** What the QR code encodes: `<origin>/pair#code=<code>`. */
  readonly url: string;
}

/** `GET /api/devices` (local only). */
export interface DevicesView {
  readonly access: DeviceAccessState;
  readonly devices: readonly Device[];
}

/** `GET /api/device`: who is asking. */
export interface DeviceSelfView {
  /** The paired device making the request; `null` on this machine's own UI. */
  readonly device: Device | null;
  /** The VAPID public key (base64url) the browser subscribes with; `null` while device access is off. */
  readonly vapidPublicKey: string | null;
  /** This device's push toggles (defaults while it has no subscription). */
  readonly events: PushEvents;
}

/** A browser `PushSubscription` as JSON (`PushSubscription.toJSON()`). */
export interface PushSubscriptionInput {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

/** Body of `PUT /api/device/push`: a subscription and / or toggles. */
export interface DevicePushInput {
  readonly subscription?: PushSubscriptionInput;
  readonly events?: Partial<PushEvents>;
}

/** What a push message carries (encrypted, RFC 8291): short on purpose. */
export interface PushPayload {
  readonly title: string;
  readonly body: string;
  /** Path to open on a click (`/sessions/<id>`, `/inbox`). */
  readonly url: string;
  /** Replaces an earlier notification with the same tag. */
  readonly tag: string;
  readonly kind: PushEventKind | 'test';
  /**
   * D87: this happening's id (the `/hub` `notice` carries the same one), so a page
   * that gets it both from the hub and from its service worker shows one toast.
   * Absent on the test notification.
   */
  readonly id?: string;
}

/**
 * D87 (`docs/devices.md` → *No notifications while Switchboard is open*): the
 * `/hub` `notice` event: a happening that is push-worthy (what {@link PushPayload}
 * carries, with its id). Open pages of a paired device show it as a toast (when
 * that device's toggle for the kind is on), because a device with Switchboard
 * open in front gets no system notification for it.
 */
export interface DeviceNotice extends PushPayload {
  readonly kind: PushEventKind;
  readonly id: string;
}

/** D87: a visible page reports itself at least this often (`PUT /api/device/presence`). */
export const PRESENCE_HEARTBEAT_MS = 30_000;

/** D87: a page whose last report is older than this counts as not visible (its heartbeat lapsed). */
export const PRESENCE_LAPSE_MS = 75_000;

/** D87: body of `PUT /api/device/presence`: one open page of this device and whether it is in front. */
export interface DevicePresenceInput {
  /** The page's own id (random per page load; the same one its `/hub?client=` stream names). */
  readonly client: string;
  /** `document.visibilityState === 'visible'`. */
  readonly visible: boolean;
  /** `document.hasFocus()` (recorded; not needed for "open in front"). */
  readonly focused?: boolean;
}

/** D87: `true` for a usable page id (8–64 characters of `A–Z a–z 0–9 _ -`). */
export function validPresenceClient(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}

/** Longest notification body. */
export const PUSH_BODY_MAX = 140;

/** `text` cut to `max` characters (an ellipsis when cut), whitespace collapsed. */
export function shortText(text: string, max: number = PUSH_BODY_MAX): string {
  const plain = text.replace(/\s+/g, ' ').trim();
  return plain.length <= max ? plain : `${plain.slice(0, max - 1).trimEnd()}…`;
}

/** A device name (trimmed, 1–{@link DEVICE_NAME_MAX} characters), `null` when unusable. */
export function cleanDeviceName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length === 0 || text.length > DEVICE_NAME_MAX) return null;
  return text;
}

/** A readable default name from a user agent: `iPhone · Safari`, `Android · Chrome`, `iPad`, else `Device`. */
export function deviceNameFromUserAgent(userAgent: string | null | undefined): string {
  const ua = userAgent ?? '';
  let platform = 'Device';
  if (/iPhone/i.test(ua)) platform = 'iPhone';
  else if (/iPad/i.test(ua)) platform = 'iPad';
  else if (/Android/i.test(ua)) platform = /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
  else if (/Macintosh/i.test(ua)) platform = 'Mac';
  else if (/Windows/i.test(ua)) platform = 'Windows';
  else if (/Linux/i.test(ua)) platform = 'Linux';
  let browser: string | null = null;
  if (/EdgA?\//.test(ua)) browser = 'Edge';
  else if (/Firefox|FxiOS/.test(ua)) browser = 'Firefox';
  else if (/CriOS|Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  return browser ? `${platform} · ${browser}` : platform;
}

/** Normalizes a push toggles patch over `base`; `null` when a value is not a boolean. */
export function mergePushEvents(base: PushEvents, patch: unknown): PushEvents | null {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return null;
  const next: Record<PushEventKind, boolean> = { ...base };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!(PUSH_EVENT_KINDS as readonly string[]).includes(key)) return null;
    if (typeof value !== 'boolean') return null;
    next[key as PushEventKind] = value;
  }
  return next;
}

/** Reads stored toggles leniently (missing keys = on). */
export function readPushEvents(value: unknown): PushEvents {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const next: Record<PushEventKind, boolean> = { ...DEFAULT_PUSH_EVENTS };
  for (const kind of PUSH_EVENT_KINDS) if (typeof record[kind] === 'boolean') next[kind] = record[kind] as boolean;
  return next;
}
