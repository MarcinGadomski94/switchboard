import type { PushPayload, PushSubscriptionInput } from '../../../core/devices.ts';
import { type VapidKeys, encryptPayload, vapidAuthorization } from './crypto.ts';

/**
 * D73: delivering one Web Push message (`docs/devices.md` → *Notifications*,
 * `PRIVACY.md`): an encrypted POST to the subscription's endpoint at the browser
 * vendor's push service. Only endpoints of the known push services are accepted
 * (no request to an arbitrary host a device names: no SSRF through a subscription).
 */

/**
 * Host suffixes of the push services browsers use: Apple (Safari / iOS / iPadOS),
 * Google (Chrome / Android, FCM), Mozilla (Firefox) and Microsoft (Edge, WNS).
 */
export const PUSH_SERVICE_HOSTS: readonly string[] = ['.push.apple.com', 'fcm.googleapis.com', 'android.googleapis.com', '.push.services.mozilla.com', '.notify.windows.com'];

/** The VAPID contact (`sub`): the project's page (no personal address). */
export const VAPID_SUBJECT = 'https://github.com/MarcinGadomski94/switchboard';

/** How long a push service keeps an undelivered message (seconds): an hour (a later state supersedes it anyway). */
export const PUSH_TTL_S = 60 * 60;

/** Time limit of one delivery. */
export const PUSH_TIMEOUT_MS = 10_000;

/**
 * `true` when `endpoint` is an `https:` URL on one of {@link PUSH_SERVICE_HOSTS}
 * (default port, no credentials); tests add exact origins (`testOrigins`,
 * `SWITCHBOARD_PUSH_TEST_ENDPOINTS`).
 */
export function isAllowedPushEndpoint(endpoint: string, testOrigins: readonly string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (testOrigins.includes(url.origin)) return true;
  if (url.protocol !== 'https:' || url.port !== '') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((suffix) => (suffix.startsWith('.') ? host.endsWith(suffix) && host.length > suffix.length : host === suffix));
}

/** `true` for a usable browser subscription (allowed endpoint, 65-byte p256dh, 16-byte auth). */
export function validSubscription(value: unknown, testOrigins: readonly string[] = []): value is PushSubscriptionInput {
  if (typeof value !== 'object' || value === null) return false;
  const { endpoint, keys } = value as Record<string, unknown>;
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || !isAllowedPushEndpoint(endpoint, testOrigins)) return false;
  if (typeof keys !== 'object' || keys === null) return false;
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return false;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(auth)) return false;
  const point = Buffer.from(p256dh, 'base64url');
  return point.length === 65 && point[0] === 0x04 && Buffer.from(auth, 'base64url').length === 16;
}

/** How a delivery ended. */
export type PushOutcome = { readonly ok: true } | { readonly ok: false; readonly gone: boolean; readonly status: number; readonly error: string };

/** Options of {@link sendPush}. */
export interface SendPushOptions {
  readonly vapid: VapidKeys;
  /** `high` for what waits on the developer (permission, question), `normal` otherwise. */
  readonly urgency?: 'high' | 'normal';
  /** Replaces a not-yet-delivered message with the same topic at the push service (≤ 32 base64url characters). */
  readonly topic?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** Encrypts and POSTs `payload`; 404 / 410 mean the subscription is gone (the caller removes it). */
export async function sendPush(subscription: PushSubscriptionInput, payload: PushPayload, options: SendPushOptions): Promise<PushOutcome> {
  const doFetch = options.fetch ?? fetch;
  const body = encryptPayload(Buffer.from(JSON.stringify(payload), 'utf8'), subscription.keys.p256dh, subscription.keys.auth);
  const headers: Record<string, string> = {
    authorization: vapidAuthorization(options.vapid, subscription.endpoint, VAPID_SUBJECT, options.now?.() ?? Date.now()),
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(PUSH_TTL_S),
    urgency: options.urgency ?? 'normal',
  };
  if (options.topic && /^[A-Za-z0-9_-]{1,32}$/.test(options.topic)) headers['topic'] = options.topic;
  try {
    const response = await doFetch(subscription.endpoint, { method: 'POST', headers, body: new Uint8Array(body), redirect: 'error', signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
    // Drain the body (a short text at most) so the connection is reused or closed.
    const text = (await response.text().catch(() => '')).slice(0, 200);
    if (response.ok) return { ok: true };
    return { ok: false, gone: response.status === 404 || response.status === 410, status: response.status, error: text || `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, gone: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}
