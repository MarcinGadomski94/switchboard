import type { RepoContext } from '../context.ts';
import { Table, type TableSpec } from '../table.ts';

/**
 * D73 (migration 0030, `docs/devices.md`): paired devices, their one-time pairing
 * codes and their Web Push subscriptions. Credentials and codes are stored as
 * sha256 hashes only; nothing here is ever sent to the UI as it is stored.
 */

/** A paired device. */
export interface DeviceRecord {
  readonly id: string;
  readonly name: string;
  readonly userAgent: string | null;
  /** sha256 (base64url) of the device credential's secret. */
  readonly credentialHash: string;
  /** `Tailscale-User-Login` at pairing, when `tailscale serve` sent one. */
  readonly tailscaleLogin: string | null;
  readonly pairedAt: string;
  readonly lastSeenAt: string | null;
  /** D165 (0055): the user profile the phone works in (its lists, its pushes); `'default'` for phones paired before. */
  readonly userProfileId?: string;
  /** D189 (0063): the shared record's hybrid clock ('' before D189). */
  readonly clock?: string;
  /** D189: the machine id of the computer it was paired on; `null` = this one. */
  readonly pairedOn?: string | null;
  /** D189: `true` when the phone holds a credential of this computer (else it is known only through a paired one). */
  readonly setUpHere?: boolean;
}

/** D189: a revoked phone (kept so the revoke reaches every paired computer). */
export interface DeviceTombstoneRecord {
  readonly id: string;
  readonly clock: string;
  readonly revokedAt: string;
}

/** A one-time pairing code (hash only). */
export interface DevicePairingCodeRecord {
  readonly id: string;
  readonly codeHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly failures: number;
}

/** A device's push subscription and toggles. */
export interface DevicePushRecord {
  readonly deviceId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  /** The toggles (JSON object). */
  readonly events: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastError: string | null;
}

const DEVICES: TableSpec<DeviceRecord> = {
  table: 'devices',
  key: 'id',
  fields: {
    id: ['id', 'text'],
    name: ['name', 'text'],
    userAgent: ['user_agent', 'text'],
    credentialHash: ['credential_hash', 'text'],
    tailscaleLogin: ['tailscale_login', 'text'],
    pairedAt: ['paired_at', 'text'],
    lastSeenAt: ['last_seen_at', 'text'],
    userProfileId: ['user_profile_id', 'text'],
    clock: ['clock', 'text'],
    pairedOn: ['paired_on', 'text'],
    setUpHere: ['set_up_here', 'bool'],
  },
};

const TOMBSTONES: TableSpec<DeviceTombstoneRecord> = {
  table: 'device_tombstones',
  key: 'id',
  fields: {
    id: ['id', 'text'],
    clock: ['clock', 'text'],
    revokedAt: ['revoked_at', 'text'],
  },
};

const CODES: TableSpec<DevicePairingCodeRecord> = {
  table: 'device_pairing_codes',
  key: 'id',
  fields: {
    id: ['id', 'text'],
    codeHash: ['code_hash', 'text'],
    createdAt: ['created_at', 'text'],
    expiresAt: ['expires_at', 'text'],
    failures: ['failures', 'int'],
  },
};

const PUSH: TableSpec<DevicePushRecord> = {
  table: 'device_push_subscriptions',
  key: 'deviceId',
  fields: {
    deviceId: ['device_id', 'text'],
    endpoint: ['endpoint', 'text'],
    p256dh: ['p256dh', 'text'],
    auth: ['auth', 'text'],
    events: ['events', 'json'],
    createdAt: ['created_at', 'text'],
    updatedAt: ['updated_at', 'text'],
    lastError: ['last_error', 'text'],
  },
};

/** The D73 tables. */
export class DeviceRepository {
  readonly #ctx: RepoContext;
  readonly #devices: Table<DeviceRecord>;
  readonly #codes: Table<DevicePairingCodeRecord>;
  readonly #push: Table<DevicePushRecord>;
  readonly #tombstones: Table<DeviceTombstoneRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#devices = new Table(ctx.db, DEVICES);
    this.#tombstones = new Table(ctx.db, TOMBSTONES);
    this.#codes = new Table(ctx.db, CODES);
    this.#push = new Table(ctx.db, PUSH);
  }

  // ── devices ──────────────────────────────────────────────────────────

  /** Every paired device, oldest pairing first. */
  async list(): Promise<DeviceRecord[]> {
    return this.#devices.select('', [], 'paired_at, id');
  }

  async get(id: string): Promise<DeviceRecord | null> {
    return this.#devices.get(id);
  }

  /** Stores a new pairing. */
  async create(input: Pick<DeviceRecord, 'id' | 'name' | 'credentialHash'> & Partial<Pick<DeviceRecord, 'userAgent' | 'tailscaleLogin' | 'clock'>>): Promise<DeviceRecord> {
    return this.#devices.insert({ ...input, userAgent: input.userAgent ?? null, tailscaleLogin: input.tailscaleLogin ?? null, pairedAt: this.#ctx.now(), clock: input.clock ?? '', pairedOn: null, setUpHere: true });
  }

  /**
   * D189: stores a phone a paired computer shared (new here: `setUpHere` false with an unusable
   * `credentialHash` placeholder; known: its shared fields and clock, its credential kept).
   */
  async upsertShared(input: Pick<DeviceRecord, 'id' | 'name' | 'userAgent' | 'tailscaleLogin' | 'pairedAt' | 'userProfileId' | 'clock' | 'pairedOn'> & { readonly placeholderHash: string }): Promise<DeviceRecord> {
    const existing = this.#devices.get(input.id);
    const shared = { name: input.name, userAgent: input.userAgent, tailscaleLogin: input.tailscaleLogin, userProfileId: input.userProfileId ?? 'default', clock: input.clock ?? '' };
    if (existing) return this.#devices.update(input.id, shared) ?? existing;
    return this.#devices.insert({ id: input.id, ...shared, credentialHash: input.placeholderHash, pairedAt: input.pairedAt, lastSeenAt: null, pairedOn: input.pairedOn ?? null, setUpHere: false });
  }

  /** D189: the phone's credential of this computer (a handover set it up here). */
  async setCredential(id: string, credentialHash: string): Promise<DeviceRecord | null> {
    return this.#devices.update(id, { credentialHash, setUpHere: true });
  }

  /** D189: a new clock on the shared record (a rename or a profile change here). */
  async setClock(id: string, clock: string): Promise<void> {
    this.#devices.update(id, { clock });
  }

  /** D189: every revoked phone. */
  async tombstones(): Promise<DeviceTombstoneRecord[]> {
    return this.#tombstones.select('', [], 'revoked_at, id');
  }

  async tombstone(id: string): Promise<DeviceTombstoneRecord | null> {
    return this.#tombstones.get(id);
  }

  /** D189: records a revoke (kept, so it reaches every paired computer). */
  async addTombstone(input: DeviceTombstoneRecord): Promise<void> {
    if (this.#tombstones.get(input.id)) return;
    this.#tombstones.insert(input);
  }

  async rename(id: string, name: string): Promise<DeviceRecord | null> {
    return this.#devices.update(id, { name });
  }

  /** D165: the phone's profile. */
  async setUserProfile(id: string, userProfileId: string): Promise<DeviceRecord | null> {
    return this.#devices.update(id, { userProfileId });
  }

  /** D165: moves every phone of a deleted profile to Default. */
  async resetUserProfile(userProfileId: string, to: string): Promise<void> {
    this.#ctx.db.prepare('UPDATE devices SET user_profile_id = ? WHERE user_profile_id = ?').run(to, userProfileId);
  }

  /** Records that the device was seen now. */
  async touch(id: string): Promise<void> {
    this.#devices.update(id, { lastSeenAt: this.#ctx.now() });
  }

  /** Revokes the device (its credential stops working at once; its subscription goes with it). */
  async delete(id: string): Promise<boolean> {
    return this.#devices.delete(id);
  }

  // ── pairing codes ────────────────────────────────────────────────────

  /** Stores a new code and drops every other one (one code at a time). */
  async replaceCode(input: Pick<DevicePairingCodeRecord, 'id' | 'codeHash' | 'expiresAt'>): Promise<DevicePairingCodeRecord> {
    this.#ctx.db.prepare('DELETE FROM device_pairing_codes').run();
    return this.#codes.insert({ ...input, failures: 0, createdAt: this.#ctx.now() });
  }

  /** The waiting code, if any (expired ones included: the caller decides). */
  async currentCode(): Promise<DevicePairingCodeRecord | null> {
    return this.#codes.first('', [], 'created_at DESC');
  }

  async setCodeFailures(id: string, failures: number): Promise<void> {
    this.#codes.update(id, { failures });
  }

  /** Drops every pairing code. */
  async clearCodes(): Promise<void> {
    this.#ctx.db.prepare('DELETE FROM device_pairing_codes').run();
  }

  // ── push subscriptions ───────────────────────────────────────────────

  async push(deviceId: string): Promise<DevicePushRecord | null> {
    return this.#push.get(deviceId);
  }

  async pushList(): Promise<DevicePushRecord[]> {
    return this.#push.select('', [], 'created_at, device_id');
  }

  /** Stores (or replaces) a device's subscription. */
  async savePush(input: Pick<DevicePushRecord, 'deviceId' | 'endpoint' | 'p256dh' | 'auth' | 'events'>): Promise<DevicePushRecord> {
    const now = this.#ctx.now();
    const existing = this.#push.get(input.deviceId);
    if (existing) return this.#push.update(input.deviceId, { ...input, updatedAt: now, lastError: null }) ?? existing;
    return this.#push.insert({ ...input, createdAt: now, updatedAt: now, lastError: null });
  }

  /** Changes a stored subscription's toggles. */
  async setPushEvents(deviceId: string, events: unknown): Promise<DevicePushRecord | null> {
    return this.#push.update(deviceId, { events, updatedAt: this.#ctx.now() });
  }

  async setPushError(deviceId: string, lastError: string | null): Promise<void> {
    this.#push.update(deviceId, { lastError });
  }

  async deletePush(deviceId: string): Promise<boolean> {
    return this.#push.delete(deviceId);
  }
}
