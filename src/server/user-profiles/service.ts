import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Session } from '../../core/api.ts';
import { HybridClock } from '../../core/hlc.ts';
import {
  DEFAULT_USER_PROFILE_ID,
  type ProfileScope,
  USER_PROFILE_ACCOUNTS_SETTING,
  USER_PROFILE_COOKIE_MAX_AGE_S,
  USER_PROFILE_START_SETTING,
  USER_PROFILE_SWITCH_ATTEMPTS,
  USER_PROFILE_SWITCH_WINDOW_MS,
  type UserProfile,
  type UserProfileColor,
  profileOf,
  scopeSees,
  userProfileColor,
  userProfileName,
  userProfilePassword,
} from '../../core/user-profiles.ts';
import type { UserProfileRecord } from '../db/repos/user-profiles.ts';
import type { Store } from '../db/store.ts';
import type { HubBus } from '../hub/bus.ts';
import { readCookieValues } from '../security.ts';
import { hashPassword, isPasswordHash, verifyPassword } from './password.ts';

/** The signed cookie that carries a browser's active profile (`docs/profiles.md` → *Switching*). */
export const USER_PROFILE_COOKIE = 'sb_profile';


/** A refusal of the profile routes (status + code + a message for the UI). */
export class UserProfileError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'UserProfileError';
    this.status = status;
    this.code = code;
  }
}

/** A profile record as a paired computer receives it (the hash travels only peer-to-peer). */
export interface UserProfileWire {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly passwordHash: string | null;
  readonly clock: string;
  readonly createdAt: string;
  readonly deletedAt: string | null;
}

/** Options of {@link UserProfileService}. */
export interface UserProfileServiceOptions {
  readonly store: Store;
  readonly bus: HubBus;
  /** The install token: the HMAC key of the profile cookie (never sent anywhere). */
  readonly secret: string;
  /** The paired computers' last known sessions (open and archived), for a remote agent's profile. */
  readonly remoteSessions?: () => readonly Pick<Session, 'id' | 'userProfileId'>[];
  /** Archives (closes) a session the way the close route does (delete = archive its agents). */
  readonly archiveSession?: (sessionId: string) => Promise<void>;
  /** The profiles changed: the paired computers it syncs with get the records written. */
  readonly synced?: (records: readonly UserProfileWire[]) => void;
  readonly now?: () => number;
}

/**
 * D165 · the profiles (`docs/profiles.md`): their records, the password check, the signed profile
 * cookie, and the in-memory index of each session's profile that every scoped list and the hub
 * read synchronously.
 */
export class UserProfileService {
  readonly #o: UserProfileServiceOptions;
  readonly #now: () => number;
  /** `sessionId → profileId` for this computer's sessions (kept current by {@link noteSession}). */
  #sessions: Map<string, string> | null = null;
  /** Failed switch attempts per profile (times). */
  readonly #failures = new Map<string, number[]>();
  /** Profiles by id (a cache of the table; refreshed on every write). */
  #profiles: Map<string, UserProfileRecord> | null = null;
  readonly #hlc: HybridClock;

  constructor(options: UserProfileServiceOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#hlc = new HybridClock(randomUUID().slice(0, 8), this.#now);
  }

  /** D165: synchronous lookups the hub's per-profile filter needs (set by the app once Plans and Team exist). */
  hubLookups: { readonly planSession: (planId: string) => string | null; readonly teamProfile: (teamId: string) => string | null; readonly folderProfile: (folderId: string) => string | null } = {
    planSession: () => null,
    teamProfile: () => null,
    folderProfile: () => null,
  };

  // ── index ───────────────────────────────────────────────────────────────

  #index(): Map<string, string> {
    this.#sessions ??= this.#o.store.userProfiles.sessionProfiles();
    return this.#sessions;
  }

  async #records(): Promise<Map<string, UserProfileRecord>> {
    if (!this.#profiles) this.#profiles = new Map((await this.#o.store.userProfiles.list({ includeDeleted: true })).map((record) => [record.id, record]));
    return this.#profiles;
  }

  #invalidate(): void {
    this.#profiles = null;
  }

  /** A session's profile became known or changed (a new session, a move, a peer's update). */
  noteSession(sessionId: string, userProfileId: string | null | undefined): void {
    this.#index().set(sessionId, userProfileId || DEFAULT_USER_PROFILE_ID);
  }

  /**
   * The profile of a session, this computer's or a paired one's (`r~<machine>~<id>`, from its last
   * known list; an older computer's sessions and unknown ones are Default's).
   */
  profileOfSession(sessionId: string): string {
    if (sessionId.startsWith('r~')) {
      const remote = this.#o.remoteSessions?.().find((session) => session.id === sessionId);
      return profileOf(remote);
    }
    const own = this.#index().get(sessionId);
    if (own) return own;
    return DEFAULT_USER_PROFILE_ID;
  }

  /** Whether scope `scope` sees session `sessionId`. */
  sees(scope: ProfileScope, sessionId: string): boolean {
    return scopeSees(scope, this.profileOfSession(sessionId));
  }

  // ── profiles ────────────────────────────────────────────────────────────

  async #defaultAccounts(): Promise<Record<string, Record<string, string>>> {
    const stored = await this.#o.store.settings.get(USER_PROFILE_ACCOUNTS_SETTING);
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, Record<string, string>>) : {};
  }

  #view(record: UserProfileRecord, accounts: Record<string, Record<string, string>>): UserProfile {
    return { id: record.id, name: record.name, color: userProfileColor(record.color) ?? 'blue', hasPassword: record.passwordHash !== null, isDefault: record.id === DEFAULT_USER_PROFILE_ID, defaultAccounts: { ...(accounts[record.id] ?? {}) } };
  }

  /** The live profiles, Default first. */
  async list(): Promise<UserProfile[]> {
    const accounts = await this.#defaultAccounts();
    return [...(await this.#records()).values()].filter((record) => record.deletedAt === null).sort(order).map((record) => this.#view(record, accounts));
  }

  /** A live profile, else `null`. */
  async get(id: string): Promise<UserProfileRecord | null> {
    const record = (await this.#records()).get(id) ?? null;
    return record && record.deletedAt === null ? record : null;
  }

  async #changed(records: readonly UserProfileRecord[]): Promise<void> {
    this.#invalidate();
    this.#o.bus.publish('userProfilesChanged', { profiles: await this.list() });
    this.#o.synced?.(records.map(toWire));
  }

  /** `POST /api/user-profiles`: a new profile. */
  async create(body: unknown): Promise<UserProfile> {
    const input = isRecord(body) ? body : {};
    const name = userProfileName(input['name']);
    if (!name) throw new UserProfileError(422, 'invalid', 'Give the profile a name of 1–40 characters.');
    const color = input['color'] === undefined ? 'green' : userProfileColor(input['color']);
    if (!color) throw new UserProfileError(422, 'invalid', 'Pick one of the colours.');
    await this.#uniqueName(name, null);
    const password = input['password'] === undefined || input['password'] === null || input['password'] === '' ? null : userProfilePassword(input['password']);
    if (input['password'] && !password) throw new UserProfileError(422, 'invalid', 'A password is 4–200 characters.');
    const record = await this.#o.store.userProfiles.create({ id: randomUUID(), name, color, passwordHash: password ? await hashPassword(password) : null, clock: this.#clock() });
    await this.#changed([record]);
    return this.#view(record, await this.#defaultAccounts());
  }

  async #uniqueName(name: string, except: string | null): Promise<void> {
    for (const record of (await this.#records()).values()) {
      if (record.deletedAt === null && record.id !== except && record.name.toLowerCase() === name.toLowerCase()) throw new UserProfileError(409, 'name-taken', `A profile is already called “${record.name}”.`);
    }
  }

  #clock(): string {
    return this.#hlc.next();
  }

  /**
   * `PUT /api/user-profiles/{id}`: name, colour, password (`password` new, `currentPassword` the
   * old one when there is one; `password: null` removes it), default accounts (`{ <cli>: <id> | null }`).
   */
  async update(id: string, body: unknown): Promise<UserProfile> {
    const record = await this.get(id);
    if (!record) throw new UserProfileError(404, 'not-found', `no profile ${id}`);
    const input = isRecord(body) ? body : {};
    const patch: { name?: string; color?: UserProfileColor; passwordHash?: string | null } = {};
    if (input['name'] !== undefined) {
      const name = userProfileName(input['name']);
      if (!name) throw new UserProfileError(422, 'invalid', 'Give the profile a name of 1–40 characters.');
      await this.#uniqueName(name, id);
      patch.name = name;
    }
    if (input['color'] !== undefined) {
      const color = userProfileColor(input['color']);
      if (!color) throw new UserProfileError(422, 'invalid', 'Pick one of the colours.');
      patch.color = color;
    }
    if (input['password'] !== undefined) {
      // Changing or removing a password needs the current one (when it has one).
      if (record.passwordHash !== null) await this.#check(record, input['currentPassword']);
      if (input['password'] === null || input['password'] === '') patch.passwordHash = null;
      else {
        const password = userProfilePassword(input['password']);
        if (!password) throw new UserProfileError(422, 'invalid', 'A password is 4–200 characters.');
        patch.passwordHash = await hashPassword(password);
      }
    }
    if (input['defaultAccounts'] !== undefined) {
      const given = input['defaultAccounts'];
      if (!isRecord(given)) throw new UserProfileError(422, 'invalid', 'defaultAccounts must map a CLI to an account id.');
      const all = await this.#defaultAccounts();
      const mine: Record<string, string> = { ...(all[id] ?? {}) };
      for (const [cli, accountId] of Object.entries(given)) {
        if (accountId === null) delete mine[cli];
        else if (typeof accountId === 'string' && accountId !== '' && (await this.#o.store.profiles.get(accountId))?.cli === cli) mine[cli] = accountId;
        else throw new UserProfileError(422, 'invalid', `No ${cli} account ${String(accountId)}.`);
      }
      await this.#o.store.settings.set(USER_PROFILE_ACCOUNTS_SETTING, { ...all, [id]: mine });
    }
    let updated = record;
    if (Object.keys(patch).length > 0) updated = (await this.#o.store.userProfiles.update(id, { ...patch, clock: this.#clock() })) ?? record;
    await this.#changed(Object.keys(patch).length > 0 ? [updated] : []);
    return this.#view(updated, await this.#defaultAccounts());
  }

  /**
   * `DELETE /api/user-profiles/{id}`: archives the profile's open agents (the developer's ruling),
   * moves its phones and folders to Default, and leaves a tombstone. Default cannot go.
   */
  async remove(id: string, body: unknown): Promise<{ readonly archived: number; readonly failed: readonly string[] }> {
    if (id === DEFAULT_USER_PROFILE_ID) throw new UserProfileError(409, 'default', 'Default can’t be deleted.');
    const record = await this.get(id);
    if (!record) throw new UserProfileError(404, 'not-found', `no profile ${id}`);
    if (record.passwordHash !== null) await this.#check(record, isRecord(body) ? body['password'] : undefined);
    const failed: string[] = [];
    let archived = 0;
    const open = (await this.#o.store.sessions.list({ closed: false })).filter((session) => (session.userProfileId ?? DEFAULT_USER_PROFILE_ID) === id);
    for (const session of open) {
      try {
        await this.#o.archiveSession?.(session.id);
        archived += 1;
      } catch (error) {
        failed.push(`${session.title ?? session.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failed.length > 0) throw new UserProfileError(409, 'archive-failed', `Some agents could not be archived, so the profile stays: ${failed.join('; ')}`);
    await this.#o.store.devices.resetUserProfile(id, DEFAULT_USER_PROFILE_ID);
    this.#o.store.db.prepare('UPDATE sidebar_folders SET user_profile_id = ? WHERE user_profile_id = ?').run(DEFAULT_USER_PROFILE_ID, id);
    const all = await this.#defaultAccounts();
    if (all[id]) {
      const { [id]: _gone, ...rest } = all;
      await this.#o.store.settings.set(USER_PROFILE_ACCOUNTS_SETTING, rest);
    }
    const tomb = (await this.#o.store.userProfiles.update(id, { deletedAt: new Date(this.#now()).toISOString(), passwordHash: null, clock: this.#clock() })) ?? record;
    await this.#changed([tomb]);
    return { archived, failed };
  }

  // ── switching ───────────────────────────────────────────────────────────

  /** Throws 401 `wrong-password` / 429 `too-many-tries` unless `password` is the profile's. */
  async #check(record: UserProfileRecord, password: unknown): Promise<void> {
    if (record.passwordHash === null) return;
    const now = this.#now();
    const recent = (this.#failures.get(record.id) ?? []).filter((at) => now - at < USER_PROFILE_SWITCH_WINDOW_MS);
    if (recent.length >= USER_PROFILE_SWITCH_ATTEMPTS) throw new UserProfileError(429, 'too-many-tries', 'Too many wrong passwords. Wait a minute and try again.');
    const ok = typeof password === 'string' && password.length > 0 && password.length <= 400 && (await verifyPassword(password, record.passwordHash));
    if (!ok) {
      this.#failures.set(record.id, [...recent, now]);
      throw new UserProfileError(401, 'wrong-password', 'That password is not right.');
    }
    this.#failures.delete(record.id);
  }

  /** `POST /api/user-profiles/switch`: checks the password and answers the cookie that makes `id` this browser's profile. */
  async switchTo(body: unknown): Promise<{ readonly profile: UserProfile; readonly cookie: string }> {
    const input = isRecord(body) ? body : {};
    const id = typeof input['id'] === 'string' ? input['id'] : '';
    const record = await this.get(id);
    if (!record) throw new UserProfileError(404, 'not-found', `no profile ${id}`);
    await this.#check(record, input['password']);
    return { profile: this.#view(record, await this.#defaultAccounts()), cookie: this.cookieFor(record) };
  }

  /** The cookie value for `record`: `<id>.<password tag>.<hmac>` (a password change invalidates it). */
  cookieFor(record: Pick<UserProfileRecord, 'id' | 'passwordHash'>): string {
    const body = `${record.id}.${tagOf(record.passwordHash)}`;
    return `${body}.${createHmac('sha256', this.#o.secret).update(body).digest('base64url')}`;
  }

  /**
   * `Set-Cookie` for the cookie: HttpOnly, SameSite=Strict, kept 400 days (2026-11-16: a restart of
   * Switchboard or the browser keeps the browser in its profile, password or not; the cookie is bound
   * to the profile's password, so a new password still signs every browser out of it).
   */
  serializeCookie(value: string): string {
    return `${USER_PROFILE_COOKIE}=${value}; Path=/; Max-Age=${USER_PROFILE_COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Strict`;
  }

  /** 2026-11-16 · the profile a browser opens in before it chose one: the stored live profile, else Default. */
  async startProfileId(): Promise<string> {
    const stored = await this.#o.store.settings.get(USER_PROFILE_START_SETTING);
    if (typeof stored === 'string' && (await this.get(stored))) return stored;
    return DEFAULT_USER_PROFILE_ID;
  }

  /** 2026-11-16 · `PUT /api/user-profiles/start` `{ id }`: sets {@link startProfileId} (a live profile). */
  async setStartProfile(body: unknown): Promise<string> {
    const id = isRecord(body) && typeof body['id'] === 'string' ? body['id'] : '';
    if (!(await this.get(id))) throw new UserProfileError(404, 'not-found', 'No such profile.');
    await this.#o.store.settings.set(USER_PROFILE_START_SETTING, id);
    this.#o.bus.publish('userProfilesChanged', { profiles: await this.list() });
    return id;
  }

  /**
   * The profile a browser's cookies name, when one of them is valid now (signed by this install,
   * its profile live, its password unchanged since). Else the browser's profile is Default's while
   * Default has no password, and none (`null`: it must choose) when it has one.
   */
  async scopeOfCookies(cookieHeader: string | undefined): Promise<ProfileScope> {
    const records = await this.#records();
    for (const value of readCookieValues(cookieHeader, USER_PROFILE_COOKIE)) {
      const parts = value.split('.');
      if (parts.length !== 3) continue;
      const [id, tag, mac] = parts as [string, string, string];
      const expected = createHmac('sha256', this.#o.secret).update(`${id}.${tag}`).digest();
      const given = Buffer.from(mac, 'base64url');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) continue;
      const record = records.get(id);
      if (record && record.deletedAt === null && tagOf(record.passwordHash) === tag) return id;
    }
    // 2026-11-16: no valid cookie: the start profile (Settings → Profiles → Open in), while it has no password.
    const start = await this.startProfileId();
    const fallback = records.get(start);
    return fallback && fallback.passwordHash === null ? start : null;
  }

  // ── moving agents ───────────────────────────────────────────────────────

  /**
   * `PUT /api/sessions/{id}/user-profile`: moves an agent of this computer to profile `to` (its
   * password when it has one): its todos, loops, artifacts and the rest follow it (they carry no
   * profile of their own). Its sidebar place is cleared (the new profile shows it unplaced).
   */
  async moveSession(sessionId: string, body: unknown): Promise<string> {
    const input = isRecord(body) ? body : {};
    const to = typeof input['userProfileId'] === 'string' ? input['userProfileId'] : '';
    const record = await this.get(to);
    if (!record) throw new UserProfileError(404, 'not-found', `no profile ${to}`);
    const session = await this.#o.store.sessions.get(sessionId);
    if (!session) throw new UserProfileError(404, 'not-found', `no session ${sessionId}`);
    await this.#check(record, input['password']);
    // A crew member moves with its crew, a plan's step with its plan: refused when it is one of them? Kept simple: the agent alone (its crew / plan keep theirs).
    this.#o.store.userProfiles.setSessionProfile([sessionId], to);
    this.noteSession(sessionId, to);
    this.#o.store.db.prepare('DELETE FROM sidebar_places WHERE session_id = ?').run(sessionId);
    return to;
  }

  // ── peers ───────────────────────────────────────────────────────────────

  /** Every record, tombstones included, for a full exchange with a paired computer. */
  async wire(): Promise<UserProfileWire[]> {
    return [...(await this.#records()).values()].map(toWire);
  }

  /**
   * Merges a paired computer's records: the later clock wins per profile (equal clocks: by value,
   * the same on both ends). Answers the records that changed here.
   */
  async merge(incoming: readonly unknown[]): Promise<UserProfileRecord[]> {
    const records = await this.#records();
    const written: UserProfileRecord[] = [];
    for (const raw of incoming) {
      const wire = readWire(raw);
      if (!wire) continue;
      const own = records.get(wire.id);
      if (own && !(wire.clock > own.clock || (wire.clock === own.clock && JSON.stringify(toWire(own)) < JSON.stringify(wire)))) continue;
      // Default stays: a paired computer can rename or recolour it, never delete it.
      const deletedAt = wire.id === DEFAULT_USER_PROFILE_ID ? null : wire.deletedAt;
      const next: UserProfileRecord = { id: wire.id, name: wire.name, color: userProfileColor(wire.color) ?? 'blue', passwordHash: wire.passwordHash, clock: wire.clock, createdAt: own?.createdAt ?? (wire.createdAt || new Date(this.#now()).toISOString()), updatedAt: new Date(this.#now()).toISOString(), deletedAt };
      await this.#o.store.userProfiles.put(next);
      written.push(next);
    }
    if (written.length > 0) {
      this.#invalidate();
      this.#o.bus.publish('userProfilesChanged', { profiles: await this.list() });
    }
    return written;
  }
}

function order(a: UserProfileRecord, b: UserProfileRecord): number {
  if (a.id === DEFAULT_USER_PROFILE_ID) return -1;
  if (b.id === DEFAULT_USER_PROFILE_ID) return 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  // Created in the same millisecond: by name, then id (the same on every computer).
  if (a.name !== b.name) return a.name.localeCompare(b.name);
  return a.id < b.id ? -1 : 1;
}

/** A short tag of the password hash (`-` without one): part of the cookie, so a new password signs everyone out. */
function tagOf(passwordHash: string | null): string {
  return passwordHash === null ? '-' : createHash('sha256').update(passwordHash).digest('base64url').slice(0, 16);
}

function toWire(record: UserProfileRecord): UserProfileWire {
  return { id: record.id, name: record.name, color: record.color, passwordHash: record.passwordHash, clock: record.clock, createdAt: record.createdAt, deletedAt: record.deletedAt };
}

function readWire(value: unknown): UserProfileWire | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const name = userProfileName(value['name']);
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(id) || !name) return null;
  const hash = value['passwordHash'];
  if (hash !== null && !isPasswordHash(hash)) return null;
  const clock = typeof value['clock'] === 'string' ? value['clock'] : '';
  const createdAt = typeof value['createdAt'] === 'string' ? value['createdAt'] : '';
  const deletedAt = typeof value['deletedAt'] === 'string' ? value['deletedAt'] : null;
  return { id, name, color: typeof value['color'] === 'string' ? value['color'] : 'blue', passwordHash: hash as string | null, clock, createdAt, deletedAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
