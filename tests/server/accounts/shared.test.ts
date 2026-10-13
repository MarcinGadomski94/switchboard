import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SystemInfo } from '../../../src/core/api.ts';
import type { MachineState } from '../../../src/core/peers.ts';
import type { SharedAccount, SharedAccountsMessage } from '../../../src/core/shared-accounts.ts';
import { SharedAccounts, type SharedAccountsPeers } from '../../../src/server/accounts/shared.ts';
import type { Providers } from '../../../src/server/providers.ts';
import { withAccountUsage } from '../../../src/server/usage/wire.ts';
import { type SupervisorWorld, makeSupervisorWorld } from '../../helpers/supervisor.ts';

/**
 * D98 (`docs/accounts.md` → *Shared across paired machines*): one machine's side of
 * the shared accounts against scripted paired machines: a current one (the
 * exchange), an older Switchboard (no exchange route: read unmerged), one that
 * is unreachable. Two real processes: `tests/server/peers/shared-accounts.test.ts`.
 */

let world: SupervisorWorld | undefined;
let shared: SharedAccounts | undefined;

afterEach(async () => {
  await shared?.stop();
  world?.accounts.useShared(null);
  await world?.cleanup();
  shared = undefined;
  world = undefined;
});

const soon = (ms: number): string => new Date(Date.now() + ms).toISOString();

function remote(over: Partial<SharedAccount>): SharedAccount {
  return { profileId: 'r1', cli: 'claude', name: 'Default', identity: 'claude:dev@example.com', account: 'dev@example.com · max', enabled: true, position: 0, signIn: 'signed-in', usage: null, exhausted: null, ...over };
}

interface Peer {
  readonly id: string;
  readonly name: string;
  state: MachineState;
  answer(method: string, path: string, body: unknown): { readonly status: number; readonly body: unknown } | { readonly status: null; readonly reason: string };
}

function studio(accounts: SharedAccount[], prefs: SharedAccountsMessage['prefs'] = { names: {}, order: {} }): Peer & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    id: 'm-studio',
    name: 'Studio',
    state: 'online',
    sent,
    answer(method, route, body) {
      if (method === 'POST' && route === '/api/accounts/shared') {
        sent.push(body);
        return { status: 200, body: { v: 1, machine: { id: 'm-studio', name: 'Studio' }, accounts, prefs } };
      }
      return { status: 404, body: null };
    },
  };
}

const old: Peer = {
  id: 'm-old',
  name: 'Old',
  state: 'online',
  answer(method, route) {
    // An older Switchboard: the route is not on its peer allow-list; its accounts list is.
    if (route === '/api/accounts/shared') return { status: 403, body: { error: 'peer-forbidden' } };
    if (method === 'GET' && route === '/api/accounts') {
      return { status: 200, body: { profiles: [{ id: 'default-claude', cli: 'claude', name: 'Default', account: 'dev@example.com · max', enabled: true, position: 0, signIn: 'signed-in', usage: null, exhausted: null }], settings: {} } };
    }
    return { status: 404, body: null };
  },
};

const down: Peer = { id: 'm-down', name: 'Down', state: 'online', answer: () => ({ status: null, reason: 'connect ECONNREFUSED' }) };

async function make(peers: Peer[]): Promise<{ w: SupervisorWorld; s: SharedAccounts; logs: string[] }> {
  const w = await makeSupervisorWorld();
  world = w;
  await writeFile(path.join(w.configDir, '.fake-auth.json'), JSON.stringify({ loggedIn: true, email: 'dev@example.com' }));
  const fake: SharedAccountsPeers = {
    self: async () => ({ id: 'm-self', name: 'Desk' }),
    machines: async () => peers.map((p) => ({ id: p.id, name: p.name, state: p.state })),
    ask: async (machineId, method, route, body) => {
      const peer = peers.find((p) => p.id === machineId);
      if (!peer || peer.state !== 'online') return { status: null, reason: 'offline' };
      return peer.answer(method, route, body);
    },
  };
  const logs: string[] = [];
  const s = new SharedAccounts({ accounts: w.accounts, store: w.store, peers: fake, pushDelayMs: 10, intervalMs: 3_600_000, log: (line) => logs.push(line), onError: (error) => w.errors.push(error) });
  shared = s;
  w.accounts.useShared(s);
  return { w, s, logs };
}

const base: Providers = { system: { system: async () => ({ cli: 'claude' }) as unknown as SystemInfo } };
const footer = async (w: SupervisorWorld): Promise<SystemInfo['accountUsage']> => ((await withAccountUsage(base, w.accounts).system?.system()) as SystemInfo).accountUsage;

describe('D98 · accounts shared with paired machines (one machine against scripted peers)', () => {
  it('the same identity is one account (newest reading, spent marks, where else it is); a different one, an older peer\'s and an unreachable peer\'s stay apart or drop out', async () => {
    const reading = { fiveHourPct: 91, fiveHourResetsAt: soon(3_600_000), sevenDayPct: 30, sevenDayResetsAt: soon(86_400_000), receivedAt: soon(5_000) };
    // (Studio's reading is taken after this machine's below.)
    const peer = studio([remote({ usage: reading }), remote({ profileId: 'r2', name: 'Lab', identity: 'claude:lab@example.com', account: 'lab@example.com · pro', position: 1 })]);
    const { w, s } = await make([peer, old, down]);
    // An older local reading of the same account.
    await w.store.usage.add({ source: 'get_usage', sessionId: null, profileId: 'default-claude', fiveHourPct: 10, fiveHourResetsAt: soon(3_600_000), sevenDayPct: 5, sevenDayResetsAt: soon(86_400_000), raw: {} });
    // No peer yet: nothing changes (one account, no rows, no labels).
    expect(await footer(w)).toBeUndefined();

    await s.sync();
    // What this machine sent: its accounts with the identity the CLI reported, never anything that signs in.
    const sent = peer.sent[0] as SharedAccountsMessage;
    expect(sent.machine).toEqual({ id: 'm-self', name: 'Desk' });
    expect(sent.accounts.find((a) => a.profileId === 'default-claude')).toMatchObject({ identity: 'claude:dev@example.com', account: 'dev@example.com · max' });
    expect(JSON.stringify(sent)).not.toMatch(/token|credential|oauth|claude-config/i);

    const peers = await s.peers();
    expect(peers.map((p) => [p.machineName, p.legacy])).toEqual([
      ['Studio', false],
      ['Old', true],
    ]);
    const mine = (await w.accounts.list({ check: false })).find((p) => p.id === 'default-claude');
    // The newest reading wins (Studio's), and the account says where else it is (not the older peer: unmerged).
    expect(mine?.usage?.fiveHourPct).toBe(91);
    expect(mine?.usageFrom).toBe('Studio');
    expect(mine?.elsewhere?.map((e) => e.machineName)).toEqual(['Studio']);

    // The footer: one row for the shared account (its windows Studio's reading), Studio's other account, the older peer's unmerged.
    const rows = await footer(w);
    expect(rows?.map((r) => [r.name, r.machines?.join(' + '), r.windowsFrom ?? null])).toEqual([
      ['Default', 'Desk + Studio', 'Studio'],
      ['Lab', 'Studio', null],
      ['Default', 'Old', null],
    ]);
    expect(rows?.[0]?.windows?.find((x) => x.key === 'session')?.pct).toBe(91);
    expect(rows?.[1]?.profileId).toBe('r~m-studio~r2');

    // Studio goes away: its accounts drop out of the lists, its reading still counts here (the account's, not the machine's).
    peer.state = 'offline';
    await s.sync();
    expect((await w.accounts.list({ check: false })).find((p) => p.id === 'default-claude')?.elsewhere).toBeUndefined();
    expect((await footer(w))?.map((r) => r.name)).toEqual(['Default', 'Default']);
  });

  it('a spent mark found on a paired machine makes this machine skip that account until the reset; a mark here is sent at once', async () => {
    const until = soon(2 * 3_600_000);
    const peer = studio([remote({ exhausted: { until, window: 'session', text: "You've hit your session limit" } })]);
    const { w, s } = await make([peer]);
    const second = await w.accounts.create({ cli: 'claude', name: 'Side' });
    await writeFile(path.join(second.dir as string, '.fake-auth.json'), JSON.stringify({ loggedIn: true, email: 'side@example.com' }));
    await s.sync();
    const snapshots = await w.accounts.snapshots('claude', { check: true });
    expect(snapshots.find((p) => p.id === 'default-claude')?.exhaustedUntil).toBe(until);
    // A new session starts on the next account, not the one Studio found spent.
    expect(await w.accounts.pick('claude')).toBe(second.id);
    const listed = (await w.accounts.list({ check: false })).find((p) => p.id === 'default-claude');
    expect(listed?.exhausted).toMatchObject({ until, machine: 'Studio' });
    // This machine's own mark goes out to the paired machines right away.
    const before = peer.sent.length;
    await w.accounts.markExhausted({ profileId: second.id, until: soon(3_600_000), window: 'weekly', text: 'x' });
    await expect.poll(() => peer.sent.length, { timeout: 5_000 }).toBeGreaterThan(before);
    const last = peer.sent.at(-1) as SharedAccountsMessage;
    expect(last.accounts.find((a) => a.profileId === second.id)?.exhausted).toMatchObject({ window: 'weekly' });
  });

  it('names and order: a later name or order from a paired machine applies to the same accounts here; a rename here wins later; a taken name is kept', async () => {
    const { w, s, logs } = await make([]);
    const side = await w.accounts.create({ cli: 'claude', name: 'Side' });
    const lab = await w.accounts.create({ cli: 'claude', name: 'Lab' });
    await writeFile(path.join(side.dir as string, '.fake-auth.json'), JSON.stringify({ loggedIn: true, email: 'side@example.com' }));
    await writeFile(path.join(lab.dir as string, '.fake-auth.json'), JSON.stringify({ loggedIn: true, email: 'lab-here@example.com' }));
    for (const id of ['default-claude', side.id, lab.id]) await w.accounts.check(id);
    const at = Date.now() + 1_000;
    const message = (prefs: SharedAccountsMessage['prefs']): SharedAccountsMessage => ({ v: 1, machine: { id: 'm-studio', name: 'Studio' }, accounts: [remote({})], prefs });
    expect(
      await s.receive('m-studio', 'Studio', message({ names: { 'claude:dev@example.com': { name: 'Acme', at } }, order: { claude: { identities: ['claude:side@example.com', 'claude:x@example.com', 'claude:dev@example.com'], at } } })),
    ).toBe(true);
    const names = async () => (await w.store.profiles.list('claude')).map((p) => p.name);
    // Renamed, and the shared accounts reordered among their own slots (Lab, here only, keeps its place).
    expect(await names()).toEqual(['Side', 'Acme', 'Lab']);
    expect(logs.some((l) => l.includes('renamed "Default" to "Acme" (as on Studio)'))).toBe(true);
    // The same message again changes nothing (converged; no echo).
    await s.receive('m-studio', 'Studio', message({ names: { 'claude:dev@example.com': { name: 'Acme', at } }, order: {} }));
    expect(await names()).toEqual(['Side', 'Acme', 'Lab']);
    // An older name does not win.
    await s.receive('m-studio', 'Studio', message({ names: { 'claude:dev@example.com': { name: 'Stale', at: at - 10_000 } }, order: {} }));
    expect(await names()).toEqual(['Side', 'Acme', 'Lab']);
    // A rename here is the newest: it goes out with the next exchange.
    await w.accounts.update('default-claude', { name: 'Acme main' });
    const out = await s.message();
    expect(out.prefs.names['claude:dev@example.com']?.name).toBe('Acme main');
    expect(out.prefs.names['claude:dev@example.com']?.at).toBeGreaterThanOrEqual(at - 1_000);
    // A reorder here likewise (the identities in this machine's order).
    await w.accounts.reorder('claude', ['default-claude', side.id, lab.id]);
    expect((await s.message()).prefs.order.claude?.identities).toEqual(['claude:dev@example.com', 'claude:side@example.com', 'claude:lab-here@example.com']);
    // A name that another account here already has is not taken (unique per CLI).
    await s.receive('m-studio', 'Studio', message({ names: { 'claude:dev@example.com': { name: 'Lab', at: Date.now() + 60_000 } }, order: {} }));
    expect(await names()).toEqual(['Acme main', 'Side', 'Lab']);
    expect(logs.some((l) => l.includes('the name "Lab" from Studio is taken'))).toBe(true);
  });

  it('a malformed exchange is refused', async () => {
    const { s } = await make([]);
    expect(await s.receive('m-studio', 'Studio', { v: 1, accounts: 'nope' })).toBe(false);
    expect(await s.peers()).toEqual([]);
  });
});
