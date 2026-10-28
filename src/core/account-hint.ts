/**
 * D142 (`docs/accounts.md` → *One account here, more on a paired machine*): a machine
 * that cannot switch accounts because it has a single usable account of a CLI while a
 * paired machine (D48, known through D98's exchange) has another account of that CLI
 * this machine lacks. Pure, shared by the server (the Inbox item, the Settings line,
 * the switcher's cue) and the UI. Only Claude Code accounts have an identity (D98), so
 * in practice only Claude Code gets the hint. Never anything that signs in: it only
 * names the accounts (each machine signs in on its own).
 */
import type { AccountSettings, ProfileSignIn } from './accounts.ts';
import { CLI_LABELS, CLI_PROVIDERS, type CliProviderId, isCliProviderId } from './cli-providers.ts';
import { type PeerAccounts, machinesLabel } from './shared-accounts.ts';

/** Kind of the Inbox item (`system_items.kind`). */
export const ACCOUNT_HINT = 'account-hint';
/** Its "Add it there" action: a link (Settings › Accounts on that machine, the Add form prefilled); the item stays open. */
export const ADD_ACCOUNT_ACTION = 'add-account';

/** What the detection reads of one of this machine's profiles (`AccountProfile`). */
export interface HintProfile {
  readonly id: string;
  readonly cli: CliProviderId;
  readonly name: string;
  readonly enabled: boolean;
  readonly signIn: ProfileSignIn;
  /** D98's identity (kept for a disabled profile too); `null` / absent = unknown. */
  readonly identity?: string | null;
}

/** An account a paired machine has and this one lacks (the same identity on several machines merged). */
export interface MissingAccount {
  readonly identity: string;
  /** Its name on the first machine it was found on. */
  readonly name: string;
  /** What its CLI reports (`dev@example.com · max`), for the label. */
  readonly account: string | null;
  readonly machines: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

/** One CLI of this machine that cannot switch: its one usable account, and what the paired machines have more. */
export interface SingleAccountHint {
  readonly cli: CliProviderId;
  /** The one usable account here. */
  readonly here: { readonly id: string; readonly name: string };
  /** In the paired machines' order, then their priority order. */
  readonly missing: readonly MissingAccount[];
  /** {@link hintKey} of the missing identities. */
  readonly key: string;
}

/** What {@link singleAccountHints} reads. */
export interface HintInput {
  readonly settings: Pick<AccountSettings, 'enabled' | 'perCli'>;
  /** This machine's profiles (every CLI). */
  readonly profiles: readonly HintProfile[];
  /** The paired machines' accounts as last known (online or not; an older Switchboard's are skipped: they carry no identity). */
  readonly peers: readonly PeerAccounts[];
}

/** The key of a hint: its CLI and the missing identities, sorted (`account-hint:claude:a@x,b@y`). */
export function hintKey(cli: CliProviderId, identities: readonly string[]): string {
  return `${ACCOUNT_HINT}:${cli}:${[...new Set(identities)].sort().join(',')}`;
}

/**
 * Per CLI with automatic switching on (the master and the CLI's toggle, D63): this
 * machine has **exactly one usable** account (enabled and signed in; an enabled
 * account whose sign-in is unknown counts as maybe usable, so then nothing is said),
 * and a paired machine has at least one enabled, not signed-out account of that CLI
 * with a known identity that **no** profile here has (any state: a disabled or
 * signed-out profile here with that identity is the developer's own choice). Codex and
 * OpenCode report no identity (D98), so they never get one.
 */
export function singleAccountHints(input: HintInput): SingleAccountHint[] {
  const out: SingleAccountHint[] = [];
  if (!input.settings.enabled) return out;
  for (const cli of CLI_PROVIDERS) {
    if (cli !== 'claude' || !input.settings.perCli[cli]) continue;
    const mine = input.profiles.filter((p) => p.cli === cli);
    const usable = mine.filter((p) => p.enabled && p.signIn === 'signed-in');
    const maybe = mine.filter((p) => p.enabled && p.signIn === 'unknown');
    const here = usable[0];
    if (usable.length !== 1 || maybe.length > 0 || !here) continue;
    const known = new Set(mine.map((p) => p.identity).filter((id): id is string => typeof id === 'string' && id !== ''));
    const missing: MissingAccount[] = [];
    const at = new Map<string, number>();
    for (const peer of input.peers) {
      if (peer.legacy) continue;
      const accounts = peer.accounts.filter((a) => a.cli === cli && a.enabled && a.signIn !== 'signed-out' && a.identity !== null).sort((a, b) => a.position - b.position);
      for (const account of accounts) {
        const identity = account.identity as string;
        if (known.has(identity)) continue;
        const machine = { id: peer.machineId, name: peer.machineName };
        const index = at.get(identity);
        if (index !== undefined) {
          const merged = missing[index] as MissingAccount;
          if (!merged.machines.some((m) => m.id === machine.id)) missing[index] = { ...merged, machines: [...merged.machines, machine] };
          continue;
        }
        at.set(identity, missing.length);
        missing.push({ identity, name: account.name, account: account.account, machines: [machine] });
      }
    }
    if (missing.length === 0) continue;
    out.push({ cli, here: { id: here.id, name: here.name }, missing, key: hintKey(cli, missing.map((m) => m.identity)) });
  }
  return out;
}

/** `true` when every missing identity of the hint was dismissed before (`dismissed`: the identities of its CLI's dismissed items). */
export function hintDismissed(hint: Pick<SingleAccountHint, 'missing'>, dismissed: ReadonlySet<string>): boolean {
  return hint.missing.every((m) => dismissed.has(m.identity));
}

/** The machines the missing accounts are on ("Mac", "Mac + Studio"). */
function missingMachines(hint: Pick<SingleAccountHint, 'missing'>): string {
  const names: string[] = [];
  for (const account of hint.missing) for (const machine of account.machines) if (!names.includes(machine.name)) names.push(machine.name);
  return machinesLabel(names);
}

/** "1 more is signed in on Mac (Personal)" / "2 more are signed in on Mac + Studio (Personal, Lab)". */
function moreText(hint: Pick<SingleAccountHint, 'missing'>): string {
  const count = hint.missing.length;
  return `${count} more ${count === 1 ? 'is' : 'are'} signed in on ${missingMachines(hint)} (${hint.missing.map((m) => m.name).join(', ')})`;
}

/** The item's title: "Marcins-PC can't switch Claude Code accounts". */
export function hintTitle(machine: string, cli: CliProviderId): string {
  return `${machine} can't switch ${CLI_LABELS[cli]} accounts`;
}

/**
 * The item's detail: "It has only one account signed in (Work). 1 more is signed in on
 * Marcins-MacBook-Pro (Personal). Add it on Marcins-PC so agents there switch when one runs out."
 */
export function hintDetail(machine: string, hint: Pick<SingleAccountHint, 'here' | 'missing'>): string {
  const them = hint.missing.length === 1 ? 'it' : 'them';
  return `It has only one account signed in (${hint.here.name}). ${moreText(hint)}. Add ${them} on ${machine} so agents there switch when one runs out.`;
}

/** Settings › Accounts' line under the CLI's accounts: "Marcins-PC has only one account signed in (Work). 1 more is signed in on Mac (Personal): add it here so agents switch when one runs out." */
export function hintLine(machine: string, hint: Pick<SingleAccountHint, 'here' | 'missing'>): string {
  const them = hint.missing.length === 1 ? 'it' : 'them';
  return `${machine} has only one account signed in (${hint.here.name}). ${moreText(hint)}: add ${them} here so agents switch when one runs out.`;
}

/** The switcher's cue (an agent at its limit): "1 more account is signed in on Mac — add it here". */
export function hintCue(hint: Pick<SingleAccountHint, 'missing'>): string {
  const count = hint.missing.length;
  return `${count} more ${count === 1 ? 'account is' : 'accounts are'} signed in on ${missingMachines(hint)} — add ${count === 1 ? 'it' : 'them'} here`;
}

/** What "Add it there" opens: the machine's Settings › Accounts with the Add form of `cli` prefilled with `name`. */
export interface AddAccountTarget {
  readonly cli: CliProviderId;
  readonly name: string;
}

/**
 * The address of "Add it there" / "Add it here": Settings › Accounts (classic
 * `/settings/accounts`, v2 Advanced › Accounts: every option) with `machine` picked
 * in the Machine picker (`null` = this one) and the Add form of `cli` prefilled.
 */
export function addAccountPath(theme: 'classic' | 'v2', machine: string | null, target: AddAccountTarget): string {
  const params = new URLSearchParams();
  if (machine) params.set('machine', machine);
  params.set('add', target.cli);
  params.set('name', target.name);
  return `${theme === 'v2' ? '/settings/advanced/accounts' : '/settings/accounts'}?${params.toString()}`;
}

/** The query of {@link addAccountPath} read back; `null` when it is not one. */
export function readAddAccountQuery(search: string): { readonly machine: string | null; readonly cli: CliProviderId; readonly name: string } | null {
  const params = new URLSearchParams(search);
  const cli = params.get('add');
  const name = params.get('name');
  if (!isCliProviderId(cli) || name === null || name.trim() === '') return null;
  return { machine: params.get('machine') || null, cli, name: name.slice(0, 40) };
}

/** The Settings line's view of a hint (`AccountsOverview.hints`, additive). */
export interface AccountHintView {
  readonly cli: CliProviderId;
  /** {@link hintLine}. */
  readonly text: string;
  /** The first missing account: what "Add it here" prefills. */
  readonly add: AddAccountTarget;
  /** Every missing account's name and machines. */
  readonly missing: ReadonlyArray<{ readonly name: string; readonly account: string | null; readonly machines: readonly string[] }>;
}

/** A hint as Settings › Accounts shows it. */
export function hintView(machine: string, hint: SingleAccountHint): AccountHintView {
  return {
    cli: hint.cli,
    text: hintLine(machine, hint),
    add: { cli: hint.cli, name: (hint.missing[0] as MissingAccount).name },
    missing: hint.missing.map((m) => ({ name: m.name, account: m.account, machines: m.machines.map((x) => x.name) })),
  };
}
