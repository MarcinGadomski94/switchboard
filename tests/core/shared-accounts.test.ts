import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT_SETTINGS, type ProfileSnapshot, type ProfileUsage, decideAccountSwitch } from '../../src/core/accounts.ts';
import {
  type AccountPrefs,
  type PeerAccounts,
  type RemoteCopy,
  type SharedAccount,
  accountIdentity,
  applySharedOrder,
  machinesLabel,
  mergeAccountPrefs,
  newestUsage,
  peerOnlyAccounts,
  readSharedAccount,
  readSharedAccountsMessage,
  spentAcross,
} from '../../src/core/shared-accounts.ts';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

function usage(pct: number, receivedAt: string | null): ProfileUsage {
  return { fiveHourPct: pct, fiveHourResetsAt: iso(NOW + 3_600_000), sevenDayPct: 10, sevenDayResetsAt: iso(NOW + 86_400_000), receivedAt };
}

function account(over: Partial<SharedAccount> = {}): SharedAccount {
  return { profileId: 'p1', cli: 'claude', name: 'Work', identity: 'claude:dev@example.com', account: 'dev@example.com · max', enabled: true, position: 0, signIn: 'signed-in', usage: null, exhausted: null, ...over };
}

function copy(machineName: string, over: Partial<SharedAccount> = {}, online = true): RemoteCopy {
  return { machineId: `id-${machineName}`, machineName, online, account: account(over) };
}

describe('D98 · identity', () => {
  it('Claude Code: the email (lower case), plan only shown; Codex, OpenCode and non-emails never merge', () => {
    expect(accountIdentity('claude', 'Dev@Example.com · max')).toBe('claude:dev@example.com');
    expect(accountIdentity('claude', 'dev@example.com')).toBe('claude:dev@example.com');
    expect(accountIdentity('claude', 'max')).toBeNull();
    expect(accountIdentity('claude', null)).toBeNull();
    // `codex login status` says only how it is signed in ("Logged in using ChatGPT"): too weak to tell two accounts apart.
    expect(accountIdentity('codex', 'Logged in using ChatGPT')).toBeNull();
    expect(accountIdentity('codex', 'dev@example.com')).toBeNull();
    expect(accountIdentity('opencode', '2 credentials')).toBeNull();
  });
});

describe('D98 · merging by identity', () => {
  const peers: PeerAccounts[] = [
    {
      machineId: 'm1',
      machineName: 'Studio',
      online: true,
      legacy: false,
      accounts: [
        account({ profileId: 'a', name: 'Work', identity: 'claude:dev@example.com' }),
        account({ profileId: 'b', name: 'Side', identity: 'claude:side@example.com', position: 1, usage: usage(40, iso(NOW - 60_000)) }),
        account({ profileId: 'c', name: 'Default', cli: 'opencode', identity: null }),
      ],
    },
    {
      machineId: 'm2',
      machineName: 'Laptop',
      online: true,
      legacy: false,
      accounts: [
        account({ profileId: 'x', name: 'Side here', identity: 'claude:side@example.com', usage: usage(70, iso(NOW - 10_000)) }),
        account({ profileId: 'y', name: 'Lab', identity: null }),
      ],
    },
    { machineId: 'm3', machineName: 'Away', online: false, legacy: false, accounts: [account({ profileId: 'z', name: 'Gone', identity: 'claude:gone@example.com' })] },
  ];

  it('the same identity on this machine is not listed again; the same one on two peers is one account with the newest reading', () => {
    const rows = peerOnlyAccounts(peers, 'claude', new Set(['claude:dev@example.com']), NOW);
    expect(rows.map((r) => r.name)).toEqual(['Side', 'Lab']);
    const side = rows[0];
    expect(side?.machines.map((m) => m.name)).toEqual(['Studio', 'Laptop']);
    expect(side?.key).toBe('r~m1~b');
    expect(side?.usage?.fiveHourPct).toBe(70);
  });

  it('a different identity, or none (no identity), stays its own row; a machine that is away drops out', () => {
    const rows = peerOnlyAccounts(peers, 'claude', new Set(), NOW);
    expect(rows.map((r) => `${r.name}@${machinesLabel(r.machines.map((m) => m.name))}`)).toEqual(['Work@Studio', 'Side@Studio + Laptop', 'Lab@Laptop']);
    expect(peerOnlyAccounts(peers, 'opencode', new Set(), NOW).map((r) => r.name)).toEqual(['Default']);
  });

  it('an older peer (legacy: its GET /api/accounts) has no identity, so it never merges', () => {
    const old = readSharedAccount({ id: 'p9', cli: 'claude', name: 'Work', account: 'dev@example.com · max', identity: 'claude:dev@example.com', enabled: true, position: 0, signIn: 'signed-in', usage: null, exhausted: null }, { legacy: true });
    expect(old?.identity).toBeNull();
    const rows = peerOnlyAccounts([{ machineId: 'o', machineName: 'Old', online: true, legacy: true, accounts: old ? [old] : [] }], 'claude', new Set(['claude:dev@example.com']), NOW);
    expect(rows).toHaveLength(1);
  });

  it('a malformed message is refused; a good one is read defensively', () => {
    expect(readSharedAccountsMessage({ v: 2, machine: { id: 'm' }, accounts: [] })).toBeNull();
    expect(readSharedAccountsMessage(null)).toBeNull();
    const read = readSharedAccountsMessage({ v: 1, machine: { id: 'm', name: 'Studio' }, accounts: [{ profileId: 'a', cli: 'claude', name: 'Work', identity: 'claude:dev@example.com' }, { nope: true }], prefs: { names: { x: { name: '', at: 1 } } } });
    expect(read?.accounts).toHaveLength(1);
    expect(read?.prefs).toEqual({ names: {}, order: {} });
  });
});

describe('D98 · newest reading and spent marks', () => {
  it('the newest reading wins, from any machine; a reading without a time loses', () => {
    const local = usage(20, iso(NOW - 120_000));
    expect(newestUsage(local, [copy('Studio', { usage: usage(90, iso(NOW - 5_000)) })])).toMatchObject({ from: 'Studio', usage: { fiveHourPct: 90 } });
    expect(newestUsage(local, [copy('Studio', { usage: usage(90, iso(NOW - 600_000)) })])).toMatchObject({ from: null, usage: { fiveHourPct: 20 } });
    expect(newestUsage(null, [copy('Studio', { usage: usage(5, null) })]).from).toBeNull();
    expect(newestUsage(null, [copy('Studio', { usage: usage(5, iso(NOW)) })]).from).toBe('Studio');
  });

  it('a spent mark of a paired machine counts until its reset; the latest one wins; an expired one is ignored', () => {
    const later = { until: iso(NOW + 7_200_000), window: 'session' as const, text: null };
    const sooner = { until: iso(NOW + 600_000), window: 'session' as const, text: null };
    expect(spentAcross(null, [copy('Studio', { exhausted: later })], NOW)).toMatchObject({ from: 'Studio', exhausted: later });
    expect(spentAcross(later, [copy('Studio', { exhausted: sooner })], NOW)).toMatchObject({ from: null, exhausted: later });
    expect(spentAcross(null, [copy('Studio', { exhausted: { ...later, until: iso(NOW - 1) } })], NOW).exhausted).toBeNull();
  });

  it('the switcher skips an account a paired machine found spent, and moves a session off it before a turn fails', () => {
    const snap = (id: string, position: number, exhaustedUntil: string | null): ProfileSnapshot => ({ id, name: id, enabled: true, position, signedIn: true, exhaustedUntil, usage: null });
    // As AccountService.snapshots gives it: "a" carries the paired machine's mark.
    const profiles = [snap('a', 0, iso(NOW + 3_600_000)), snap('b', 1, null)];
    const base = { settings: DEFAULT_ACCOUNT_SETTINGS, cli: 'claude' as const, profiles, pinned: false, idle: true, lastSwitchAt: null, now: NOW };
    const decision = decideAccountSwitch({ ...base, trigger: { kind: 'threshold' }, currentId: 'a' });
    expect(decision).toMatchObject({ action: 'switch', to: 'b' });
    expect(decision.reason).toMatch(/^out of usage until /);
    // Also with early switching off; and never a stop when nothing has allowance.
    const off = { ...DEFAULT_ACCOUNT_SETTINGS, thresholds: { ...DEFAULT_ACCOUNT_SETTINGS.thresholds, enabled: false } };
    expect(decideAccountSwitch({ ...base, settings: off, trigger: { kind: 'threshold' }, currentId: 'a' }).action).toBe('switch');
    expect(decideAccountSwitch({ ...base, profiles: [profiles[0] as ProfileSnapshot], trigger: { kind: 'threshold' }, currentId: 'a' }).action).toBe('none');
    // A limit on "b" finds "a" spent: every account is out of usage (no switch onto it).
    const limit = decideAccountSwitch({ ...base, trigger: { kind: 'limit', hit: { window: 'session', resetsAt: null, text: "You've hit your session limit" } }, currentId: 'b' });
    expect(limit.action).toBe('exhausted');
  });
});

describe('D98 · shared names and order (last writer wins)', () => {
  const local: AccountPrefs = { names: { 'claude:dev@example.com': { name: 'Work', at: 100 } }, order: { claude: { identities: ['claude:a@example.com', 'claude:b@example.com'], at: 100 } } };

  it('a later name or order wins; an earlier one does not; equal clocks are decided by value (the same on both ends)', () => {
    const remote: AccountPrefs = { names: { 'claude:dev@example.com': { name: 'Acme', at: 200 }, 'claude:new@example.com': { name: 'New', at: 50 } }, order: { claude: { identities: ['claude:b@example.com', 'claude:a@example.com'], at: 50 } } };
    const merged = mergeAccountPrefs(local, remote);
    expect([...merged.names].sort()).toEqual(['claude:dev@example.com', 'claude:new@example.com']);
    expect(merged.prefs.names['claude:dev@example.com']).toEqual({ name: 'Acme', at: 200 });
    expect(merged.order).toEqual([]);
    expect(merged.prefs.order.claude?.identities).toEqual(['claude:a@example.com', 'claude:b@example.com']);
    const tie1 = mergeAccountPrefs({ names: { i: { name: 'Bravo', at: 5 } }, order: {} }, { names: { i: { name: 'Alpha', at: 5 } }, order: {} });
    const tie2 = mergeAccountPrefs({ names: { i: { name: 'Alpha', at: 5 } }, order: {} }, { names: { i: { name: 'Bravo', at: 5 } }, order: {} });
    expect(tie1.prefs.names['i']?.name).toBe('Bravo');
    expect(tie2.prefs.names['i']?.name).toBe('Bravo');
    // Converged: the same prefs again change nothing (no echo).
    expect(mergeAccountPrefs(merged.prefs, merged.prefs)).toMatchObject({ names: [], order: [] });
  });

  it('a shared order reorders only the accounts both machines have, each keeping the others in their slots', () => {
    const here = [
      { id: 'own', identity: null },
      { id: 'pa', identity: 'claude:a@example.com' },
      { id: 'only', identity: 'claude:only-here@example.com' },
      { id: 'pb', identity: 'claude:b@example.com' },
    ];
    expect(applySharedOrder(here, ['claude:b@example.com', 'claude:x@example.com', 'claude:a@example.com'])).toEqual(['own', 'pb', 'only', 'pa']);
    expect(applySharedOrder(here, [])).toEqual(['own', 'pa', 'only', 'pb']);
  });
});
