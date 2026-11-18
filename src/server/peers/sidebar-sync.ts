import type { MachineSidebarSync, SidebarSyncState } from '../../core/peers.ts';
import { isCrewPinId } from '../../core/crew-pins.ts';
import { isPlanPinId } from '../../core/plan-pins.ts';
import { type FolderRecord, type RecordChanges, noChanges } from '../../core/sidebar-records.ts';
import { DEFAULT_USER_PROFILE_ID } from '../../core/user-profiles.ts';
import { SIDEBAR_SYNC_VERSION, type SidebarSyncAnswer, type SidebarSyncMessage, fromWire, readSyncMessage, toWire } from '../../core/sidebar-sync.ts';
import type { SidebarWrite } from '../db/repos/sidebar.ts';
import type { Store } from '../db/store.ts';
import type { HubBus } from '../hub/bus.ts';
import { PeerUnreachableError } from './client.ts';

/** Settings key of the D71 switches: `{ [machineId]: { enabled, mergedAt } }`. */
export const SIDEBAR_SYNC_SETTING = 'peers.sidebarSync';

/** The peer route of the exchange (on the peer listener, beside `/peer/v1/hello`; not part of `/peer/v1/api`). */
export const SIDEBAR_SYNC_PATH = '/peer/v1/sidebar';

/** Time limit of one exchange. */
const SYNC_TIMEOUT_MS = 30_000;

interface StoredSwitch {
  /** Any profile on (kept for older readers of the setting). */
  readonly enabled: boolean;
  readonly mergedAt: string | null;
  /** D179: the profiles (this computer's ids) that share their layout with that machine. */
  readonly profiles: readonly string[];
}

/** What the sync needs of a paired machine's connection. */
export interface SyncConnection {
  readonly state: string;
  request(method: string, path: string, body?: unknown, options?: { readonly timeoutMs?: number }): Promise<{ readonly status: number; readonly body: unknown }>;
}

/** Options of {@link SidebarSync}. */
export interface SidebarSyncOptions {
  readonly store: Store;
  readonly bus: HubBus;
  /** This machine's id (the keys' namespace). */
  readonly selfId: () => Promise<string>;
  /** D172: a paired machine's profile id on its folders → this machine's (its `default` is its Default). */
  readonly mapProfile?: (machineId: string, id: string) => string;
  /** D179: a session's profile here (this computer's id), `null` when not known (yet). */
  readonly profileOfSession?: (sessionId: string) => string | null;
  /** D179: the profiles that exist here (this computer's ids; deleted ones left out). */
  readonly liveProfiles?: () => Promise<ReadonlySet<string>>;
  /** The machine's connection (`undefined` when not paired). */
  readonly connection: (machineId: string) => SyncConnection | undefined;
  /** The paired machines' ids. */
  readonly machines: () => readonly string[];
  /** A machine's sync state changed (Settings → Machines follows it live: `machineState`). */
  readonly onStatus: (machineId: string) => void;
  readonly onError: (error: unknown) => void;
  readonly log: (level: 'info' | 'warn', message: string) => void;
}

/**
 * D71 · the sidebar layout shared with paired machines (`docs/peers.md` →
 * *Shared sidebar layout (D71)*, `docs/sidebar.md` → *Shared layout (D71)*).
 *
 * Per paired machine a switch, off until the developer turns it on (Settings →
 * Machines). With it on here, this machine sends its layout's records to that
 * machine and merges the ones it gets back; the other machine does the same
 * only when its own switch for us is on (else it answers `enabled: false` and
 * the state is `waiting`). Everything goes over this machine's outbound
 * connection, `POST /peer/v1/sidebar` (pairing auth, Tailscale-only listener):
 *
 * - **full exchange** when the switch is turned on and whenever the connection
 *   comes (back) online: all records both ways, so a machine that was offline
 *   catches up; the first one also combines same-named folders ("always
 *   merge");
 * - **live**: every local change sends the records it wrote to every machine
 *   it is on with that is online; a merge that changed something here is sent
 *   on to the other machines (never back to where it came from); a merge that
 *   changes nothing stops there.
 *
 * Conflicts: last write wins per item (`mergeRecords`). An older peer without
 * the route answers 404: `unsupported`, nothing breaks.
 */
export class SidebarSync {
  readonly #options: SidebarSyncOptions;
  readonly #status = new Map<string, { state: SidebarSyncState; lastSyncAt: string | null; error: string | null }>();
  /** The exchanges running, per machine (one at a time; a second request joins the next one). */
  readonly #exchanges = new Map<string, Promise<void>>();
  #switches: Record<string, StoredSwitch> | null = null;

  constructor(options: SidebarSyncOptions) {
    this.#options = options;
  }

  async #load(): Promise<Record<string, StoredSwitch>> {
    if (this.#switches) return this.#switches;
    const stored = (await this.#options.store.settings.get(SIDEBAR_SYNC_SETTING)) as Record<string, unknown> | undefined;
    const out: Record<string, StoredSwitch> = {};
    for (const [id, value] of Object.entries(stored ?? {})) {
      const entry = value as { enabled?: unknown; mergedAt?: unknown; profiles?: unknown } | null;
      if (!entry || typeof entry !== 'object') continue;
      // D179: a switch from before (no `profiles`) was the whole layout's: it is Default's now.
      const profiles = Array.isArray(entry.profiles) ? entry.profiles.filter((p): p is string => typeof p === 'string' && p !== '') : entry.enabled === true ? [DEFAULT_USER_PROFILE_ID] : [];
      out[id] = { enabled: profiles.length > 0, mergedAt: typeof entry.mergedAt === 'string' ? entry.mergedAt : null, profiles };
    }
    this.#switches = out;
    return out;
  }

  /** D179: the profiles that share their layout with `machineId` (this computer's ids). */
  profilesFor(machineId: string): ReadonlySet<string> {
    return new Set(this.#switches?.[machineId]?.profiles ?? []);
  }

  async #save(id: string, value: StoredSwitch | null): Promise<void> {
    const switches = { ...(await this.#load()) };
    if (value === null) delete switches[id];
    else switches[id] = value;
    this.#switches = switches;
    await this.#options.store.settings.set(SIDEBAR_SYNC_SETTING, switches);
  }

  /** Loads the switches (once, at start). */
  async start(): Promise<void> {
    await this.#load();
  }

  /** `true` when this machine's switch for `machineId` is on for some profile (D179). */
  enabled(machineId: string): boolean {
    return (this.#switches?.[machineId]?.profiles.length ?? 0) > 0;
  }

  /** What the Machine row shows (`Machine.sidebarSync`); D179: `profiles` lists who shares (each browser shows its own profile's switch). */
  view(machineId: string): MachineSidebarSync {
    const stored = this.#switches?.[machineId];
    const status = this.#status.get(machineId);
    const enabled = (stored?.profiles.length ?? 0) > 0;
    return {
      enabled,
      state: enabled ? (status?.state ?? 'connecting') : 'off',
      mergedAt: stored?.mergedAt ?? null,
      lastSyncAt: status?.lastSyncAt ?? null,
      error: enabled ? (status?.error ?? null) : null,
      profiles: [...(stored?.profiles ?? [])],
    };
  }

  #setStatus(machineId: string, state: SidebarSyncState, error: string | null = null, synced = false): void {
    const before = this.#status.get(machineId);
    const next = { state, error, lastSyncAt: synced ? new Date().toISOString() : (before?.lastSyncAt ?? null) };
    this.#status.set(machineId, next);
    if (!before || before.state !== next.state || before.error !== next.error || synced) this.#options.onStatus(machineId);
  }

  /**
   * The switch (`PUT /api/machines/{id}/sidebar-sync`), D179: for one profile (the one the browser
   * works in). Turning it on exchanges everything at once (when reachable).
   */
  async setEnabled(machineId: string, enabled: boolean, profile: string = DEFAULT_USER_PROFILE_ID): Promise<void> {
    const current = (await this.#load())[machineId];
    const set = new Set(current?.profiles ?? []);
    if (enabled) set.add(profile);
    else set.delete(profile);
    const profiles = [...set];
    await this.#save(machineId, { enabled: profiles.length > 0, mergedAt: current?.mergedAt ?? null, profiles });
    if (profiles.length === 0) this.#status.delete(machineId);
    this.#options.onStatus(machineId);
    if (enabled) await this.exchange(machineId);
  }

  /** The machine was forgotten: its switch goes (the layout here stays as it is). */
  async forget(machineId: string): Promise<void> {
    this.#status.delete(machineId);
    if ((await this.#load())[machineId]) await this.#save(machineId, null);
  }

  /** The connection to `machineId` came (back) online: catch up both ways. */
  connected(machineId: string): void {
    if (this.enabled(machineId)) void this.exchange(machineId);
  }

  /** The connection went away: say so (it catches up at the next connect). */
  disconnected(machineId: string): void {
    if (this.enabled(machineId)) this.#setStatus(machineId, 'unreachable');
  }

  /** The layout changed here (a route, or a merge from `origin`): send the records written to every other machine it is on with. */
  changed(changes: RecordChanges, origin: string | null = null): void {
    if (noChanges(changes)) return;
    for (const machineId of this.#options.machines()) {
      if (machineId === origin || !this.enabled(machineId)) continue;
      void this.#send(machineId, changes);
    }
  }

  /** Publishes a merged layout to every tab and sends what changed on (not back to `origin`). */
  #applied(write: SidebarWrite, origin: string | null): void {
    if (noChanges(write.changes)) return;
    this.#options.bus.publish('sidebarLayoutChanged', write.layout);
    this.changed(write.changes, origin);
  }

  async #message(machineId: string, full: boolean, changes: RecordChanges | null): Promise<SidebarSyncMessage> {
    const selfId = await this.#options.selfId();
    const all = await this.#options.store.sidebar.records();
    const records = this.#shared(machineId, changes ?? all, all.folders, await this.#live());
    return { v: SIDEBAR_SYNC_VERSION, full, ...toWire(records, selfId) };
  }

  /**
   * D179: only the records of the profiles that share with `machineId` (this computer's ids):
   * their folders, and the places of their sessions. A place in a folder goes with that folder's
   * profile; a session placed elsewhere goes with its own profile (one not known yet: sent / taken,
   * the layout shown is cut to each profile anyway). Pinned crews and projects go while any profile shares.
   */
  #shared(machineId: string, changes: RecordChanges, knownFolders: readonly FolderRecord[], live: ReadonlySet<string> | null): RecordChanges {
    const profiles = this.profilesFor(machineId);
    const folderProfile = new Map<string, string>();
    for (const folder of knownFolders) folderProfile.set(folder.id, folder.userProfileId ?? DEFAULT_USER_PROFILE_ID);
    for (const folder of changes.folders) folderProfile.set(folder.id, folder.userProfileId ?? DEFAULT_USER_PROFILE_ID);
    const folders = changes.folders.filter((folder) => profiles.has(folder.userProfileId ?? DEFAULT_USER_PROFILE_ID) && (live === null || live.has(folder.userProfileId ?? DEFAULT_USER_PROFILE_ID)));
    const places = changes.places.filter((place) => {
      if (isCrewPinId(place.sessionId) || isPlanPinId(place.sessionId)) return profiles.size > 0;
      const session = this.#options.profileOfSession?.(place.sessionId) ?? null;
      if (session !== null && !profiles.has(session)) return false;
      if (place.group !== 'folder' || place.folderId === null) return true;
      const folder = folderProfile.get(place.folderId);
      // A place in a folder of another profile than its session's is never shared (it would hide the session there).
      if (folder !== undefined && session !== null && folder !== session) return false;
      return folder === undefined ? session !== null : profiles.has(folder);
    });
    return { folders, places };
  }

  async #live(): Promise<ReadonlySet<string> | null> {
    return this.#options.liveProfiles ? await this.#options.liveProfiles() : null;
  }

  /** Sends a live change (`full: false`). */
  async #send(machineId: string, changes: RecordChanges): Promise<void> {
    const connection = this.#options.connection(machineId);
    if (!connection || connection.state !== 'online') {
      this.#setStatus(machineId, 'unreachable');
      return;
    }
    try {
      const answer = await connection.request('POST', SIDEBAR_SYNC_PATH, await this.#message(machineId, false, changes), { timeoutMs: SYNC_TIMEOUT_MS });
      this.#answered(machineId, answer, false);
    } catch (error) {
      this.#failed(machineId, error);
    }
  }

  /** The full exchange with `machineId` (one at a time per machine). */
  exchange(machineId: string): Promise<void> {
    const running = this.#exchanges.get(machineId);
    if (running) return running.then(() => this.exchange(machineId));
    const run = this.#exchange(machineId).finally(() => this.#exchanges.delete(machineId));
    this.#exchanges.set(machineId, run);
    return run;
  }

  async #exchange(machineId: string): Promise<void> {
    if (!this.enabled(machineId)) return;
    const connection = this.#options.connection(machineId);
    if (!connection || connection.state !== 'online') {
      this.#setStatus(machineId, 'unreachable');
      return;
    }
    let answer: { readonly status: number; readonly body: unknown };
    try {
      answer = await connection.request('POST', SIDEBAR_SYNC_PATH, await this.#message(machineId, true, null), { timeoutMs: SYNC_TIMEOUT_MS });
    } catch (error) {
      this.#failed(machineId, error);
      return;
    }
    const body = this.#answered(machineId, answer, true);
    if (!body || !this.enabled(machineId)) return;
    try {
      const selfId = await this.#options.selfId();
      const incoming = fromWire(body, selfId);
      if (incoming.dropped > 0) this.#options.log('warn', `sidebar sync with ${machineId}: ${incoming.dropped} malformed item(s) left out`);
      this.#applied(await this.#options.store.sidebar.merge(await this.#incoming(machineId, incoming.changes)), machineId);
      await this.#firstMerge(machineId);
    } catch (error) {
      this.#failed(machineId, error);
    }
  }

  /**
   * D179: what a paired machine sent, as this machine takes it: profiles translated (D172), then
   * only the records of the profiles this machine shares with it (the same rule as sending).
   */
  async #incoming(machineId: string, changes: RecordChanges): Promise<RecordChanges> {
    const mapped = this.#mapped(machineId, changes);
    return this.#shared(machineId, mapped, (await this.#options.store.sidebar.records()).folders, await this.#live());
  }

  /** D172: a paired machine's folder records with their profile as this machine names it. */
  #mapped<T extends { readonly folders: readonly { readonly userProfileId?: string }[] }>(machineId: string, changes: T): T {
    const map = this.#options.mapProfile;
    if (!map) return changes;
    return { ...changes, folders: changes.folders.map((folder) => (folder.userProfileId === undefined ? folder : { ...folder, userProfileId: map(machineId, folder.userProfileId) })) };
  }

  /** Reads an answer: the state it means, and its body when it carries records. */
  #answered(machineId: string, answer: { readonly status: number; readonly body: unknown }, full: boolean): SidebarSyncAnswer | null {
    if (answer.status === 404 || answer.status === 403 || answer.status === 405) {
      this.#setStatus(machineId, 'unsupported');
      return null;
    }
    if (answer.status === 401) {
      this.#setStatus(machineId, 'error', 'the other machine refused this pairing');
      return null;
    }
    const body = answer.body as SidebarSyncAnswer | null;
    if (answer.status !== 200 || !body || typeof body !== 'object') {
      this.#setStatus(machineId, 'error', `the exchange answered HTTP ${answer.status}`);
      return null;
    }
    if (body.v !== SIDEBAR_SYNC_VERSION) {
      this.#setStatus(machineId, 'unsupported');
      return null;
    }
    if (body.enabled !== true) {
      this.#setStatus(machineId, 'waiting');
      return null;
    }
    this.#setStatus(machineId, 'synced', null, true);
    return full ? body : null;
  }

  #failed(machineId: string, error: unknown): void {
    if (error instanceof PeerUnreachableError) {
      this.#setStatus(machineId, 'unreachable');
      return;
    }
    this.#setStatus(machineId, 'error', error instanceof Error ? error.message : String(error));
    this.#options.onError(error);
  }

  /** D71 first enable ("always merge"): once both layouts are in, same-named folders at the same place are combined. */
  async #firstMerge(machineId: string): Promise<void> {
    const stored = (await this.#load())[machineId];
    if (!stored?.enabled || stored.mergedAt !== null) return;
    const combined = await this.#options.store.sidebar.combineSameNamed();
    await this.#save(machineId, { ...stored, mergedAt: new Date().toISOString() });
    this.#options.log('info', `sidebar layout merged with ${machineId}`);
    // Sent to every machine it is on with, this one included (it combines the same folders, the same way).
    this.#applied(combined, null);
    this.#options.onStatus(machineId);
  }

  /**
   * `POST /peer/v1/sidebar` from `machineId`: merged when this machine's switch
   * for it is on (else `enabled: false`, nothing taken); a full message is
   * answered with all of this machine's records.
   */
  async receive(machineId: string, body: unknown): Promise<{ readonly status: number; readonly body: SidebarSyncAnswer | { readonly error: string; readonly message: string } }> {
    const message = readSyncMessage(body);
    if (!message) return { status: 400, body: { error: 'invalid', message: 'expected { v, full, folders, places }' } };
    if (message.v !== SIDEBAR_SYNC_VERSION) return { status: 200, body: { v: SIDEBAR_SYNC_VERSION, enabled: false } };
    await this.#load();
    if (!this.enabled(machineId)) return { status: 200, body: { v: SIDEBAR_SYNC_VERSION, enabled: false } };
    const selfId = await this.#options.selfId();
    const incoming = fromWire(message, selfId);
    if (incoming.dropped > 0) this.#options.log('warn', `sidebar sync from ${machineId}: ${incoming.dropped} malformed item(s) left out`);
    this.#applied(await this.#options.store.sidebar.merge(await this.#incoming(machineId, incoming.changes)), machineId);
    this.#setStatus(machineId, 'synced', null, true);
    if (!message.full) return { status: 200, body: { v: SIDEBAR_SYNC_VERSION, enabled: true } };
    await this.#firstMerge(machineId);
    return { status: 200, body: { ...(await this.#message(machineId, true, null)), enabled: true } as SidebarSyncAnswer };
  }
}
