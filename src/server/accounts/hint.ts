import { type HintProfile, type SingleAccountHint, hintDetail, hintTitle, hintView, singleAccountHints } from '../../core/account-hint.ts';
import type { AccountHintView } from '../../core/account-hint.ts';
import { CLI_PROVIDERS, type CliProviderId } from '../../core/cli-providers.ts';
import type { SystemItemService } from '../inbox/system-items.ts';
import type { AccountService } from './service.ts';
import type { SharedAccounts } from './shared.ts';

/** Options of {@link AccountHint}. */
export interface AccountHintOptions {
  readonly accounts: Pick<AccountService, 'settings' | 'list' | 'check' | 'onLocalChange'>;
  /** D98's exchange: the paired machines' accounts as last known, and this machine's name. */
  readonly shared: Pick<SharedAccounts, 'peers' | 'selfName' | 'ready' | 'onChange'>;
  readonly systemItems?: Pick<SystemItemService, 'accountHintNotice' | 'closeAccountHints'>;
  /** Gap between two periodic looks (default 30 s); a change (an exchange, a local account or rule change) looks sooner. */
  readonly intervalMs?: number;
  /** A change looks after this (default 500 ms; changes in between go together). */
  readonly delayMs?: number;
  readonly onError?: (error: unknown) => void;
}

/**
 * D142 (`docs/accounts.md` → *One account here, more on a paired machine*): looks, per CLI
 * with automatic switching on, whether this machine has a single usable account while a
 * paired machine (D98's exchange, online or last known) has another one this machine lacks
 * (`singleAccountHints`). Then one informational Inbox item on this machine, "Marcins-PC
 * can't switch Claude Code accounts", which the paired machines' merged Inbox shows with
 * this machine's name; **Add it there** opens Settings › Accounts here with the Add form
 * prefilled. The item is brought up to date in place, closed (`resolved`) when the hint no
 * longer holds (a second usable account here, the paired machine's account gone, switching
 * turned off), and stays away once dismissed until a new missing account appears. Until
 * the first exchange round after a start, only the local reasons close it (the paired
 * machines are not known yet).
 */
export class AccountHint {
  readonly #o: AccountHintOptions;
  #timer: NodeJS.Timeout | undefined;
  #soon: NodeJS.Timeout | undefined;
  #offs: Array<() => void> = [];
  #running: Promise<void> | null = null;
  #again = false;
  #closed = false;

  constructor(options: AccountHintOptions) {
    this.#o = options;
  }

  #error(error: unknown): void {
    (this.#o.onError ?? ((e) => console.error('switchboard account hint:', e)))(error);
  }

  /** Starts the periodic look and follows the exchange and the local changes. */
  start(): void {
    if (this.#timer || this.#closed) return;
    this.#timer = setInterval(() => void this.check(), this.#o.intervalMs ?? 30_000);
    this.#timer.unref();
    this.#offs = [this.#o.shared.onChange(() => this.soon()), this.#o.accounts.onLocalChange(() => this.soon())];
  }

  async stop(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    clearTimeout(this.#soon);
    for (const off of this.#offs) off();
    this.#offs = [];
    await this.#running?.catch(() => undefined);
  }

  /** A look shortly (changes in between go together). */
  soon(): void {
    if (this.#closed || this.#soon) return;
    this.#soon = setTimeout(() => {
      this.#soon = undefined;
      void this.check();
    }, this.#o.delayMs ?? 500);
    this.#soon.unref();
  }

  /**
   * The hints that hold now (each enabled Claude Code profile's sign-in read first, cached 60 s).
   * No paired machine with a Claude Code account to offer → no hint, and no sign-in is read:
   * a machine without peers never runs `claude auth status` for this.
   */
  async hints(): Promise<SingleAccountHint[]> {
    const settings = await this.#o.accounts.settings();
    if (!settings.enabled || !settings.perCli.claude) return [];
    const peers = await this.#o.shared.peers();
    if (!peers.some((peer) => !peer.legacy && peer.accounts.some((a) => a.cli === 'claude' && a.enabled && a.signIn !== 'signed-out' && a.identity !== null))) return [];
    const profiles: HintProfile[] = [];
    for (const profile of await this.#o.accounts.list({ check: false, local: true })) {
      // Only Claude Code accounts have an identity (D98): only its sign-ins are needed.
      const signIn = profile.cli === 'claude' && profile.enabled && settings.perCli.claude ? (await this.#o.accounts.check(profile.id).catch(() => ({ signIn: 'unknown' as const }))).signIn : profile.signIn;
      profiles.push({ id: profile.id, cli: profile.cli, name: profile.name, enabled: profile.enabled, signIn, identity: profile.identity ?? null });
    }
    return singleAccountHints({ settings, profiles, peers });
  }

  /** The hint of `cli` now, `null` when it does not hold (the switcher's cue). */
  async hintFor(cli: CliProviderId): Promise<SingleAccountHint | null> {
    return (await this.hints()).find((hint) => hint.cli === cli) ?? null;
  }

  /** Settings › Accounts' lines (`AccountsOverview.hints`). */
  async views(): Promise<AccountHintView[]> {
    const hints = await this.hints();
    if (hints.length === 0) return [];
    const self = await this.#o.shared.selfName();
    return hints.map((hint) => hintView(self, hint));
  }

  /** One look: raises, updates or closes the Inbox item of each CLI (an overlapping call runs once more after it). */
  check(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = this.#check()
      .catch((error: unknown) => this.#error(error))
      .finally(() => {
        this.#running = null;
        if (this.#again && !this.#closed) {
          this.#again = false;
          void this.check();
        }
      });
    return this.#running;
  }

  async #check(): Promise<void> {
    const items = this.#o.systemItems;
    if (this.#closed || !items) return;
    const hints = await this.hints();
    const self = hints.length > 0 ? await this.#o.shared.selfName() : '';
    for (const cli of CLI_PROVIDERS) {
      const hint = hints.find((h) => h.cli === cli);
      if (hint) {
        await items.accountHintNotice({
          cli,
          title: hintTitle(self, cli),
          detail: hintDetail(self, hint),
          key: hint.key,
          identities: hint.missing.map((m) => m.identity),
          add: { cli, name: (hint.missing[0] as SingleAccountHint['missing'][number]).name },
        });
      } else if (this.#o.shared.ready || !(await this.#localMayHold(cli))) {
        // Before the first exchange round the paired machines are not known yet: only a local reason closes it.
        await items.closeAccountHints(cli, 'resolved');
      }
    }
  }

  /** `true` while the local half of the hint may hold for `cli` (switching on, exactly one usable account here). */
  async #localMayHold(cli: CliProviderId): Promise<boolean> {
    const settings = await this.#o.accounts.settings();
    if (!settings.enabled || !settings.perCli[cli]) return false;
    const mine = (await this.#o.accounts.list({ check: false, local: true })).filter((p) => p.cli === cli && p.enabled && p.signIn !== 'signed-out');
    return mine.length === 1;
  }
}
