/**
 * D98 (`docs/accounts.md` → *Shared across paired machines*): the accounts of
 * paired machines (D48) shared and merged. Pure, shared by the server (the
 * exchange, the switcher's view, the footer rows) and the UI:
 * - an account's **identity** is what its CLI reports about the login (Claude
 *   Code: the email); Codex's `codex login status` names no account and OpenCode
 *   reports none, so their accounts are never merged;
 * - the same identity on two machines is **one account**: its newest usage
 *   reading counts on both, and so does a "spent until" mark;
 * - its **display name** and each CLI's **account order** are shared as an
 *   identity-keyed map, last writer wins by timestamp.
 * Never anything that signs in: no token, no credential file (each machine signs
 * in on its own).
 */
import type { ProfileExhausted, ProfileSignIn, ProfileUsage } from './accounts.ts';
import { type CliProviderId, isCliProviderId } from './cli-providers.ts';

/** The version of {@link SharedAccountsMessage}. */
export const SHARED_ACCOUNTS_VERSION = 1;

/** Settings key of this machine's shared names and order ({@link AccountPrefs}). */
export const ACCOUNT_PREFS_KEY = 'accounts.shared';

/** Settings key of each profile's last known identity (`{ [profileId]: { identity, account } }`). */
export const ACCOUNT_IDENTITIES_KEY = 'accounts.identities';

const EMAIL = /^[^\s@·]+@[^\s@·]+$/;

/**
 * The identity of the account a profile is signed in to, from what its CLI's
 * status reported (`AccountProfile.account`): Claude Code `claude:<email>`
 * (lower case; the plan is only shown); `null` for Codex (its status says only
 * "Logged in using ChatGPT", ASSUMED D98-codex-identity), OpenCode (no identity)
 * and anything that is not an email.
 */
export function accountIdentity(cli: CliProviderId, account: string | null | undefined): string | null {
  if (cli !== 'claude' || typeof account !== 'string') return null;
  const email = (account.split(' · ')[0] ?? '').trim();
  return EMAIL.test(email) ? `claude:${email.toLowerCase()}` : null;
}

/** One account of a machine as the exchange carries it (this machine's own facts only). */
export interface SharedAccount {
  readonly profileId: string;
  readonly cli: CliProviderId;
  readonly name: string;
  /** {@link accountIdentity}; `null` = never merged. */
  readonly identity: string | null;
  /** What the CLI reports (`dev@example.com · max`), for the label. */
  readonly account: string | null;
  readonly enabled: boolean;
  readonly position: number;
  readonly signIn: ProfileSignIn;
  readonly usage: ProfileUsage | null;
  readonly exhausted: ProfileExhausted | null;
}

/** A shared display name (last writer wins by `at`, epoch ms). */
export interface NamePref {
  readonly name: string;
  readonly at: number;
}

/** A CLI's shared account order: identities first to last (last writer wins by `at`). */
export interface OrderPref {
  readonly identities: readonly string[];
  readonly at: number;
}

/** The names and order shared with paired machines (setting {@link ACCOUNT_PREFS_KEY}). */
export interface AccountPrefs {
  readonly names: Readonly<Record<string, NamePref>>;
  readonly order: Readonly<Partial<Record<CliProviderId, OrderPref>>>;
}

export const EMPTY_ACCOUNT_PREFS: AccountPrefs = { names: {}, order: {} };

/** `POST /api/accounts/shared` body and answer: one machine's accounts and prefs. */
export interface SharedAccountsMessage {
  readonly v: typeof SHARED_ACCOUNTS_VERSION;
  readonly machine: { readonly id: string; readonly name: string };
  readonly accounts: readonly SharedAccount[];
  readonly prefs: AccountPrefs;
}

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function readUsage(value: unknown): ProfileUsage | null {
  const o = rec(value);
  if (!o) return null;
  return {
    fiveHourPct: num(o['fiveHourPct']),
    fiveHourResetsAt: str(o['fiveHourResetsAt']),
    sevenDayPct: num(o['sevenDayPct']),
    sevenDayResetsAt: str(o['sevenDayResetsAt']),
    receivedAt: str(o['receivedAt']),
  };
}

function readExhausted(value: unknown): ProfileExhausted | null {
  const o = rec(value);
  const until = str(o?.['until']);
  if (!o || until === null || !Number.isFinite(Date.parse(until))) return null;
  const window = o['window'] === 'session' || o['window'] === 'weekly' ? o['window'] : 'unknown';
  return { until, window, text: str(o['text']) };
}

/**
 * One account read defensively (a peer's message, or an older peer's
 * `GET /api/accounts` profile when `legacy`: its identity is then always `null`,
 * so it shows unmerged).
 */
export function readSharedAccount(value: unknown, options: { readonly legacy?: boolean } = {}): SharedAccount | null {
  const o = rec(value);
  if (!o) return null;
  const profileId = str(o['profileId'] ?? o['id']);
  const name = str(o['name']);
  if (!profileId || !name || !isCliProviderId(o['cli'])) return null;
  const signIn = o['signIn'] === 'signed-in' || o['signIn'] === 'signed-out' ? o['signIn'] : 'unknown';
  const identity = options.legacy ? null : str(o['identity']);
  return {
    profileId,
    cli: o['cli'],
    name,
    identity: identity && identity.length <= 320 ? identity : null,
    account: str(o['account']),
    enabled: o['enabled'] !== false,
    position: num(o['position']) ?? 0,
    signIn,
    usage: readUsage(o['usage']),
    exhausted: readExhausted(o['exhausted']),
  };
}

/** The stored / received prefs read defensively. */
export function readAccountPrefs(value: unknown): AccountPrefs {
  const o = rec(value);
  if (!o) return EMPTY_ACCOUNT_PREFS;
  const names: Record<string, NamePref> = {};
  for (const [identity, raw] of Object.entries(rec(o['names']) ?? {})) {
    const pref = rec(raw);
    const name = str(pref?.['name']);
    const at = num(pref?.['at']);
    if (name !== null && name.trim() !== '' && name.length <= 40 && at !== null) names[identity] = { name, at };
  }
  const order: Partial<Record<CliProviderId, OrderPref>> = {};
  for (const [cli, raw] of Object.entries(rec(o['order']) ?? {})) {
    const pref = rec(raw);
    const at = num(pref?.['at']);
    const ids = pref?.['identities'];
    if (isCliProviderId(cli) && at !== null && Array.isArray(ids) && ids.every((id) => typeof id === 'string')) order[cli] = { identities: ids as string[], at };
  }
  return { names, order };
}

/** A message read defensively; `null` when it is not one. */
export function readSharedAccountsMessage(value: unknown): SharedAccountsMessage | null {
  const o = rec(value);
  const machine = rec(o?.['machine']);
  const id = str(machine?.['id']);
  if (!o || o['v'] !== SHARED_ACCOUNTS_VERSION || !id || !Array.isArray(o['accounts'])) return null;
  return {
    v: SHARED_ACCOUNTS_VERSION,
    machine: { id, name: str(machine?.['name']) ?? id },
    accounts: (o['accounts'] as unknown[]).map((a) => readSharedAccount(a)).filter((a): a is SharedAccount => a !== null),
    prefs: readAccountPrefs(o['prefs']),
  };
}

/** `true` when `a` beats `b` (later `at`; equal clocks: by value, the same on both machines). */
function wins(a: { readonly at: number }, aValue: string, b: { readonly at: number } | undefined, bValue: string): boolean {
  if (!b) return true;
  if (a.at !== b.at) return a.at > b.at;
  return aValue > bValue;
}

/** What {@link mergeAccountPrefs} took from the other machine. */
export interface PrefsMerge {
  readonly prefs: AccountPrefs;
  /** Identities whose name came from the other machine. */
  readonly names: readonly string[];
  /** CLIs whose order came from the other machine. */
  readonly order: readonly CliProviderId[];
}

/** Last writer wins per identity's name and per CLI's order. */
export function mergeAccountPrefs(local: AccountPrefs, remote: AccountPrefs): PrefsMerge {
  const names: Record<string, NamePref> = { ...local.names };
  const takenNames: string[] = [];
  for (const [identity, pref] of Object.entries(remote.names)) {
    const mine = local.names[identity];
    if (wins(pref, pref.name, mine, mine?.name ?? '')) {
      if (mine?.name === pref.name && mine.at === pref.at) continue;
      names[identity] = pref;
      takenNames.push(identity);
    }
  }
  const order: Partial<Record<CliProviderId, OrderPref>> = { ...local.order };
  const takenOrder: CliProviderId[] = [];
  for (const [cli, pref] of Object.entries(remote.order) as Array<[CliProviderId, OrderPref]>) {
    const mine = local.order[cli];
    const value = JSON.stringify(pref.identities);
    if (wins(pref, value, mine, JSON.stringify(mine?.identities ?? []))) {
      if (mine && mine.at === pref.at && JSON.stringify(mine.identities) === value) continue;
      order[cli] = pref;
      takenOrder.push(cli);
    }
  }
  return { prefs: { names, order }, names: takenNames, order: takenOrder };
}

/**
 * This machine's order of a CLI's profiles after a shared order: the profiles
 * whose identity is in `identities` take, among their own slots, the shared
 * order; every other profile (no identity, or not on the other machine) keeps
 * its slot. Returns the ids first to last.
 */
export function applySharedOrder(local: ReadonlyArray<{ readonly id: string; readonly identity: string | null }>, identities: readonly string[]): string[] {
  const rank = new Map(identities.map((identity, index) => [identity, index]));
  const shared = local.filter((p) => p.identity !== null && rank.has(p.identity));
  const sorted = [...shared].sort((a, b) => (rank.get(a.identity as string) as number) - (rank.get(b.identity as string) as number));
  let next = 0;
  return local.map((p) => (p.identity !== null && rank.has(p.identity) ? (sorted[next++] as { id: string }).id : p.id));
}

/** The time of a reading (ms), `-Infinity` when it has none. */
function readingTime(usage: ProfileUsage | null | undefined): number {
  const ms = usage?.receivedAt ? Date.parse(usage.receivedAt) : Number.NaN;
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/** One copy of an account on a paired machine. */
export interface RemoteCopy {
  readonly machineId: string;
  readonly machineName: string;
  /** The machine is connected now (else its last known copy). */
  readonly online: boolean;
  readonly account: SharedAccount;
}

/** The newest reading of an account: this machine's, or a paired machine's when newer (with that machine's name). */
export function newestUsage(local: ProfileUsage | null, copies: readonly RemoteCopy[]): { readonly usage: ProfileUsage | null; readonly from: string | null } {
  let best: { usage: ProfileUsage | null; from: string | null } = { usage: local, from: null };
  for (const copy of copies) {
    if (readingTime(copy.account.usage) > readingTime(best.usage)) best = { usage: copy.account.usage, from: copy.machineName };
  }
  return best;
}

/** The latest "spent until" in force: this machine's mark or a paired machine's (with its name). */
export function spentAcross(local: ProfileExhausted | null, copies: readonly RemoteCopy[], now: number): { readonly exhausted: ProfileExhausted | null; readonly from: string | null } {
  const live = (e: ProfileExhausted | null): number => (e && Date.parse(e.until) > now ? Date.parse(e.until) : Number.NEGATIVE_INFINITY);
  let best: { exhausted: ProfileExhausted | null; from: string | null } = { exhausted: live(local) > now ? local : null, from: null };
  for (const copy of copies) {
    if (live(copy.account.exhausted) > live(best.exhausted)) best = { exhausted: copy.account.exhausted, from: copy.machineName };
  }
  return best;
}

/** One machine's accounts as last known here (an older Switchboard's are `legacy`: never merged). */
export interface PeerAccounts {
  readonly machineId: string;
  readonly machineName: string;
  readonly online: boolean;
  readonly legacy: boolean;
  readonly accounts: readonly SharedAccount[];
}

/** An account only paired machines have (merged across them by identity). */
export interface PeerOnlyAccount {
  /** `r~<machine id>~<profile id>` of its first copy. */
  readonly key: string;
  readonly cli: CliProviderId;
  readonly name: string;
  readonly identity: string | null;
  readonly account: string | null;
  /** The first copy's sign-in. */
  readonly signIn: ProfileSignIn;
  readonly machines: ReadonlyArray<{ readonly id: string; readonly name: string; readonly profileId: string }>;
  readonly usage: ProfileUsage | null;
  readonly exhausted: ProfileExhausted | null;
}

/**
 * The accounts of the connected paired machines that are not on this machine
 * (`localIdentities`), the same identity on several machines merged into one
 * (its newest reading, its latest spent mark, the first copy's name); an account
 * without an identity is its own. Enabled accounts only, in machine then
 * priority order.
 */
export function peerOnlyAccounts(peers: readonly PeerAccounts[], cli: CliProviderId, localIdentities: ReadonlySet<string>, now: number): PeerOnlyAccount[] {
  const out: PeerOnlyAccount[] = [];
  const byIdentity = new Map<string, number>();
  for (const peer of peers) {
    if (!peer.online) continue;
    const accounts = peer.accounts.filter((a) => a.cli === cli && a.enabled).sort((a, b) => a.position - b.position);
    for (const account of accounts) {
      if (account.identity !== null && localIdentities.has(account.identity)) continue;
      const machine = { id: peer.machineId, name: peer.machineName, profileId: account.profileId };
      const copy: RemoteCopy = { machineId: peer.machineId, machineName: peer.machineName, online: true, account };
      const at = account.identity !== null ? byIdentity.get(account.identity) : undefined;
      if (at !== undefined) {
        const merged = out[at] as PeerOnlyAccount;
        const usage = newestUsage(merged.usage, [copy]).usage;
        const exhausted = spentAcross(merged.exhausted, [copy], now).exhausted;
        out[at] = { ...merged, machines: [...merged.machines, machine], usage, exhausted };
        continue;
      }
      if (account.identity !== null) byIdentity.set(account.identity, out.length);
      out.push({
        key: `r~${peer.machineId}~${account.profileId}`,
        cli,
        name: account.name,
        identity: account.identity,
        account: account.account,
        signIn: account.signIn,
        machines: [machine],
        usage: account.usage,
        exhausted: account.exhausted && Date.parse(account.exhausted.until) > now ? account.exhausted : null,
      });
    }
  }
  return out;
}

/** "Mac + PC": the machines an account is on, as a label. */
export function machinesLabel(names: readonly string[]): string {
  return names.join(' + ');
}
