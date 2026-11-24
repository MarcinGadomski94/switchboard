import { isClock } from './hlc.ts';
import { isMachineId } from './peers.ts';

/**
 * D189 · a phone paired on one computer works on every paired computer
 * (`docs/devices.md` → *One pairing for all your computers*, `docs/security.md` → *Device
 * handover*). The paired computers share **who the phones are**, never how they sign in:
 *
 * - a device record ({@link SharedDevice}): its id, name, user agent, Tailscale login, profile
 *   (a peer-link id, D172), when and on which computer it was paired, and a hybrid clock;
 * - a revoke ({@link DeviceTombstone}): the device's id and the revoke's clock. A revoke always
 *   wins over a record (a revoked phone never comes back through a sync).
 *
 * No credential and no credential hash is ever in the exchange: each computer gives the phone its
 * own credential (its own cookie on its own origin) when the phone is handed over to it.
 */

/** Wire version of the device exchange. */
export const DEVICES_SYNC_VERSION = 1;

/** A handover token lives this long (ms): minted on one computer, redeemed on the other. */
export const HANDOVER_TTL_MS = 60_000;

/** At most this many devices / tombstones in one exchange (the sender sends its newest; a reader keeps the first this many). */
export const DEVICES_SYNC_MAX = 200;

/** A revoke is kept this long (ms), then forgotten (the phone is long gone everywhere). */
export const DEVICE_TOMBSTONE_KEEP_MS = 90 * 24 * 3_600_000;

/** A profile id as it may travel (a peer-link id: letters, digits, `-`; never a pattern such as `*`). */
export const DEVICE_PROFILE_ID = /^[A-Za-z0-9-]{1,64}$/;

/** One phone as the paired computers share it (no credential). */
export interface SharedDevice {
  readonly id: string;
  readonly name: string;
  readonly userAgent: string | null;
  /** `Tailscale-User-Login` at pairing (each computer still checks it on every request). */
  readonly tailscaleLogin: string | null;
  /** The profile, as a peer-link id (D172: a computer's own Default goes as its link id). */
  readonly userProfileId: string;
  readonly pairedAt: string;
  /** The machine id of the computer it was paired on. */
  readonly pairedOn: string;
  readonly clock: string;
}

/** A revoked phone. */
export interface DeviceTombstone {
  readonly id: string;
  readonly clock: string;
  readonly revokedAt: string;
}

/** The exchange's body, both ways. */
export interface DevicesWire {
  readonly v: typeof DEVICES_SYNC_VERSION;
  /** The sender's device origin (`https://<name>.ts.net[:port]`) while its device access works, else `null`. */
  readonly origin: string | null;
  readonly devices: readonly SharedDevice[];
  readonly tombstones: readonly DeviceTombstone[];
  /** The phones that have this sender's own credential (they switched there, or were paired there). Absent before the review fix: none. */
  readonly setUp?: readonly string[];
}

const DEVICE_ID = /^[a-z2-7]{12}$/;

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

/** Where a device origin may point: a `tailscale serve` name (`https://<machine>.<tailnet>.ts.net[:port]`). */
const TS_NET_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/i;

/**
 * A device origin as a computer may announce it: `https://<name>.ts.net[:port]` (the shape
 * `tailscale serve` gives), nothing else; plain `http` on loopback only with `allowLoopback` (the
 * test servers' `SWITCHBOARD_DEVICE_TEST_ORIGIN`).
 */
export function readDeviceOrigin(value: unknown, allowLoopback = false): string | null {
  if (typeof value !== 'string' || value.length > 300) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // The test servers' device origin is plain http on loopback (`deviceTestOrigin`); everything real is https.
  const loopback = allowLoopback && url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (!loopback && !(url.protocol === 'https:' && TS_NET_HOST.test(url.hostname))) return null;
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
  return url.origin;
}

function readDevice(raw: unknown): SharedDevice | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const d = raw as Record<string, unknown>;
  const id = typeof d['id'] === 'string' && DEVICE_ID.test(d['id']) ? d['id'] : null;
  const name = str(d['name'], 40);
  const pairedAt = str(d['pairedAt'], 40);
  const pairedOn = isMachineId(d['pairedOn']) ? d['pairedOn'] : null;
  const userProfileId = typeof d['userProfileId'] === 'string' && DEVICE_PROFILE_ID.test(d['userProfileId']) ? d['userProfileId'] : null;
  if (!id || !name || !pairedAt || !pairedOn || !userProfileId || !isClock(d['clock'])) return null;
  return {
    id,
    name,
    userAgent: str(d['userAgent'], 400),
    tailscaleLogin: str(d['tailscaleLogin'], 200),
    userProfileId,
    pairedAt,
    pairedOn,
    clock: d['clock'] as string,
  };
}

function readTombstone(raw: unknown): DeviceTombstone | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = raw as Record<string, unknown>;
  const id = typeof t['id'] === 'string' && DEVICE_ID.test(t['id']) ? t['id'] : null;
  const revokedAt = str(t['revokedAt'], 40);
  if (!id || !revokedAt || !isClock(t['clock'])) return null;
  return { id, clock: t['clock'] as string, revokedAt };
}

/**
 * Reads an exchange body (`null` when it is not one); malformed entries are left out, and past
 * {@link DEVICES_SYNC_MAX} of each kind the rest is (never the whole body: a long list of revokes
 * must not stop the sync).
 */
export function readDevicesWire(body: unknown, allowLoopback = false): DevicesWire | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b['v'] !== DEVICES_SYNC_VERSION || !Array.isArray(b['devices']) || !Array.isArray(b['tombstones'])) return null;
  const setUp = Array.isArray(b['setUp']) ? b['setUp'].slice(0, DEVICES_SYNC_MAX).filter((id): id is string => typeof id === 'string' && DEVICE_ID.test(id)) : [];
  return {
    v: DEVICES_SYNC_VERSION,
    origin: readDeviceOrigin(b['origin'], allowLoopback),
    devices: b['devices'].slice(0, DEVICES_SYNC_MAX).map(readDevice).filter((d): d is SharedDevice => d !== null),
    tombstones: b['tombstones'].slice(0, DEVICES_SYNC_MAX).map(readTombstone).filter((t): t is DeviceTombstone => t !== null),
    setUp,
  };
}

/** The revokes to send: the newest {@link DEVICES_SYNC_MAX}. */
export function newestTombstones<T extends { readonly revokedAt: string }>(tombstones: readonly T[]): T[] {
  return [...tombstones].sort((a, b) => (a.revokedAt < b.revokedAt ? 1 : a.revokedAt > b.revokedAt ? -1 : 0)).slice(0, DEVICES_SYNC_MAX);
}

/** What to do here with a paired computer's records. */
export interface DevicesMergePlan {
  /** Records to store (new here, or a later clock than this computer's copy). */
  readonly upserts: readonly SharedDevice[];
  /** Revokes to apply (the device goes here, its tombstone is kept). */
  readonly revokes: readonly DeviceTombstone[];
}

/**
 * The merge (pure): a revoke always wins (a device with a tombstone here or in the message is never
 * stored); otherwise the later clock wins per device (equal clocks: nothing changes). Only revokes of
 * phones known here are kept.
 */
export function planDevicesMerge(
  local: { readonly devices: ReadonlyMap<string, { readonly clock: string }>; readonly tombstones: ReadonlySet<string> },
  incoming: Pick<DevicesWire, 'devices' | 'tombstones'>,
): DevicesMergePlan {
  const revokedThere = new Set(incoming.tombstones.map((t) => t.id));
  // A revoke of a phone never known here is not kept (nothing to stop; and a sender cannot fill this table).
  const revokes = incoming.tombstones.filter((t) => !local.tombstones.has(t.id) && local.devices.has(t.id));
  const upserts: SharedDevice[] = [];
  for (const device of incoming.devices) {
    if (local.tombstones.has(device.id) || revokedThere.has(device.id)) continue;
    const mine = local.devices.get(device.id);
    if (mine && !(device.clock > mine.clock)) continue;
    upserts.push(device);
  }
  return { upserts, revokes };
}

/** A computer a phone can switch to (`GET /api/device/computers`). */
export interface DeviceComputer {
  readonly id: string;
  readonly name: string;
  /** Its device origin while phones can reach it, else `null`. */
  readonly origin: string | null;
  /** `true` for the computer answering. */
  readonly current: boolean;
  /** `false` for a computer on an older Switchboard (no D189 exchange: it does not know this phone). */
  readonly synced: boolean;
}
