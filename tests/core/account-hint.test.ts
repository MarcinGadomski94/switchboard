import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT_SETTINGS } from '../../src/core/accounts.ts';
import {
  type HintProfile,
  addAccountPath,
  hintCue,
  hintDetail,
  hintDismissed,
  hintKey,
  hintLine,
  hintTitle,
  hintView,
  readAddAccountQuery,
  singleAccountHints,
} from '../../src/core/account-hint.ts';
import type { PeerAccounts, SharedAccount } from '../../src/core/shared-accounts.ts';

/** D142 (`docs/accounts.md` → *One account here, more on a paired machine*): the pure detection and its words. */

const settings = { enabled: DEFAULT_ACCOUNT_SETTINGS.enabled, perCli: DEFAULT_ACCOUNT_SETTINGS.perCli };

const work: HintProfile = { id: 'default-claude', cli: 'claude', name: 'Work', enabled: true, signIn: 'signed-in', identity: 'claude:work@example.com' };

function account(over: Partial<SharedAccount> & { readonly profileId: string; readonly name: string }): SharedAccount {
  return { cli: 'claude', identity: null, account: null, enabled: true, position: 0, signIn: 'signed-in', usage: null, exhausted: null, ...over };
}

function mac(accounts: readonly SharedAccount[], over: Partial<PeerAccounts> = {}): PeerAccounts {
  return { machineId: 'm-mac', machineName: 'Mac', online: true, legacy: false, accounts, ...over };
}

const personal = account({ profileId: 'p1', name: 'Personal', identity: 'claude:me@example.com', account: 'me@example.com · max', position: 1 });
const sameWork = account({ profileId: 'default-claude', name: 'Work', identity: 'claude:work@example.com' });

describe('D142 · singleAccountHints', () => {
  it('one usable account here and a paired machine with another identity → a hint naming both', () => {
    const hints = singleAccountHints({ settings, profiles: [work], peers: [mac([sameWork, personal])] });
    expect(hints).toHaveLength(1);
    const hint = hints[0];
    expect(hint?.cli).toBe('claude');
    expect(hint?.here).toEqual({ id: 'default-claude', name: 'Work' });
    expect(hint?.missing).toEqual([{ identity: 'claude:me@example.com', name: 'Personal', account: 'me@example.com · max', machines: [{ id: 'm-mac', name: 'Mac' }] }]);
    expect(hint?.key).toBe('account-hint:claude:claude:me@example.com');
  });

  it('a machine that is away still counts (last known), an older Switchboard never does', () => {
    expect(singleAccountHints({ settings, profiles: [work], peers: [mac([personal], { online: false })] })).toHaveLength(1);
    expect(singleAccountHints({ settings, profiles: [work], peers: [mac([personal], { legacy: true })] })).toEqual([]);
  });

  it('two usable accounts here → none', () => {
    const second: HintProfile = { id: 'p-2', cli: 'claude', name: 'Second', enabled: true, signIn: 'signed-in', identity: 'claude:second@example.com' };
    expect(singleAccountHints({ settings, profiles: [work, second], peers: [mac([personal])] })).toEqual([]);
  });

  it('a second account here that is signed out or disabled does not count: "only one usable here"', () => {
    const out: HintProfile = { id: 'p-2', cli: 'claude', name: 'Out', enabled: true, signIn: 'signed-out', identity: null };
    const off: HintProfile = { id: 'p-3', cli: 'claude', name: 'Off', enabled: false, signIn: 'signed-in', identity: 'claude:off@example.com' };
    expect(singleAccountHints({ settings, profiles: [work, out, off], peers: [mac([personal])] })).toHaveLength(1);
  });

  it('an enabled account whose sign-in is unknown may be usable: nothing is said', () => {
    const unknown: HintProfile = { id: 'p-2', cli: 'claude', name: 'Maybe', enabled: true, signIn: 'unknown', identity: null };
    expect(singleAccountHints({ settings, profiles: [work, unknown], peers: [mac([personal])] })).toEqual([]);
  });

  it('the paired machine\'s account is here already (even disabled), signed out there, disabled there or without identity → none', () => {
    const here: HintProfile = { id: 'p-2', cli: 'claude', name: 'Personal', enabled: false, signIn: 'signed-in', identity: 'claude:me@example.com' };
    expect(singleAccountHints({ settings, profiles: [work, here], peers: [mac([personal])] })).toEqual([]);
    expect(singleAccountHints({ settings, profiles: [work], peers: [mac([{ ...personal, signIn: 'signed-out' }])] })).toEqual([]);
    expect(singleAccountHints({ settings, profiles: [work], peers: [mac([{ ...personal, enabled: false }])] })).toEqual([]);
    expect(singleAccountHints({ settings, profiles: [work], peers: [mac([{ ...personal, identity: null }])] })).toEqual([]);
    expect(singleAccountHints({ settings, profiles: [work], peers: [mac([sameWork])] })).toEqual([]);
  });

  it('Codex and OpenCode never get one (no identity), even with an identity-like value', () => {
    const codex: HintProfile = { id: 'default-codex', cli: 'codex', name: 'Default', enabled: true, signIn: 'signed-in', identity: null };
    const opencode: HintProfile = { id: 'default-opencode', cli: 'opencode', name: 'Default', enabled: true, signIn: 'signed-in', identity: null };
    const peers = [mac([account({ profileId: 'c1', cli: 'codex', name: 'Other', identity: 'codex:x' }), account({ profileId: 'o1', cli: 'opencode', name: 'Other', identity: 'opencode:x' })])];
    expect(singleAccountHints({ settings, profiles: [codex, opencode], peers })).toEqual([]);
  });

  it('automatic switching off (master or Claude Code\'s toggle) → none', () => {
    expect(singleAccountHints({ settings: { ...settings, enabled: false }, profiles: [work], peers: [mac([personal])] })).toEqual([]);
    expect(singleAccountHints({ settings: { ...settings, perCli: { ...settings.perCli, claude: false } }, profiles: [work], peers: [mac([personal])] })).toEqual([]);
  });

  it('the same missing identity on two machines is one account on both; the key sorts the identities', () => {
    const lab = account({ profileId: 'p9', name: 'Lab', identity: 'claude:lab@example.com', position: 2 });
    const studio: PeerAccounts = { machineId: 'm-studio', machineName: 'Studio', online: true, legacy: false, accounts: [account({ ...personal, profileId: 'q1', name: 'Mine' })] };
    const [hint] = singleAccountHints({ settings, profiles: [work], peers: [mac([lab, personal]), studio] });
    expect(hint?.missing.map((m) => [m.name, m.machines.map((x) => x.name)])).toEqual([
      ['Personal', ['Mac', 'Studio']],
      ['Lab', ['Mac']],
    ]);
    expect(hint?.key).toBe(hintKey('claude', ['claude:me@example.com', 'claude:lab@example.com']));
    expect(hint?.key).toBe('account-hint:claude:claude:lab@example.com,claude:me@example.com');
  });
});

describe('D142 · dismissing and the words', () => {
  it('dismissed while every missing identity was dismissed before; a new one raises it again', () => {
    const [hint] = singleAccountHints({ settings, profiles: [work], peers: [mac([personal])] });
    if (!hint) throw new Error('no hint');
    expect(hintDismissed(hint, new Set())).toBe(false);
    expect(hintDismissed(hint, new Set(['claude:me@example.com']))).toBe(true);
    const lab = account({ profileId: 'p9', name: 'Lab', identity: 'claude:lab@example.com', position: 2 });
    const [more] = singleAccountHints({ settings, profiles: [work], peers: [mac([personal, lab])] });
    if (!more) throw new Error('no hint');
    expect(hintDismissed(more, new Set(['claude:me@example.com']))).toBe(false);
    expect(more.key).not.toBe(hint.key);
  });

  it('title, detail, Settings line and the switcher\'s cue', () => {
    const [hint] = singleAccountHints({ settings, profiles: [work], peers: [mac([personal], { machineName: 'Marcins-MacBook-Pro' })] });
    if (!hint) throw new Error('no hint');
    expect(hintTitle('Marcins-PC', 'claude')).toBe("Marcins-PC can't switch Claude Code accounts");
    expect(hintDetail('Marcins-PC', hint)).toBe('It has only one account signed in (Work). 1 more is signed in on Marcins-MacBook-Pro (Personal). Add it on Marcins-PC so agents there switch when one runs out.');
    expect(hintLine('Marcins-PC', hint)).toBe('Marcins-PC has only one account signed in (Work). 1 more is signed in on Marcins-MacBook-Pro (Personal): add it here so agents switch when one runs out.');
    expect(hintCue(hint)).toBe('1 more account is signed in on Marcins-MacBook-Pro — add it here');
    expect(hintView('Marcins-PC', hint)).toMatchObject({ cli: 'claude', add: { cli: 'claude', name: 'Personal' }, missing: [{ name: 'Personal', machines: ['Marcins-MacBook-Pro'] }] });
    const two = { here: hint.here, missing: [...hint.missing, { identity: 'claude:lab@example.com', name: 'Lab', account: null, machines: [{ id: 's', name: 'Studio' }] }] };
    expect(hintDetail('PC', two)).toBe('It has only one account signed in (Work). 2 more are signed in on Marcins-MacBook-Pro + Studio (Personal, Lab). Add them on PC so agents there switch when one runs out.');
    expect(hintCue(two)).toBe('2 more accounts are signed in on Marcins-MacBook-Pro + Studio — add them here');
  });

  it('the Add-account address for both themes, and read back', () => {
    expect(addAccountPath('classic', 'm-pc', { cli: 'claude', name: 'Personal Max' })).toBe('/settings/accounts?machine=m-pc&add=claude&name=Personal+Max');
    expect(addAccountPath('v2', null, { cli: 'claude', name: 'Personal' })).toBe('/settings/advanced/accounts?add=claude&name=Personal');
    expect(readAddAccountQuery('?machine=m-pc&add=claude&name=Personal+Max')).toEqual({ machine: 'm-pc', cli: 'claude', name: 'Personal Max' });
    expect(readAddAccountQuery('?add=claude&name=Personal')).toEqual({ machine: null, cli: 'claude', name: 'Personal' });
    expect(readAddAccountQuery('?add=nope&name=x')).toBeNull();
    expect(readAddAccountQuery('?add=claude')).toBeNull();
    expect(readAddAccountQuery('')).toBeNull();
  });
});
