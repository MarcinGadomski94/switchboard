import type { MachineSidebarSync, SidebarSyncState } from '../../core/peers.ts';
import { type RecordChanges, noChanges } from '../../core/sidebar-records.ts';
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
  readonly enabled: boolean;
  readonly mergedAt: string | null;
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
      const entry = value as { enabled?: unknown; mergedAt?: unknown } | null;
      if (entry && typeof entry === 'object') out[id] = { enabled: entry.enabled === true, mergedAt: typeof entry.mergedAt === 'string' ? entry.mergedAt : null };
    }
    this.#switches = out;
    return out;
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

  /** `true` when this machine's switch for `machineId` is on. */
  enabled(machineId: string): boolean {
    return this.#switches?.[machineId]?.enabled === true;
  }

  /** What the Machine row shows (`Machine.sidebarSync`). */
  view(machineId: string): MachineSidebarSync {
    const stored = this.#switches?.[machineId];
    const status = this.#status.get(machineId);
    const enabled = stored?.enabled === true;
    return {
      enabled,
      state: enabled ? (status?.state ?? 'connecting') : 'off',
      mergedAt: stored?.mergedAt ?? null,
      lastSyncAt: status?.lastSyncAt ?? null,
      error: enabled ? (status?.error ?? null) : null,
    };
  }

  #setStatus(machineId: string, state: SidebarSyncState, error: string | null = null, synced = false): void {
    const before = this.#status.get(machineId);
    const next = { state, error, lastSyncAt: synced ? new Date().toISOString() : (before?.lastSyncAt ?? null) };
    this.#status.set(machineId, next);
    if (!before || before.state !== next.state || before.error !== next.error || synced) this.#options.onStatus(machineId);
  }

  /** The switch (`PUT /api/machines/{id}/sidebar-sync`). Turning it on exchanges everything at once (when reachable). */
  async setEnabled(machineId: string, enabled: boolean): Promise<void> {
    const current = (await this.#load())[machineId];
    await this.#save(machineId, { enabled, mergedAt: current?.mergedAt ?? null });
    this.#status.delete(machineId);
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

  async #message(full: boolean, changes: RecordChanges | null): Promise<SidebarSyncMessage> {
    const selfId = await this.#options.selfId();
    const records = changes ?? (await this.#options.store.sidebar.records());
    return { v: SIDEBAR_SYNC_VERSION, full, ...toWire(records, selfId) };
  }

  /** Sends a live change (`full: false`). */
  async #send(machineId: string, changes: RecordChanges): Promise<void> {
    const connection = this.#options.connection(machineId);
    if (!connection || connection.state !== 'online') {
      this.#setStatus(machineId, 'unreachable');
      return;
    }
    try {
      const answer = await connection.request('POST', SIDEBAR_SYNC_PATH, await this.#message(false, changes), { timeoutMs: SYNC_TIMEOUT_MS });
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
      answer = await connection.request('POST', SIDEBAR_SYNC_PATH, await this.#message(true, null), { timeoutMs: SYNC_TIMEOUT_MS });
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
      this.#applied(await this.#options.store.sidebar.merge(incoming.changes), machineId);
      await this.#firstMerge(machineId);
    } catch (error) {
      this.#failed(machineId, error);
    }
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
    await this.#save(machineId, { enabled: true, mergedAt: new Date().toISOString() });
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
    this.#applied(await this.#options.store.sidebar.merge(incoming.changes), machineId);
    this.#setStatus(machineId, 'synced', null, true);
    if (!message.full) return { status: 200, body: { v: SIDEBAR_SYNC_VERSION, enabled: true } };
    await this.#firstMerge(machineId);
    return { status: 200, body: { ...(await this.#message(true, null)), enabled: true } as SidebarSyncAnswer };
  }
}
