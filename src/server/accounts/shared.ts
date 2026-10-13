import type { HubBus } from '../hub/bus.ts';
import type { CliProviderId } from '../../core/cli-providers.ts';
import type { MachineState } from '../../core/peers.ts';
import {
  ACCOUNT_PREFS_KEY,
  type AccountPrefs,
  type OrderPref,
  type PeerAccounts,
  type PrefsMerge,
  type RemoteCopy,
  SHARED_ACCOUNTS_VERSION,
  type SharedAccount,
  type SharedAccountsMessage,
  applySharedOrder,
  mergeAccountPrefs,
  readAccountPrefs,
  readSharedAccount,
  readSharedAccountsMessage,
} from '../../core/shared-accounts.ts';
import type { Store } from '../db/store.ts';
import type { AccountService, LocalAccountChange, SharedAccountsSource } from './service.ts';

/** The peer API calls the shared accounts need (`PeerService`). */
export interface SharedAccountsPeers {
  self(): Promise<{ readonly id: string; readonly name: string }>;
  machines(): Promise<ReadonlyArray<{ readonly id: string; readonly name: string; readonly state: MachineState }>>;
  ask(machineId: string, method: string, path: string, body: unknown, options: { readonly timeoutMs: number }): Promise<{ readonly status: number; readonly body: unknown } | { readonly status: null; readonly reason: string }>;
}

/** Options of {@link SharedAccounts}. */
export interface SharedAccountsOptions {
  readonly accounts: AccountService;
  readonly store: Store;
  readonly peers: SharedAccountsPeers;
  /** `machineState` events: a machine coming online is synced at once, a removed one forgotten. */
  readonly bus?: HubBus;
  readonly now?: () => number;
  /** Gap between two exchanges with every online machine (default 30 s). */
  readonly intervalMs?: number;
  /** A local change is sent after this (default 300 ms; changes in between go together). */
  readonly pushDelayMs?: number;
  /** Time limit of one exchange (default 10 s). */
  readonly timeoutMs?: number;
  readonly onError?: (error: unknown) => void;
  readonly log?: (line: string) => void;
}

/** The exchange's route (on the peer API allow-list). */
export const SHARED_ACCOUNTS_PATH = '/api/accounts/shared';

interface Entry {
  readonly machineId: string;
  readonly machineName: string;
  readonly legacy: boolean;
  readonly accounts: readonly SharedAccount[];
}

/**
 * D98 (`docs/accounts.md` → *Shared across paired machines*): the accounts of the
 * paired machines (D48), and this machine's sent to them. Every 30 s, at once when
 * a machine comes online, and shortly after a local change (a rename, a new order,
 * a spent mark), each online machine gets `POST /api/accounts/shared` with this
 * machine's accounts and shared prefs, and answers with its own: both ends keep the
 * other's accounts (last known; a machine that is away keeps its spent marks until
 * their reset, but drops out of the lists) and merge the prefs (last writer wins
 * per identity's name and per CLI's order), applying a name or order that came from
 * the other machine to the same accounts here. An older Switchboard (no such route:
 * 403 / 404) is read with `GET /api/accounts` and shown unmerged. A machine never
 * sends anything that signs in: names, identities (the email the CLI reports),
 * usage readings and spent marks only.
 */
export class SharedAccounts implements SharedAccountsSource {
  readonly #o: SharedAccountsOptions;
  readonly #entries = new Map<string, Entry>();
  readonly #online = new Set<string>();
  #prefs: AccountPrefs | null = null;
  #timer: NodeJS.Timeout | undefined;
  #soon: NodeJS.Timeout | undefined;
  #running: Promise<void> | null = null;
  #again = false;
  #closed = false;
  #off: (() => void) | null = null;

  constructor(options: SharedAccountsOptions) {
    this.#o = options;
  }

  #now(): number {
    return this.#o.now?.() ?? Date.now();
  }

  #error(error: unknown): void {
    (this.#o.onError ?? ((e) => console.error('switchboard shared accounts:', e)))(error);
  }

  #log(line: string): void {
    (this.#o.log ?? ((l: string) => console.info(`switchboard accounts: ${l}`)))(line);
  }

  /** Starts the periodic exchange and follows the machines' states. */
  start(): void {
    if (this.#timer || this.#closed) return;
    this.#timer = setInterval(() => void this.sync(), this.#o.intervalMs ?? 30_000);
    this.#timer.unref();
    this.#off =
      this.#o.bus?.subscribe((message) => {
        if (message.name !== 'machineState') return;
        const machine = message.payload;
        if (machine.removed === true) {
          this.#entries.delete(machine.id);
          this.#online.delete(machine.id);
        } else if (machine.state === 'online') {
          this.#online.add(machine.id);
          this.soon();
        } else {
          this.#online.delete(machine.id);
        }
      }) ?? null;
    this.soon();
  }

  async stop(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    clearTimeout(this.#soon);
    this.#off?.();
    this.#off = null;
    await this.#running?.catch(() => undefined);
  }

  /** An exchange with every online machine shortly (changes in between go together). */
  soon(): void {
    if (this.#closed || this.#soon) return;
    this.#soon = setTimeout(() => {
      this.#soon = undefined;
      void this.sync();
    }, this.#o.pushDelayMs ?? 300);
    this.#soon.unref();
  }

  /** One exchange with every online machine (an overlapping call runs once more after it). */
  sync(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = this.#sync()
      .catch((error: unknown) => this.#error(error))
      .finally(() => {
        this.#running = null;
        if (this.#again && !this.#closed) {
          this.#again = false;
          void this.sync();
        }
      });
    return this.#running;
  }

  async #sync(): Promise<void> {
    if (this.#closed) return;
    const machines = await this.#o.peers.machines();
    const known = new Set(machines.map((m) => m.id));
    for (const id of [...this.#entries.keys()]) if (!known.has(id)) this.#entries.delete(id);
    this.#online.clear();
    for (const m of machines) if (m.state === 'online') this.#online.add(m.id);
    const online = machines.filter((m) => m.state === 'online');
    if (online.length === 0) return;
    const message = await this.message();
    await Promise.all(online.map((m) => this.#exchange(m, message).catch((error: unknown) => this.#error(error))));
  }

  async #exchange(machine: { readonly id: string; readonly name: string }, message: SharedAccountsMessage): Promise<void> {
    const timeoutMs = this.#o.timeoutMs ?? 10_000;
    const answer = await this.#o.peers.ask(machine.id, 'POST', SHARED_ACCOUNTS_PATH, message, { timeoutMs });
    if (answer.status === null) return;
    if (answer.status >= 200 && answer.status < 300) {
      await this.receive(machine.id, machine.name, answer.body);
      return;
    }
    if (answer.status !== 403 && answer.status !== 404) return;
    // An older Switchboard (before D98): its accounts are listed, never merged.
    const old = await this.#o.peers.ask(machine.id, 'GET', '/api/accounts', undefined, { timeoutMs });
    if (old.status === null || old.status < 200 || old.status >= 300) return;
    const profiles = (old.body as { profiles?: unknown } | null)?.profiles;
    if (!Array.isArray(profiles)) return;
    const accounts = profiles.map((p) => readSharedAccount(p, { legacy: true })).filter((a): a is SharedAccount => a !== null);
    this.#entries.set(machine.id, { machineId: machine.id, machineName: machine.name, legacy: true, accounts });
  }

  // ── this machine's side ───────────────────────────────────────────────────

  async #prefsNow(): Promise<AccountPrefs> {
    this.#prefs ??= readAccountPrefs(await this.#o.store.settings.get(ACCOUNT_PREFS_KEY));
    return this.#prefs;
  }

  async #savePrefs(prefs: AccountPrefs): Promise<void> {
    this.#prefs = prefs;
    await this.#o.store.settings.set(ACCOUNT_PREFS_KEY, prefs);
  }

  /** This machine's accounts (its own facts only) and its shared prefs. */
  async message(): Promise<SharedAccountsMessage> {
    const accounts = this.#o.accounts;
    // An enabled Claude Code account whose identity is not known yet is checked once (its status command, cached as always).
    for (const record of await this.#o.store.profiles.list('claude')) {
      if (record.enabled && !accounts.checked(record.id) && (await accounts.identityOf(record.id)) === null) await accounts.check(record.id).catch(() => null);
    }
    const self = await this.#o.peers.self();
    const profiles = await accounts.list({ check: false, local: true });
    return {
      v: SHARED_ACCOUNTS_VERSION,
      machine: { id: self.id, name: self.name },
      accounts: profiles.map((p) => ({
        profileId: p.id,
        cli: p.cli,
        name: p.name,
        identity: p.identity ?? null,
        account: p.account,
        enabled: p.enabled,
        position: p.position,
        signIn: p.signIn,
        usage: p.usage,
        exhausted: p.exhausted,
      })),
      prefs: await this.#prefsNow(),
    };
  }

  /**
   * A machine's message (its answer, or its request to `POST /api/accounts/shared`):
   * its accounts are kept, its prefs merged and what it won applied here. `false`
   * when the body is not a message.
   */
  async receive(machineId: string, machineName: string, body: unknown): Promise<boolean> {
    const message = readSharedAccountsMessage(body);
    if (!message) return false;
    this.#entries.set(machineId, { machineId, machineName, legacy: false, accounts: message.accounts });
    this.#online.add(machineId);
    const merge = mergeAccountPrefs(await this.#prefsNow(), message.prefs);
    if (merge.names.length > 0 || merge.order.length > 0) {
      await this.#savePrefs(merge.prefs);
      await this.#apply(merge, machineName);
    }
    return true;
  }

  /** A name or order that came from another machine, on the same accounts here (no new timestamps: nothing echoes). */
  async #apply(merge: PrefsMerge, from: string): Promise<void> {
    const accounts = this.#o.accounts;
    const store = this.#o.store;
    for (const identity of merge.names) {
      const name = merge.prefs.names[identity]?.name;
      if (!name) continue;
      for (const record of await store.profiles.list()) {
        if (record.name === name || (await accounts.identityOf(record.id)) !== identity) continue;
        const taken = (await store.profiles.list(record.cli)).some((p) => p.id !== record.id && p.name.toLowerCase() === name.toLowerCase());
        if (taken) {
          this.#log(`the name "${name}" from ${from} is taken by another ${record.cli} account here: kept "${record.name}"`);
          continue;
        }
        await store.profiles.update(record.id, { name });
        this.#log(`renamed "${record.name}" to "${name}" (as on ${from})`);
      }
    }
    for (const cli of merge.order) {
      const identities = merge.prefs.order[cli]?.identities;
      if (!identities) continue;
      const records = await store.profiles.list(cli);
      const local = await Promise.all(records.map(async (r) => ({ id: r.id, identity: await accounts.identityOf(r.id) })));
      const next = applySharedOrder(local, identities);
      if (next.join(',') !== records.map((r) => r.id).join(',')) {
        await store.profiles.reorder(cli, next);
        this.#log(`${cli} accounts reordered as on ${from}`);
      }
    }
  }

  // ── SharedAccountsSource ──────────────────────────────────────────────────

  copies(identity: string): RemoteCopy[] {
    const out: RemoteCopy[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.legacy) continue;
      for (const account of entry.accounts) {
        if (account.identity === identity) out.push({ machineId: entry.machineId, machineName: entry.machineName, online: this.#online.has(entry.machineId), account });
      }
    }
    return out;
  }

  async peers(): Promise<PeerAccounts[]> {
    return [...this.#entries.values()].map((entry) => ({ ...entry, online: this.#online.has(entry.machineId) }));
  }

  async selfName(): Promise<string> {
    return (await this.#o.peers.self()).name;
  }

  async changed(change: LocalAccountChange): Promise<void> {
    try {
      const accounts = this.#o.accounts;
      if (change.kind === 'name') {
        const identity = await accounts.identityOf(change.profileId);
        if (identity !== null) {
          const prefs = await this.#prefsNow();
          await this.#savePrefs({ ...prefs, names: { ...prefs.names, [identity]: { name: change.name, at: this.#now() } } });
        }
      } else if (change.kind === 'order') {
        const records = await this.#o.store.profiles.list(change.cli);
        const identities: string[] = [];
        for (const record of records) {
          const identity = await accounts.identityOf(record.id);
          if (identity !== null && !identities.includes(identity)) identities.push(identity);
        }
        if (identities.length > 0) {
          const prefs = await this.#prefsNow();
          const order: Partial<Record<CliProviderId, OrderPref>> = { ...prefs.order, [change.cli]: { identities, at: this.#now() } };
          await this.#savePrefs({ ...prefs, order });
        }
      }
      this.soon();
    } catch (error) {
      this.#error(error);
    }
  }
}
