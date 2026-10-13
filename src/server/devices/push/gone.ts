import { createHash } from 'node:crypto';

/**
 * D73 follow-up, 2026-10-13 (`docs/devices.md` → *Restoring the subscription*):
 * the push endpoints the push service answered 404 / 410 for. Such an endpoint is
 * dead for good, but a browser may still hold its subscription and send it back
 * (the restore at start / when visible), so Switchboard remembers it and refuses
 * it from then on (409 `push-gone`); Enable then subscribes anew (a new endpoint).
 *
 * Kept in ONE settings row ({@link PUSH_GONE_SETTING}), not per device: re-pairing
 * makes a new device record, while the dead subscription stays in the same
 * browser. Only the sha256 of each endpoint is stored (an endpoint is a bearer
 * address for pushing to that browser). At most {@link PUSH_GONE_MAX} entries,
 * each forgotten after {@link PUSH_GONE_TTL_MS}.
 */

/** Settings key of the remembered gone endpoints. */
export const PUSH_GONE_SETTING = 'devices.push.gone';

/** At most this many gone endpoints are remembered (the newest win). */
export const PUSH_GONE_MAX = 200;

/** A gone endpoint is forgotten after this long (90 days). */
export const PUSH_GONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** One remembered endpoint: its sha256 (hex) and when it was reported gone (ISO). */
export interface GoneEndpoint {
  readonly hash: string;
  readonly at: string;
}

/** The sha256 (hex) of an endpoint, as remembered. */
export function hashEndpoint(endpoint: string): string {
  return createHash('sha256').update(endpoint, 'utf8').digest('hex');
}

/** The stored value as a list, without malformed or expired entries (oldest first). */
export function readGoneEndpoints(value: unknown, now: number): GoneEndpoint[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is GoneEndpoint =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as GoneEndpoint).hash === 'string' &&
      /^[0-9a-f]{64}$/.test((entry as GoneEndpoint).hash) &&
      typeof (entry as GoneEndpoint).at === 'string' &&
      now - Date.parse((entry as GoneEndpoint).at) < PUSH_GONE_TTL_MS,
  );
}

/** The list with `endpoint` added as gone at `now` (moved to the end if already there), capped and pruned. */
export function addGoneEndpoint(value: unknown, endpoint: string, now: number): GoneEndpoint[] {
  const hash = hashEndpoint(endpoint);
  const kept = readGoneEndpoints(value, now).filter((entry) => entry.hash !== hash);
  kept.push({ hash, at: new Date(now).toISOString() });
  return kept.slice(-PUSH_GONE_MAX);
}

/** `true` when `endpoint` is remembered as gone (and not expired). */
export function isGoneEndpoint(value: unknown, endpoint: string, now: number): boolean {
  const hash = hashEndpoint(endpoint);
  return readGoneEndpoints(value, now).some((entry) => entry.hash === hash);
}
