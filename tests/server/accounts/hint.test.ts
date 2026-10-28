import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MachineState } from '../../../src/core/peers.ts';
import type { SharedAccount } from '../../../src/core/shared-accounts.ts';
import { AutoSwitcher } from '../../../src/server/accounts/auto-switch.ts';
import { AccountHint } from '../../../src/server/accounts/hint.ts';
import { SharedAccounts, type SharedAccountsPeers } from '../../../src/server/accounts/shared.ts';
import { SystemItemError, SystemItemService } from '../../../src/server/inbox/system-items.ts';
import { systemItem } from '../../../src/server/inbox/wire.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D142 (`docs/accounts.md` → *One account here, more on a paired machine*): one machine
 * against a scripted paired machine (D98's exchange): the "can't switch accounts" Inbox
 * item is raised, kept up to date, closed when it no longer holds, stays away once
 * dismissed until a new missing account appears; Settings' line; the switcher's cue.
 * Two real processes: `tests/server/peers/account-hint.test.ts`.
 */

let world: SupervisorWorld | undefined;
let shared: SharedAccounts | undefined;
let hint: AccountHint | undefined;
let switcher: AutoSwitcher | undefined;

afterEach(async () => {
  await switcher?.stop();
  await hint?.stop();
  await shared?.stop();
  world?.accounts.useShared(null);
  await world?.cleanup();
  switcher = undefined;
  hint = undefined;
  shared = undefined;
  world = undefined;
});

function remote(over: Partial<SharedAccount>): SharedAccount {
  return { profileId: 'r1', cli: 'claude', name: 'Default', identity: 'claude:dev@example.com', account: 'dev@example.com · max', enabled: true, position: 0, signIn: 'signed-in', usage: null, exhausted: null, ...over };
}

const lab = remote({ profileId: 'r2', name: 'Lab', identity: 'claude:lab@example.com', account: 'lab@example.com · max', position: 1 });

async function signedIn(dir: string, email: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '.fake-auth.json'), JSON.stringify({ loggedIn: true, email }));
}

interface World {
  readonly w: SupervisorWorld;
  readonly s: SharedAccounts;
  readonly h: AccountHint;
  readonly items: SystemItemService;
  /** What Studio has (change it, then `s.sync()`). */
  readonly studio: { accounts: SharedAccount[]; state: MachineState };
}

async function make(): Promise<World> {
  const w = await makeSupervisorWorld();
  world = w;
  await signedIn(w.configDir, 'dev@example.com');
  const studio = { accounts: [remote({}), lab], state: 'online' as MachineState };
  const peers: SharedAccountsPeers = {
    self: async () => ({ id: 'm-self', name: 'Desk' }),
    machines: async () => [{ id: 'm-studio', name: 'Studio', state: studio.state }],
    ask: async (_machine, method, route) => {
      if (studio.state !== 'online') return { status: null, reason: 'offline' };
      if (method === 'POST' && route === '/api/accounts/shared') return { status: 200, body: { v: 1, machine: { id: 'm-studio', name: 'Studio' }, accounts: studio.accounts, prefs: { names: {}, order: {} } } };
      return { status: 404, body: null };
    },
  };
  const s = new SharedAccounts({ accounts: w.accounts, store: w.store, peers, pushDelayMs: 10, intervalMs: 3_600_000, onError: (error) => w.errors.push(error), log: () => undefined });
  shared = s;
  w.accounts.useShared(s);
  const items = new SystemItemService({ store: w.store, onError: (error) => w.errors.push(error) });
  const h = new AccountHint({ accounts: w.accounts, shared: s, systemItems: items, intervalMs: 3_600_000, delayMs: 10, onError: (error) => w.errors.push(error) });
  hint = h;
  return { w, s, h, items, studio };
}

const openHints = async (w: SupervisorWorld) => (await w.store.systemItems.list(['open'])).filter((item) => item.kind === 'account-hint');

describe('D142 · one usable account here, more on a paired machine', () => {
  it('raises one informational item with Add it there (the account to add), kept once; Settings has the line; a second usable account here closes it', async () => {
    const { w, s, h } = await make();
    // Before the first exchange nothing is known about Studio: nothing is said.
    await h.check();
    expect(await openHints(w)).toEqual([]);

    await s.sync();
    await h.check();
    await h.check();
    const [item, ...more] = await openHints(w);
    expect(more).toEqual([]);
    expect(item).toMatchObject({ source: 'accounts', status: 'idle', title: "Desk can't switch Claude Code accounts", sessionId: null });
    expect(item?.detail).toBe('It has only one account signed in (Default). 1 more is signed in on Studio (Lab). Add it on Desk so agents there switch when one runs out.');
    const wire = systemItem(item as NonNullable<typeof item>);
    expect(wire).toMatchObject({ label: 'Accounts', systemKind: 'account-hint', addAccount: { cli: 'claude', name: 'Lab' } });
    expect(wire.actions?.map((a) => [a.id, a.label])).toEqual([
      ['add-account', 'Add it there'],
      ['dismiss', 'Dismiss'],
    ]);
    expect(await h.views()).toEqual([
      {
        cli: 'claude',
        text: 'Desk has only one account signed in (Default). 1 more is signed in on Studio (Lab): add it here so agents switch when one runs out.',
        add: { cli: 'claude', name: 'Lab' },
        missing: [{ name: 'Lab', account: 'lab@example.com · max', machines: ['Studio'] }],
      },
    ]);
    // Add it there is a link (the UI opens Settings › Accounts): the server refuses it and the item stays open.
    const items = new SystemItemService({ store: w.store });
    await expect(items.act(item?.id as string, 'add-account')).rejects.toBeInstanceOf(SystemItemError);
    expect(await openHints(w)).toHaveLength(1);

    // This machine adds Lab: it has two usable accounts, so it can switch: the item closes by itself.
    const added = await w.accounts.create({ cli: 'claude', name: 'Lab' });
    await signedIn(added.dir as string, 'lab@example.com');
    await w.accounts.check(added.id, { refresh: true });
    await h.check();
    expect(await openHints(w)).toEqual([]);
    expect((await w.store.systemItems.get(item?.id as string))?.closedAction).toBe('resolved');
    expect(await h.views()).toEqual([]);
    expect(w.errors).toEqual([]);
  });

  it('closes when switching is turned off or Studio\'s extra account goes away, and comes back after', async () => {
    const { w, s, h, studio } = await make();
    await s.sync();
    await h.check();
    expect(await openHints(w)).toHaveLength(1);

    await w.accounts.setSettings({ perCli: { claude: false } });
    await h.check();
    expect(await openHints(w)).toEqual([]);
    await w.accounts.setSettings({ perCli: { claude: true } });
    await h.check();
    expect(await openHints(w)).toHaveLength(1);

    studio.accounts = [remote({})];
    await s.sync();
    await h.check();
    expect(await openHints(w)).toEqual([]);
    // Codex / OpenCode accounts of the paired machine never raise it (no identity).
    studio.accounts = [remote({}), remote({ profileId: 'c1', cli: 'codex', name: 'Codex work', identity: null, account: 'Logged in using ChatGPT' })];
    await s.sync();
    await h.check();
    expect(await openHints(w)).toEqual([]);
    // A machine that went away still counts with its last known accounts.
    studio.accounts = [remote({}), lab];
    await s.sync();
    studio.state = 'offline';
    await s.sync();
    await h.check();
    expect(await openHints(w)).toHaveLength(1);
  });

  it('Dismiss keeps it away for the same missing accounts; a new missing account raises it again, up to date', async () => {
    const { w, s, h, studio } = await make();
    await s.sync();
    await h.check();
    const [first] = await openHints(w);
    const items = new SystemItemService({ store: w.store });
    await items.act(first?.id as string, 'dismiss');
    await h.check();
    expect(await openHints(w)).toEqual([]);

    // Studio signs in one more account this machine lacks: the item is back, naming both.
    studio.accounts = [remote({}), lab, remote({ profileId: 'r3', name: 'Max', identity: 'claude:max@example.com', account: 'max@example.com · max', position: 2 })];
    await s.sync();
    await h.check();
    const [again] = await openHints(w);
    expect(again?.id).not.toBe(first?.id);
    expect(again?.detail).toBe('It has only one account signed in (Default). 2 more are signed in on Studio (Lab, Max). Add them on Desk so agents there switch when one runs out.');
    // While open, a change is brought up to date in place (no second item).
    studio.accounts = [remote({}), remote({ profileId: 'r3', name: 'Max', identity: 'claude:max@example.com', account: 'max@example.com · max', position: 2 })];
    await s.sync();
    await h.check();
    const [updated, ...more] = await openHints(w);
    expect(more).toEqual([]);
    expect(updated?.id).toBe(again?.id);
    expect(updated?.detail).toBe('It has only one account signed in (Default). 1 more is signed in on Studio (Max). Add it on Desk so agents there switch when one runs out.');
    expect(systemItem(updated as NonNullable<typeof updated>).addAccount).toEqual({ cli: 'claude', name: 'Max' });
  });

  it('a change (the exchange, a local account) looks again by itself', async () => {
    const { w, s, h } = await make();
    h.start();
    await s.sync();
    await expect.poll(async () => (await openHints(w)).length, { timeout: 5_000 }).toBe(1);
    await w.accounts.setSettings({ enabled: false });
    await expect.poll(async () => (await openHints(w)).length, { timeout: 5_000 }).toBe(0);
  });

  it('the switcher\'s cue: an agent at its limit on the single account says where another one is signed in', async () => {
    const { w, s, h } = await make();
    await s.sync();
    const notices: Array<{ kind: string; title: string; detail: string }> = [];
    switcher = new AutoSwitcher({
      store: w.store,
      supervisor: w.supervisor,
      accounts: w.accounts,
      dataDir: w.root,
      systemItems: { accountNotice: async (input) => (notices.push(input), null) },
      clis: { refusal: async () => null },
      hint: (cli) => h.hintFor(cli),
      intervalMs: 3_600_000,
      onError: (error) => w.errors.push(error),
      log: () => undefined,
    });
    const session = await w.supervisor.start(newSession({ task: 'first task' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    await switcher.onFailedTurn(session.id, "You've hit your session limit · resets 11:59pm");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind).toBe('account-exhausted');
    expect(notices[0]?.title).toBe('Every Claude Code account is out of usage');
    expect(notices[0]?.detail).toMatch(/1 more account is signed in on Studio — add it here\.$/);
    // A single account stays dormant otherwise: no mark.
    expect((await w.store.profiles.get('default-claude'))?.exhaustedUntil).toBeNull();

    // Without anything more on Studio: nothing, as before D142.
    await s.stop();
    const quiet = new AutoSwitcher({ store: w.store, supervisor: w.supervisor, accounts: w.accounts, dataDir: w.root, systemItems: { accountNotice: async (input) => (notices.push(input), null) }, hint: async () => null, intervalMs: 3_600_000 });
    await quiet.onFailedTurn(session.id, "You've hit your session limit · resets 11:58pm");
    await quiet.stop();
    expect(notices).toHaveLength(1);
  });
});
