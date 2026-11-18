import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { FolderBindPreview, InboxItem, Session } from '../../core/api.ts';
import type { PushPayload } from '../../core/devices.ts';
import { HybridClock } from '../../core/hlc.ts';
import {
  DEFAULT_USER_PROFILE_ID,
  type ProfileScope,
  USER_PROFILE_ACCOUNTS_SETTING,
  USER_PROFILE_COOKIE_MAX_AGE_S,
  USER_PROFILE_START_SETTING,
  USER_PROFILE_SWITCH_ATTEMPTS,
  USER_PROFILE_SWITCH_WINDOW_MS,
  adminChangeProblem,
  type ComputerThrough,
  inboxItemSession,
  mayManageAccess,
  mergedAccess,
  profileAllowedOn,
  readComputerAccess,
  type UserProfile,
  type UserProfileColor,
  profileOf,
  scopeSees,
  userProfileColor,
  userProfileName,
  userProfilePassword,
} from '../../core/user-profiles.ts';
import { type FolderRecord, folderContains } from '../db/repos/folders.ts';
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
  /** D172: the peer-link id (a computer's own Default travels as its own id, never `default`). */
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly passwordHash: string | null;
  readonly clock: string;
  readonly createdAt: string;
  readonly deletedAt: string | null;
  /** D172: this record is the Default of that computer (its machine id). */
  readonly homeOf?: string;
  /** D172: on a tombstone, the profile (peer-link id) it was merged into. */
  readonly mergedInto?: string | null;
  /** D173: an admin profile (absent from an older computer: not one). */
  readonly admin?: boolean;
  /** D173: the computers it may use (machine ids); `null` / absent = every computer. */
  readonly computers?: readonly string[] | null;
  /** D176: the computers `computers` was decided for (others stay allowed); `null` = every computer; absent = an older computer (the merge keeps what is here while the list is the same). */
  readonly decidedFor?: readonly string[] | null;
}

/** D172: the settings key of this computer's own Default's peer-link id (absent: `default-<machine id>`). */
export const USER_PROFILE_SELF_WIRE_SETTING = 'userProfiles.defaultWireId';
/** D172: the settings key of the paired computers' Defaults' peer-link ids (`{ <machine id>: <id> }`). */
export const USER_PROFILE_PEER_DEFAULTS_SETTING = 'userProfiles.peerDefaults';

/** D172: the peer-link id a computer's Default has before any merge. */
export function homeDefaultId(machineId: string): string {
  return `default-${machineId}`.slice(0, 64);
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
  /** D172: this computer's machine id (its Default's peer-link id is derived from it); `null` while unknown. */
  readonly selfId?: () => Promise<string | null>;
  /** D172: re-keys what lives outside the main db (crews in team.db, open terminals) from one profile to another. */
  readonly rekeyOutside?: (from: string, to: string) => Promise<void> | void;
  /** D176: the computers this one knows besides itself: the paired ones, and the ones known only through them (ids). */
  readonly knownComputers?: () => readonly string[];
  /** D176: the computers known only through a paired computer (for the access checklist). */
  readonly otherComputers?: () => readonly ComputerThrough[];
  /**
   * D178: a paired computer's agent's profile as that computer named it on its Inbox items (its
   * last known items), for a remote session not in its last known list yet; `null`: none says.
   */
  readonly remoteProfileHint?: (sessionId: string) => string | null;
  readonly now?: () => number;
}

/** The session a notice's deep link opens (`/sessions/<id>`, `/agents/<id>`), else `null`. */
function sessionOfUrl(url: string): string | null {
  const match = /^\/(?:sessions|agents)\/([^/?#]+)/.exec(url);
  return match ? decodeURIComponent(match[1] as string) : null;
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
    if (!this.#profiles) {
      this.#profiles = new Map((await this.#o.store.userProfiles.list({ includeDeleted: true })).map((record) => [record.id, record]));
      this.#merged = new Map([...this.#profiles.values()].filter((record) => record.mergedInto).map((record) => [record.id, record.mergedInto as string]));
      this.#deletedIds = new Set([...this.#profiles.values()].filter((record) => record.deletedAt).map((record) => record.id));
    }
    return this.#profiles;
  }

  #invalidate(): void {
    this.#profiles = null;
  }

  // ── D172 · identity across paired computers ─────────────────────────────

  /** This computer's machine id (cached once known). */
  #self: string | null = null;
  /** This computer's Default's peer-link id (cached; {@link USER_PROFILE_SELF_WIRE_SETTING}). */
  #selfWire: string | null = null;
  /** The paired computers' Defaults' peer-link ids (cached; {@link USER_PROFILE_PEER_DEFAULTS_SETTING}). */
  #peerDefaults: Record<string, string> = {};
  /** Merged-away profile → the profile it was merged into (peer-link ids), from the tombstones. */
  #merged = new Map<string, string>();

  /** Loads the identity caches (the app calls it at start; every sync path calls it too). */
  async ready(): Promise<void> {
    if (this.#self === null && this.#o.selfId) this.#self = await this.#o.selfId();
    const stored = await this.#o.store.settings.get(USER_PROFILE_SELF_WIRE_SETTING);
    this.#selfWire = typeof stored === 'string' && stored !== '' ? stored : this.#self ? homeDefaultId(this.#self) : null;
    const peers = await this.#o.store.settings.get(USER_PROFILE_PEER_DEFAULTS_SETTING);
    this.#peerDefaults = peers && typeof peers === 'object' && !Array.isArray(peers) ? { ...(peers as Record<string, string>) } : {};
    await this.#records();
  }

  /** This computer's Default as the peer link names it. */
  selfWireId(): string {
    return this.#selfWire ?? homeDefaultId(this.#self ?? 'local');
  }

  /** The merged-into chain's end (peer-link ids; a cycle stops). */
  #canonical(id: string): string {
    let at = id;
    for (let i = 0; i < 8; i += 1) {
      const next = this.#merged.get(at === DEFAULT_USER_PROFILE_ID ? this.selfWireId() : at);
      if (!next || next === at) break;
      at = next;
    }
    return at;
  }

  /**
   * D172: a profile id as paired computer `machineId` sent it (its sessions, its requests, its synced
   * records) → this computer's id for that profile. A computer sends its own Default as `default`
   * (every version does); it is that computer's Default here (its peer-link id), never this computer's.
   * This computer's own Default (its peer-link id) is `default` here. A merged-away id is its survivor.
   */
  fromRemote(machineId: string, raw: string | null | undefined): string {
    const id = typeof raw === 'string' && raw !== '' ? raw : DEFAULT_USER_PROFILE_ID;
    const wire = id === DEFAULT_USER_PROFILE_ID ? (this.#peerDefaults[machineId] ?? homeDefaultId(machineId)) : id;
    return this.#localOf(wire);
  }

  /** D172: a peer-link id → this computer's id (the merged-into chain followed; this computer's Default → `default`). */
  #localOf(linkId: string): string {
    if (linkId === DEFAULT_USER_PROFILE_ID) return DEFAULT_USER_PROFILE_ID;
    const canonical = this.#canonical(linkId);
    // Its own home id stays this computer's Default even after it adopted a merged id.
    if (canonical === this.selfWireId() || (this.#self !== null && canonical === homeDefaultId(this.#self))) return DEFAULT_USER_PROFILE_ID;
    return canonical;
  }

  /** D172: this computer's id for a profile → its peer-link id. */
  #toLink(id: string): string {
    return id === DEFAULT_USER_PROFILE_ID ? this.selfWireId() : id;
  }

  /** D172: the machine whose Default `linkId` is (this computer for its own), else `null`. */
  #homeOf(linkId: string): string | null {
    if (linkId === this.selfWireId()) return this.#self;
    for (const [machine, id] of Object.entries(this.#peerDefaults)) if (id === linkId) return machine;
    const match = /^default-(.+)$/.exec(linkId);
    return match ? (match[1] as string) : null;
  }

  /** D172: whether `id` (this computer's id) is some computer's Default (never deleted, only merged). */
  isAnyDefault(id: string): boolean {
    if (id === DEFAULT_USER_PROFILE_ID) return true;
    return Object.values(this.#peerDefaults).includes(id) || /^default-/.test(id);
  }

  async #savePeerDefaults(): Promise<void> {
    await this.#o.store.settings.set(USER_PROFILE_PEER_DEFAULTS_SETTING, this.#peerDefaults);
  }

  /** A session's profile became known or changed (a new session, a move, a peer's update). */
  noteSession(sessionId: string, userProfileId: string | null | undefined): void {
    this.#index().set(sessionId, userProfileId || DEFAULT_USER_PROFILE_ID);
  }

  /**
   * The profile of a session, this computer's or a paired one's (`r~<machine>~<id>`, from its last
   * known list; an older computer's sessions are its Default's). D178: a paired computer's session
   * not in its last known list yet takes the profile its computer named (`hint`, an Inbox item's or a
   * notice's `userProfileId`, else {@link UserProfileServiceOptions.remoteProfileHint}), else that
   * computer's Default: never this computer's own Default (before D178 it was, so this computer's
   * Default saw a new agent's items of any profile there until its list came).
   */
  profileOfSession(sessionId: string, hint?: string | null): string {
    if (sessionId.startsWith('r~')) {
      const machine = sessionId.split('~')[1] ?? '';
      const remote = this.#o.remoteSessions?.().find((session) => session.id === sessionId);
      if (!remote) return this.fromRemote(machine, hint ?? this.#o.remoteProfileHint?.(sessionId) ?? null);
      // D172: its computer's own id for the profile (its `default` is that computer's Default, not this one's).
      return this.fromRemote(machine, profileOf(remote));
    }
    const own = this.#index().get(sessionId);
    // D179: a session left on a merged-away (or deleted) profile is its survivor's (Default's when none), never no one's.
    if (own) return this.#alive(own);
    return DEFAULT_USER_PROFILE_ID;
  }

  /**
   * D179: the profile of a session when it is known: this computer's sessions, and a paired
   * computer's once its list arrived; `null` for one not known (yet).
   */
  knownProfileOfSession(sessionId: string): string | null {
    if (sessionId.startsWith('r~')) {
      if (!this.#o.remoteSessions?.().some((session) => session.id === sessionId)) return null;
      return this.profileOfSession(sessionId);
    }
    return this.#index().has(sessionId) ? this.profileOfSession(sessionId) : null;
  }

  /** D179: the ids of the profiles that exist here (not deleted; this computer's ids). */
  async liveIds(): Promise<ReadonlySet<string>> {
    const records = await this.#records();
    return new Set([DEFAULT_USER_PROFILE_ID, ...[...records.values()].filter((record) => !record.deletedAt).map((record) => record.id)]);
  }
  /** D179: deleted profiles' ids (tombstones). */
  #deletedIds = new Set<string>();

  /** D179: profile `id` as a live one: a merged-away one's survivor (the chain), a deleted one without a survivor → Default. */
  #alive(id: string): string {
    if (id === DEFAULT_USER_PROFILE_ID || !this.#deletedIds.has(id)) return id;
    const survivor = this.#localOf(id);
    return survivor !== id && !this.#deletedIds.has(survivor) ? survivor : DEFAULT_USER_PROFILE_ID;
  }

  /**
   * D179 · the repair at start: data still naming a merged-away or deleted profile (a merge learned
   * before 2.4.50 that did not move everything, a chat moved in under an old id) moves to the
   * survivor (Default's when none). Answers the profiles repaired (`from → to`).
   */
  async repairOrphans(): Promise<Array<{ readonly from: string; readonly to: string }>> {
    await this.ready();
    const records = await this.#records();
    // Read fresh, not cached: the index stays lazy (built at its first use, as before).
    const used = new Set(this.#o.store.userProfiles.sessionProfiles().values());
    const out: Array<{ from: string; to: string }> = [];
    for (const record of records.values()) {
      if (!record.deletedAt || record.id === DEFAULT_USER_PROFILE_ID || !used.has(record.id)) continue;
      const to = this.#alive(record.id);
      if (to === record.id) continue;
      await this.#rekeyAll(record.id, to);
      out.push({ from: record.id, to });
    }
    if (out.length > 0) this.#invalidate();
    return out;
  }

  /**
   * Whether scope `scope` sees session `sessionId`. D173: also only when the profile may use the
   * computer the session runs on (this one, or the paired one of an `r~<machine>~…` id): a profile
   * not allowed there does not see its agents there (they keep running, hidden).
   */
  sees(scope: ProfileScope, sessionId: string, hint?: string | null): boolean {
    if (!scopeSees(scope, this.profileOfSession(sessionId, hint))) return false;
    if (scope === '*' || scope === null) return scope === '*';
    const machine = sessionId.startsWith('r~') ? (sessionId.split('~')[1] ?? null) : this.#self;
    return this.allowedOn(scope, machine);
  }

  /**
   * D178: whether scope `scope` sees an Inbox item (`/api/inbox`, Home's and Needs you's cards, the
   * counts): the item of an agent by that agent ({@link inboxItemSession}: a failed move's by the moved
   * agent), a paired computer's by the profile it named while its session is not known here; the item
   * of no agent (an update, an account, Project memory) is every profile's.
   */
  seesInboxItem(scope: ProfileScope, item: Pick<InboxItem, 'sessionId' | 'move' | 'userProfileId'>): boolean {
    const session = this.inboxItemAgent(item);
    if (session === null) return true;
    // The hint is the item's own agent's (its sessionId), never a moved agent's on a third computer.
    return this.sees(scope, session, item.sessionId !== null ? (item.userProfileId ?? null) : null);
  }

  /** D178: the agent session an Inbox item belongs to ({@link inboxItemSession} with this computer's id); `null` = no agent's. */
  inboxItemAgent(item: Pick<InboxItem, 'sessionId' | 'move'>): string | null {
    return inboxItemSession(item, this.#self);
  }

  /** D178: whether scope `scope` gets a notice (a `/hub` toast, a phone's push): by its agent; one of no agent: everyone's. */
  seesNotice(scope: ProfileScope, notice: Pick<PushPayload, 'sessionId' | 'userProfileId' | 'url'>): boolean {
    const session = notice.sessionId ?? sessionOfUrl(notice.url);
    return session === null || this.sees(scope, session, notice.userProfileId ?? null);
  }

  // ── D173 · admins and computer access ───────────────────────────────────

  /** D173: whether profile `profileId` may be used on computer `machineId` (sync: the cached records; unknown = allowed). */
  allowedOn(profileId: string, machineId: string | null): boolean {
    const record = this.#profiles?.get(profileId);
    return !record || profileAllowedOn(record.computers, machineId, record.decidedFor);
  }

  /** D173: whether profile `profileId` may be used on this computer. */
  allowedHere(profileId: string): boolean {
    return this.allowedOn(profileId, this.#self);
  }

  /** D176: the computers known only through a paired computer (the access checklist lists them too). */
  otherComputers(): readonly ComputerThrough[] {
    return this.#o.otherComputers?.() ?? [];
  }

  /** D173: this computer's machine id (`null` while unknown). */
  selfMachineId(): string | null {
    return this.#self;
  }

  /** The admin facts of every live profile. */
  async #adminFacts(): Promise<Array<{ id: string; admin: boolean; hasPassword: boolean }>> {
    return [...(await this.#records()).values()].filter((record) => record.deletedAt === null).map((record) => ({ id: record.id, admin: record.admin, hasPassword: record.passwordHash !== null }));
  }

  /**
   * D173: checks that the request's profile `actor` may make this change, with `adminPassword` (the
   * actor's own password: it is an admin, or, while no admin exists, it makes itself the first one).
   */
  async #checkManager(actor: ProfileScope, change: { readonly target: string; readonly makingAdmin: boolean }, adminPassword: unknown): Promise<void> {
    const facts = await this.#adminFacts();
    const actorId = typeof actor === 'string' && actor !== '*' ? actor : null;
    const role = mayManageAccess(facts, actorId, change);
    if (!role || actorId === null) throw new UserProfileError(403, 'not-admin', facts.some((profile) => profile.admin) ? 'Only an admin profile can change admins and computer access. Switch to an admin profile first.' : 'No admin yet: switch to a profile with a password and make it the first admin.');
    const me = await this.get(actorId);
    if (!me) throw new UserProfileError(403, 'not-admin', 'Switch to an admin profile first.');
    // An admin always has a password (the rules keep it so): its own password confirms the change.
    if (me.passwordHash === null) throw new UserProfileError(403, 'not-admin', 'An admin needs a password: set one for this profile first.');
    await this.#check(me, adminPassword);
  }

  /**
   * D173 · `PUT /api/user-profiles/{id}/admin { admin, adminPassword }`: makes a profile an admin or not.
   * Only an admin (its password), or the bootstrap (a profile with a password making itself the first
   * admin). The last admin stays; an admin needs a password.
   */
  async setAdmin(id: string, body: unknown, actor: ProfileScope): Promise<UserProfile> {
    const record = await this.get(id);
    if (!record) throw new UserProfileError(404, 'not-found', `no profile ${id}`);
    const input = isRecord(body) ? body : {};
    if (typeof input['admin'] !== 'boolean') throw new UserProfileError(422, 'invalid', 'Give admin: true or false.');
    const admin = input['admin'];
    await this.#checkManager(actor, { target: id, makingAdmin: admin }, input['adminPassword']);
    const problem = adminChangeProblem(await this.#adminFacts(), id, admin);
    if (problem) throw new UserProfileError(409, admin ? 'needs-password' : 'last-admin', problem);
    if (record.admin === admin) return this.#view(record, await this.#defaultAccounts());
    const updated = (await this.#o.store.userProfiles.update(id, { admin, clock: this.#clock() })) ?? record;
    await this.#changed([updated]);
    return this.#view(updated, await this.#defaultAccounts());
  }

  /**
   * D173 · `PUT /api/user-profiles/{id}/access { computers: 'all' | [machine ids], decidedFor?, adminPassword }`:
   * the computers a profile may use (only an admin, its password). `'all'` / `null` = every computer.
   * D176: `decidedFor` = the computers the checklist showed (absent: every computer this one knows,
   * itself, the paired ones and the ones known through them); the listed ones count as decided too. A
   * computer outside it was never decided and stays allowed.
   */
  async setAccess(id: string, body: unknown, actor: ProfileScope): Promise<UserProfile> {
    const record = await this.get(id);
    if (!record) throw new UserProfileError(404, 'not-found', `no profile ${id}`);
    const input = isRecord(body) ? body : {};
    const computers = readComputerAccess(input['computers']);
    if (computers === undefined) throw new UserProfileError(422, 'invalid', "Give computers: 'all' or a list of computer ids.");
    const shown = input['decidedFor'] === undefined ? undefined : readComputerAccess(input['decidedFor']);
    if (shown === null || (input['decidedFor'] !== undefined && shown === undefined)) throw new UserProfileError(422, 'invalid', 'Give decidedFor: a list of computer ids.');
    await this.#checkManager(actor, { target: id, makingAdmin: false }, input['adminPassword']);
    const decidedFor = computers === null ? null : [...new Set([...(shown ?? [...(this.#self ? [this.#self] : []), ...(this.#o.knownComputers?.() ?? [])]), ...computers])];
    const updated = (await this.#o.store.userProfiles.update(id, { computers, decidedFor, clock: this.#clock() })) ?? record;
    await this.#changed([updated]);
    return this.#view(updated, await this.#defaultAccounts());
  }

  // ── profiles ────────────────────────────────────────────────────────────

  async #defaultAccounts(): Promise<Record<string, Record<string, string>>> {
    const stored = await this.#o.store.settings.get(USER_PROFILE_ACCOUNTS_SETTING);
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, Record<string, string>>) : {};
  }

  #view(record: UserProfileRecord, accounts: Record<string, Record<string, string>>): UserProfile {
    return {
      id: record.id,
      name: record.name,
      color: userProfileColor(record.color) ?? 'blue',
      hasPassword: record.passwordHash !== null,
      isDefault: record.id === DEFAULT_USER_PROFILE_ID,
      computerDefault: this.isAnyDefault(record.id),
      defaultAccounts: { ...(accounts[record.id] ?? {}) },
      // D173
      admin: record.admin,
      computers: record.computers,
      decidedFor: record.decidedFor,
      allowedHere: profileAllowedOn(record.computers, this.#self, record.decidedFor),
    };
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
    await this.ready();
    this.#o.bus.publish('userProfilesChanged', { profiles: await this.list() });
    this.#o.synced?.(records.map((record) => this.#wireOf(record)));
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
      // D173: an admin keeps a password (remove its admin role first).
      if ((input['password'] === null || input['password'] === '') && record.admin) throw new UserProfileError(409, 'admin-needs-password', 'An admin needs a password. Remove its admin role first.');
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
    // D172: another computer's Default can't be deleted either (that computer keeps it): merge it instead.
    if (this.isAnyDefault(id)) throw new UserProfileError(409, 'default', 'A paired computer’s Default can’t be deleted. Merge it with one of your profiles instead.');
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
    // D169: its bound saved folders are shared again (ASSUMED: not hidden from everyone for good).
    await this.#o.store.folders.unbindProfile(id);
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
    // D173: a profile an admin did not allow on this computer can't be used here.
    if (!profileAllowedOn(record.computers, this.#self, record.decidedFor)) throw new UserProfileError(403, 'not-allowed-here', `“${record.name}” can’t be used on this computer: an admin limited it to other computers.`);
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
      // D173: a cookie for a profile not allowed on this computer counts as none (the fallback below).
      if (record && record.deletedAt === null && tagOf(record.passwordHash) === tag && profileAllowedOn(record.computers, this.#self, record.decidedFor)) return id;
    }
    // 2026-11-16: no valid cookie: the start profile (Settings → Profiles → Open in), while it has no password (D173: and is allowed here).
    const start = await this.startProfileId();
    const fallback = records.get(start);
    return fallback && fallback.passwordHash === null && profileAllowedOn(fallback.computers, this.#self, fallback.decidedFor) ? start : null;
  }

  // ── moving agents ───────────────────────────────────────────────────────

  /**
   * `PUT /api/sessions/{id}/user-profile`: moves an agent of this computer to profile `to` (its
   * password when it has one): its todos, loops, artifacts and the rest follow it (they carry no
   * profile of their own). Its sidebar place is cleared (the new profile shows it unplaced).
   */
  // ── folders bound to a profile (D169) ──────────────────────────────────

  /**
   * D169: what binding saved folder `folderId` to profile `to` moves there: the sessions of other
   * profiles (open and archived) whose saved folder is this one or whose folder / working folder is
   * inside it, and the schedules of other profiles that start their runs in it. Per computer: this
   * computer's sessions and schedules only.
   */
  async folderBindPreview(folderId: string, to: string): Promise<FolderBindPreview> {
    const folder = await this.#visibleFolder(folderId);
    if (!(await this.get(to))) throw new UserProfileError(404, 'not-found', `no profile ${to}`);
    const inside = (dir: string | null): boolean => dir !== null && path.isAbsolute(dir) && folderContains(folder, dir);
    const agents = (await this.#o.store.sessions.list())
      .filter((session) => (session.userProfileId ?? DEFAULT_USER_PROFILE_ID) !== to && (session.folderId === folder.id || inside(session.root) || inside(session.cwd)))
      .map((session) => ({ sessionId: session.id, title: session.title ?? session.name, userProfileId: session.userProfileId ?? DEFAULT_USER_PROFILE_ID, closed: session.closedAt !== null }));
    const schedules = (this.#o.store.db.prepare('SELECT id, name, user_profile_id FROM schedules WHERE folder_id = ? AND user_profile_id <> ? ORDER BY name').all(folder.id, to) as Array<{ id: string; name: string; user_profile_id: string }>).map((row) => ({
      id: row.id,
      name: row.name,
      userProfileId: row.user_profile_id,
    }));
    return { folderId: folder.id, to, agents, schedules };
  }

  /**
   * D169 · `PUT /api/folders/{id}/user-profile { userProfileId | null, password? }`: binds the folder
   * to a profile (the target's password when it has one; the request must see the folder) and moves
   * the other profiles' agents and schedules there first ({@link folderBindPreview}); `null` unbinds
   * it (the owner's password when it has one). Answers the folder's new owner and the moved agents.
   */
  async bindFolder(folderId: string, body: unknown): Promise<{ readonly folderId: string; readonly userProfileId: string | null; readonly moved: readonly string[]; readonly schedules: number }> {
    const input = isRecord(body) ? body : {};
    const folder = await this.#visibleFolder(folderId);
    const wanted = input['userProfileId'];
    if (wanted === null) {
      if (folder.userProfileId) {
        const owner = await this.get(folder.userProfileId);
        if (owner) await this.#check(owner, input['password']);
      }
      await this.#o.store.folders.setUserProfile(folder.id, null);
      return { folderId: folder.id, userProfileId: null, moved: [], schedules: 0 };
    }
    if (typeof wanted !== 'string' || wanted === '') throw new UserProfileError(422, 'invalid', 'Give userProfileId (a profile id) to bind the folder, or null to share it again.');
    const target = await this.get(wanted);
    if (!target) throw new UserProfileError(404, 'not-found', `no profile ${wanted}`);
    // Re-binding a folder that is bound already: its present owner's password too (it is theirs).
    if (folder.userProfileId && folder.userProfileId !== wanted) {
      const owner = await this.get(folder.userProfileId);
      if (owner) await this.#check(owner, input['currentPassword'] ?? input['password']);
    }
    await this.#check(target, input['password']);
    const preview = await this.folderBindPreview(folder.id, wanted);
    const moved = preview.agents.map((agent) => agent.sessionId);
    this.#moveSessions(moved, wanted);
    for (const schedule of preview.schedules) this.#o.store.db.prepare('UPDATE schedules SET user_profile_id = ? WHERE id = ?').run(wanted, schedule.id);
    await this.#o.store.folders.setUserProfile(folder.id, wanted);
    return { folderId: folder.id, userProfileId: wanted, moved, schedules: preview.schedules.length };
  }

  /** A saved folder the current request may see, else 404 (as if it did not exist). */
  async #visibleFolder(folderId: string): Promise<FolderRecord> {
    const folder = await this.#o.store.folders.get(folderId);
    if (!folder) throw new UserProfileError(404, 'not-found', `no saved folder ${folderId}`);
    return folder;
  }

  /** Moves sessions to profile `to` without a password check (the caller checked): {@link moveSession}'s effect. */
  #moveSessions(sessionIds: readonly string[], to: string): void {
    if (sessionIds.length === 0) return;
    this.#o.store.userProfiles.setSessionProfile(sessionIds, to);
    const unplace = this.#o.store.db.prepare('DELETE FROM sidebar_places WHERE session_id = ?');
    for (const id of sessionIds) {
      this.noteSession(id, to);
      unplace.run(id);
    }
  }

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

  /** D172: a record as the peer link names it (this computer's Default as its own id, with `homeOf`). */
  #wireOf(record: UserProfileRecord): UserProfileWire {
    const id = this.#toLink(record.id);
    const home = this.#homeOf(id);
    return { ...toWire(record), id, ...(home ? { homeOf: home } : {}), mergedInto: record.mergedInto };
  }

  /**
   * Every record, tombstones included, for a full exchange with a paired computer. D172: `forMachine`'s
   * own Default is left out (it is that computer's own; an older computer would add it twice).
   */
  async wire(forMachine: string | null = null): Promise<UserProfileWire[]> {
    await this.ready();
    const skip = forMachine ? (this.#peerDefaults[forMachine] ?? homeDefaultId(forMachine)) : null;
    return [...(await this.#records()).values()].map((record) => this.#wireOf(record)).filter((wire) => wire.id !== skip);
  }

  /** D172: the wire form of records just written here (what `synced` sends to the paired computers). */
  wireOfRecords(records: readonly UserProfileRecord[]): UserProfileWire[] {
    return records.map((record) => this.#wireOf(record));
  }

  /**
   * Merges paired computer `fromMachine`'s records: the later clock wins per profile (equal clocks: by
   * value, the same on both ends). D172: every id is translated first ({@link fromRemote}): the sender's
   * own `default` (an older computer) and its Default's id are that computer's Default here, never this
   * computer's; this computer's own Default's id is the local Default. A Default is never deleted: when a
   * paired computer merged this computer's Default into another profile, this computer adopts that
   * profile's id for its Default. A merged-away profile's data here moves to its survivor. Answers the
   * records that changed here.
   */
  async merge(incoming: readonly unknown[], fromMachine: string | null = null): Promise<UserProfileRecord[]> {
    await this.ready();
    const written: UserProfileRecord[] = [];
    let learned = false;
    // Defaults first (their homes), so the ids below translate right.
    const wires = incoming.map((raw) => readWire(raw)).filter((wire): wire is UserProfileWire & { homeOf?: string; mergedInto?: string | null } => wire !== null);
    for (const wire of wires) {
      const home = wire.id === DEFAULT_USER_PROFILE_ID ? fromMachine : (wire.homeOf ?? null);
      if (!home || home === this.#self) continue;
      const id = wire.id === DEFAULT_USER_PROFILE_ID ? (this.#peerDefaults[home] ?? homeDefaultId(home)) : wire.id;
      if (this.#peerDefaults[home] !== id && !wire.deletedAt) {
        this.#peerDefaults[home] = id;
        learned = true;
      }
    }
    if (learned) await this.#savePeerDefaults();
    for (const wire of wires) {
      const records = await this.#records();
      // An older computer's own Default comes as `default`: it is that computer's, under its own id here.
      const linkId = wire.id === DEFAULT_USER_PROFILE_ID && fromMachine ? (this.#peerDefaults[fromMachine] ?? homeDefaultId(fromMachine)) : wire.id;
      const localId = linkId === this.selfWireId() || (this.#self !== null && linkId === homeDefaultId(this.#self)) ? DEFAULT_USER_PROFILE_ID : linkId;
      const own = records.get(localId);
      // D176: an older computer sends no `decidedFor`: the one here stays while the list is the same (it decided nothing new).
      const decidedFor = wire.decidedFor !== undefined ? wire.decidedFor : own && sameList(own.computers, wire.computers ?? null) ? own.decidedFor : null;
      const listDecided = (wire.computers ?? null) === null ? null : decidedFor;
      if (localId === DEFAULT_USER_PROFILE_ID && wire.deletedAt) {
        // This computer's Default was merged into another profile on a paired computer: adopt its id.
        if (wire.mergedInto && this.#localOf(wire.mergedInto) !== DEFAULT_USER_PROFILE_ID) written.push(...(await this.#adoptDefault(wire.mergedInto)));
        continue;
      }
      if (own && !(wire.clock > own.clock || (wire.clock === own.clock && JSON.stringify(toWire(own)) < JSON.stringify({ ...toWire(own), name: wire.name, color: wire.color, passwordHash: wire.passwordHash, clock: wire.clock, deletedAt: wire.deletedAt, admin: wire.admin ?? false, computers: wire.computers ?? null, decidedFor: listDecided })))) continue;
      const deletedAt = localId === DEFAULT_USER_PROFILE_ID ? null : wire.deletedAt;
      const next: UserProfileRecord = {
        id: localId,
        name: wire.name,
        color: userProfileColor(wire.color) ?? 'blue',
        passwordHash: wire.passwordHash,
        clock: wire.clock,
        createdAt: own?.createdAt ?? (wire.createdAt || new Date(this.#now()).toISOString()),
        updatedAt: new Date(this.#now()).toISOString(),
        deletedAt,
        mergedInto: deletedAt ? (wire.mergedInto ?? null) : null,
        // D173: profile attributes, last write wins with the record (an older computer: not an admin, every computer).
        admin: wire.admin ?? false,
        computers: wire.computers ?? null,
        decidedFor: listDecided,
      };
      await this.#o.store.userProfiles.put(next);
      this.#invalidate();
      written.push(next);
      // A profile merged into another one: its data here moves to the survivor.
      if (deletedAt && wire.mergedInto) {
        const target = this.#localOf(wire.mergedInto);
        if (target !== localId) await this.#rekeyAll(localId, target);
      }
    }
    if (written.length > 0) {
      this.#invalidate();
      this.#o.bus.publish('userProfilesChanged', { profiles: await this.list() });
    }
    return written;
  }

  /**
   * D172: a paired computer merged this computer's Default into profile `linkId`: this computer's
   * Default takes that id on the peer link from now on; the local copy of that profile (if any)
   * folds into the Default (its data re-keyed, its row gone, never synced as a delete).
   */
  async #adoptDefault(linkId: string): Promise<UserProfileRecord[]> {
    if (linkId === this.selfWireId()) return [];
    const records = await this.#records();
    const copy = records.get(linkId) ?? null;
    await this.#o.store.settings.set(USER_PROFILE_SELF_WIRE_SETTING, linkId);
    this.#selfWire = linkId;
    const written: UserProfileRecord[] = [];
    if (copy) {
      await this.#rekeyAll(linkId, DEFAULT_USER_PROFILE_ID);
      const mine = records.get(DEFAULT_USER_PROFILE_ID);
      if (mine && copy.clock > mine.clock) {
        const updated = await this.#o.store.userProfiles.update(DEFAULT_USER_PROFILE_ID, { name: copy.name, color: copy.color, passwordHash: copy.passwordHash, clock: copy.clock });
        if (updated) written.push(updated);
      }
      this.#o.store.userProfiles.remove(linkId);
    }
    this.#invalidate();
    return written;
  }

  /** D172: every reference to profile `from` here (main db, crews, terminals, settings, the index) now names `to`. */
  async #rekeyAll(from: string, to: string): Promise<void> {
    if (from === to) return;
    this.#o.store.userProfiles.rekey(from, to);
    await this.#o.rekeyOutside?.(from, to);
    const accounts = await this.#defaultAccounts();
    if (accounts[from]) {
      const { [from]: gone, ...rest } = accounts;
      await this.#o.store.settings.set(USER_PROFILE_ACCOUNTS_SETTING, { ...rest, [to]: { ...(gone ?? {}), ...(rest[to] ?? {}) } });
    }
    if ((await this.#o.store.settings.get(USER_PROFILE_START_SETTING)) === from) await this.#o.store.settings.set(USER_PROFILE_START_SETTING, to);
    for (const [machine, id] of Object.entries(this.#peerDefaults)) if (id === from) this.#peerDefaults[machine] = this.#toLink(to);
    await this.#savePeerDefaults();
    this.#sessions = null;
  }

  /**
   * D172 · `POST /api/user-profiles/merge { a, b, passwordA?, passwordB?, keep: { name, color, password } }`:
   * two profiles (this computer's or a paired computer's) become one, on purpose (never automatically).
   * Both passwords are checked (where set). `keep.*` is `'a'` or `'b'`: whose name, colour and password the
   * merged profile keeps. The survivor's id: this computer's Default when it is one of the two, else the
   * older profile. Every agent, folder binding, pin, phone, schedule, crew and terminal of the other one
   * moves to it here; the other one becomes a tombstone that names the survivor, so each paired
   * computer moves its own data too (a merged-away Default adopts the survivor's id there).
   */
  async mergeProfiles(body: unknown): Promise<{ readonly survivor: UserProfile; readonly mergedAway: string }> {
    await this.ready();
    const input = isRecord(body) ? body : {};
    const aId = typeof input['a'] === 'string' ? input['a'] : '';
    const bId = typeof input['b'] === 'string' ? input['b'] : '';
    if (aId === '' || bId === '' || aId === bId) throw new UserProfileError(422, 'invalid', 'Pick two different profiles to merge.');
    const a = await this.get(aId);
    const b = await this.get(bId);
    if (!a || !b) throw new UserProfileError(404, 'not-found', `no profile ${!a ? aId : bId}`);
    const keep = isRecord(input['keep']) ? input['keep'] : {};
    const pick = (field: string): 'a' | 'b' => (keep[field] === 'b' ? 'b' : 'a');
    await this.#check(a, input['passwordA']);
    await this.#check(b, input['passwordB']);
    const keepName = pick('name') === 'a' ? a : b;
    const keepColor = pick('color') === 'a' ? a : b;
    const keepPassword = pick('password') === 'a' ? a : b;
    // The survivor: this computer's Default when it is one; else the older one (the same choice everywhere).
    const [survivor, gone] = a.id === DEFAULT_USER_PROFILE_ID ? [a, b] : b.id === DEFAULT_USER_PROFILE_ID ? [b, a] : a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id) ? [a, b] : [b, a];
    for (const record of (await this.#records()).values()) {
      if (record.deletedAt === null && record.id !== a.id && record.id !== b.id && record.name.toLowerCase() === keepName.name.toLowerCase()) throw new UserProfileError(409, 'name-taken', `A profile is already called “${record.name}”.`);
    }
    // D173 (ASSUMED): the merged profile is an admin when either was; it may use every computer either could (all when either could).
    const admin = a.admin || b.admin;
    const { computers, decidedFor } = mergedAccess(a, b);
    if (admin && keepPassword.passwordHash === null) throw new UserProfileError(409, 'needs-password', 'The merged profile is an admin, so it needs a password: keep the password of the one that has one.');
    const updated = (await this.#o.store.userProfiles.update(survivor.id, { name: keepName.name, color: keepColor.color, passwordHash: keepPassword.passwordHash, admin, computers, decidedFor, clock: this.#clock() })) ?? survivor;
    const tomb = (await this.#o.store.userProfiles.update(gone.id, { deletedAt: new Date(this.#now()).toISOString(), passwordHash: null, mergedInto: this.#toLink(survivor.id), clock: this.#clock() })) ?? gone;
    this.#invalidate();
    await this.#records();
    await this.#rekeyAll(gone.id, survivor.id);
    // A merged-away Default of a paired computer: that computer's sessions and requests now mean the survivor here.
    for (const [machine, id] of Object.entries(this.#peerDefaults)) if (id === gone.id) this.#peerDefaults[machine] = this.#toLink(survivor.id);
    await this.#savePeerDefaults();
    await this.#changed([updated, tomb]);
    return { survivor: this.#view(updated, await this.#defaultAccounts()), mergedAway: gone.id };
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
  return { id: record.id, name: record.name, color: record.color, passwordHash: record.passwordHash, clock: record.clock, createdAt: record.createdAt, deletedAt: record.deletedAt, admin: record.admin, computers: record.computers, decidedFor: record.decidedFor };
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
  // D172: whose Default it is, and on a tombstone what it was merged into (an older computer sends neither).
  const homeOf = typeof value['homeOf'] === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value['homeOf']) ? value['homeOf'] : undefined;
  const mergedInto = typeof value['mergedInto'] === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value['mergedInto']) ? value['mergedInto'] : null;
  // D173: an older computer sends neither: not an admin, every computer. A malformed list counts as every computer.
  const admin = value['admin'] === true;
  const computers = readComputerAccess(value['computers'] ?? null) ?? null;
  // D176: absent (an older computer) stays absent: the merge keeps the list's `decidedFor` here. Malformed = decided everywhere (D173).
  const decidedFor = 'decidedFor' in value ? (value['decidedFor'] === null ? null : (readComputerAccess(value['decidedFor']) ?? null)) : undefined;
  return { id, name, color: typeof value['color'] === 'string' ? value['color'] : 'blue', passwordHash: hash as string | null, clock, createdAt, deletedAt, ...(homeOf ? { homeOf } : {}), mergedInto, admin, computers, ...(decidedFor !== undefined ? { decidedFor } : {}) };
}

/** D176: two access lists hold the same computers (order aside). */
function sameList(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((id) => b.includes(id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
