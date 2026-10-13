import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SystemInfo } from '../../../src/core/api.ts';
import type { SharedAccount } from '../../../src/core/shared-accounts.ts';
import { AutoSwitcher } from '../../../src/server/accounts/auto-switch.ts';
import { SharedAccounts, type SharedAccountsPeers } from '../../../src/server/accounts/shared.ts';
import type { Providers } from '../../../src/server/providers.ts';
import { withAccountUsage } from '../../../src/server/usage/wire.ts';
import type { UserPayload } from '../../../src/core/event-payload.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, spawnedArgv, stdinOf, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D103 (`docs/accounts.md` → *Credits*): an account at its plan limit that still
 * answers runs on credits; the switcher prefers any account with allowance, moves
 * sessions off credits at a turn boundary, keeps them on credits when nothing has
 * allowance (or pauses new turns, by the setting), shares the state with paired
 * machines and raises one Inbox item per event.
 */

let world: SupervisorWorld | undefined;
let switcher: AutoSwitcher | undefined;
let shared: SharedAccounts | undefined;

afterEach(async () => {
  await switcher?.stop();
  await shared?.stop();
  world?.accounts.useShared(null);
  await world?.cleanup();
  switcher = undefined;
  shared = undefined;
  world = undefined;
});

interface Notice {
  readonly kind: string;
  readonly title: string;
  readonly detail: string;
  readonly dedupe: string;
}

const soon = (ms: number): string => new Date(Date.now() + ms).toISOString();
const epoch = (ms: number): number => Math.floor((Date.now() + ms) / 1000);
const HOUR = 3_600_000;

/** A `get_usage` answer with Acme credits (minor units, 2 decimals). */
function getUsageRaw(five: number, week: number, credits: { enabled: boolean; limit?: number; used?: number }): unknown {
  return {
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: five, resets_at: soon(HOUR) },
      seven_day: { utilization: week, resets_at: soon(48 * HOUR) },
      extra_usage: { is_enabled: credits.enabled, monthly_limit: credits.limit ?? null, used_credits: credits.used ?? null, utilization: null, currency: credits.enabled ? 'EUR' : null, decimal_places: credits.enabled ? 2 : null, spend_limit_reached: false },
    },
  };
}

async function make(): Promise<{ w: SupervisorWorld; notices: Notice[] }> {
  const w = await makeSupervisorWorld();
  world = w;
  const notices: Notice[] = [];
  switcher = new AutoSwitcher({
    store: w.store,
    supervisor: w.supervisor,
    accounts: w.accounts,
    dataDir: w.root,
    systemItems: { accountNotice: async () => null, creditNotice: async (input) => (notices.some((n) => n.dedupe === input.dedupe) ? null : (notices.push(input), null)) },
    clis: { refusal: async () => null },
    intervalMs: 3_600_000,
    onError: (error) => w.errors.push(error),
    log: () => undefined,
  });
  switcher.start();
  return { w, notices };
}

/** Default (Acme Work): weekly at 100 % while still answering, paid from credits (a rate_limit_event with overage in use). */
async function workOnCredits(w: SupervisorWorld, used = 37.6): Promise<void> {
  await w.store.usage.add({ source: 'get_usage', sessionId: null, profileId: 'default-claude', fiveHourPct: 20, fiveHourResetsAt: soon(HOUR), sevenDayPct: 99, sevenDayResetsAt: soon(48 * HOUR), raw: getUsageRaw(20, 99, { enabled: true, limit: 5000, used: Math.round(used * 100) }) });
  await w.store.usage.add({
    source: 'rate_limit_event',
    sessionId: null,
    profileId: 'default-claude',
    fiveHourPct: 20,
    fiveHourResetsAt: soon(HOUR),
    sevenDayPct: 100,
    sevenDayResetsAt: soon(48 * HOUR),
    raw: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: epoch(48 * HOUR), rateLimitType: 'seven_day', overageStatus: 'allowed', overageResetsAt: epoch(400 * HOUR), isUsingOverage: true, overageInUse: true } },
  });
}

async function reading(w: SupervisorWorld, profileId: string, five: number, week: number, resetIn = HOUR): Promise<void> {
  await w.store.usage.add({ source: 'get_usage', sessionId: null, profileId, fiveHourPct: five, fiveHourResetsAt: soon(resetIn), sevenDayPct: week, sevenDayResetsAt: soon(48 * HOUR), raw: getUsageRaw(five, week, { enabled: false }) });
}

async function turnsOf(w: SupervisorWorld, sessionId: string) {
  return (await w.store.events.list(sessionId)).filter((e) => (e.payload as { type?: string } | null)?.type === 'result');
}

async function claudeSpawns(w: SupervisorWorld) {
  return (await spawnedArgv(w.logFile)).filter((line) => line.argv?.[0] !== 'agents' && line.argv?.[0] !== 'auth');
}

/** Every user line any fake-claude process got on stdin. */
async function claudeStdinTexts(w: SupervisorWorld): Promise<string[]> {
  const out: string[] = [];
  for (const spawn of await claudeSpawns(w)) for (const line of await stdinOf(w.logFile, spawn.pid ?? -1)) if (line['type'] === 'user') out.push(JSON.stringify(line));
  return out;
}

const base: Providers = { system: { system: async () => ({ cli: 'claude' }) as unknown as SystemInfo } };
const system = async (w: SupervisorWorld): Promise<SystemInfo> => (await withAccountUsage(base, w.accounts).system?.system()) as SystemInfo;

describe('D103 · credits per account', () => {
  it('100 % weekly while still answering → on credits, with the money left; shown on the account and its footer row', async () => {
    const { w } = await make();
    await w.accounts.create({ cli: 'claude', name: 'Private' });
    await workOnCredits(w);
    const work = (await w.accounts.list({ check: false })).find((p) => p.id === 'default-claude');
    expect(work?.usage?.credits).toMatchObject({ onCredits: true, enabled: true, currency: 'EUR', limit: 50, used: 37.6, left: 12.4 });
    const row = (await system(w)).accountUsage?.find((r) => r.profileId === 'default-claude');
    expect(row?.credits).toMatchObject({ onCredits: true, left: 12.4 });
  });

  it('the switcher prefers allowance: a new session starts on the account with allowance, not the one on credits', async () => {
    const { w } = await make();
    const b = await w.accounts.create({ cli: 'claude', name: 'Private' });
    await workOnCredits(w);
    await reading(w, b.id, 3, 40);
    expect(await w.accounts.pick('claude', { check: false })).toBe(b.id);
    // Private at its 5-hour limit (no credits): the account on credits takes new sessions ("use credits").
    await reading(w, b.id, 100, 40);
    expect(await w.accounts.pick('claude', { check: false })).toBe('default-claude');
  });

  it('a reset moves a session on credits back to an account with allowance at the turn boundary, never mid-turn', async () => {
    const { w } = await make();
    const b = await w.accounts.create({ cli: 'claude', name: 'Private' });
    await workOnCredits(w);
    await reading(w, b.id, 100, 40);
    const session = await w.supervisor.start({ ...newSession({ task: 'first task' }), profileId: 'default-claude' }, w.place);
    await waitForStatus(w.store, session.id, ['done']);
    // Nothing has allowance: the session stays on credits.
    await switcher?.tick();
    expect((await w.store.sessions.get(session.id))?.profileId).toBe('default-claude');
    // A turn runs; meanwhile Private's 5-hour window resets. (The fake CLI's own rate_limit_event of the turn is
    // replaced by the readings of an account on credits again.)
    await w.supervisor.sendMessage(session.id, '[fake:hold 2] think');
    await waitForStatus(w.store, session.id, ['run']);
    await workOnCredits(w);
    await reading(w, b.id, 0, 40);
    await switcher?.tick();
    expect((await w.store.sessions.get(session.id))?.profileId).toBe('default-claude');
    expect((await w.store.events.list(session.id)).some((e) => e.label.startsWith('Switched account:'))).toBe(false);
    // The turn ends: the next check moves it, with the reason in the divider.
    await waitForStatus(w.store, session.id, ['done']);
    await workOnCredits(w);
    await switcher?.tick();
    expect((await w.store.sessions.get(session.id))?.profileId).toBe(b.id);
    const divider = await until(async () => (await w.store.events.list(session.id)).find((e) => e.label.startsWith('Switched account:')), 'the divider');
    expect(divider.label).toBe('Switched account: Default → Private (moved off credits: Private has allowance again)');
  });

  it('all out: stays on credits by default; "pause" holds new turns (queued, not refused) and sends them in order on the account that resets', async () => {
    const { w } = await make();
    const b = await w.accounts.create({ cli: 'claude', name: 'Private' });
    await workOnCredits(w);
    await reading(w, b.id, 100, 40);
    const session = await w.supervisor.start({ ...newSession({ task: 'first task' }), profileId: 'default-claude' }, w.place);
    await waitForStatus(w.store, session.id, ['done']);
    // "use credits" (default): the turn runs on the account on credits.
    await workOnCredits(w);
    await w.supervisor.sendMessage(session.id, 'on credits');
    await until(async () => ((await turnsOf(w, session.id)).length >= 2 ? true : undefined), 'the second turn');
    await workOnCredits(w);
    await w.accounts.setSettings({ outOfAllowance: 'pause' });
    // Paused: two messages wait in the session (queued "credits", with the note), nothing reaches the CLI.
    await w.supervisor.sendMessage(session.id, 'held one');
    await w.supervisor.sendMessage(session.id, 'held two');
    const held = await w.supervisor.heldMessages(session.id);
    expect(held.map((e) => (e.payload as UserPayload).text)).toEqual(['held one', 'held two']);
    expect(held[0]?.payload).toMatchObject({ queued: 'credits', delivered: false, heldNote: expect.stringMatching(/^Waiting for an account with allowance — Private back at \d\d:\d\d$/) });
    const before = await claudeStdinTexts(w);
    expect(before.some((t) => t.includes('held one'))).toBe(false);
    // The 30-second check while still paused: nothing goes out.
    await switcher?.releaseHeld();
    expect(await w.supervisor.heldMessages(session.id)).toHaveLength(2);
    // Private resets: the session moves to it and the two go out, in order, in their own bubbles.
    await reading(w, b.id, 1, 40);
    await switcher?.releaseHeld();
    expect((await w.store.sessions.get(session.id))?.profileId).toBe(b.id);
    expect(await w.supervisor.heldMessages(session.id)).toEqual([]);
    await until(async () => ((await turnsOf(w, session.id)).length >= 4 ? true : undefined), 'the two held turns', 20_000);
    const spawns = await claudeSpawns(w);
    expect(spawns.at(-1)?.env?.['CLAUDE_CONFIG_DIR']).toBe(b.dir);
    const texts = (await stdinOf(w.logFile, spawns.at(-1)?.pid ?? -1)).filter((l) => l['type'] === 'user').map((l) => JSON.stringify(l));
    const one = texts.findIndex((t) => t.includes('held one'));
    const two = texts.findIndex((t) => t.includes('held two'));
    expect(one).toBeGreaterThanOrEqual(0);
    expect(two).toBeGreaterThan(one);
    // The same events, no longer held.
    const after = await Promise.all(held.map((e) => w.store.events.get(e.id)));
    expect(after.map((e) => (e?.payload as UserPayload).queued === 'credits')).toEqual([false, false]);
  });

  it('a held message can be taken back (Edit / Remove); a new session, a loop firing and a repeated service message wait without duplicates', async () => {
    const { w } = await make();
    const b = await w.accounts.create({ cli: 'claude', name: 'Private' });
    await workOnCredits(w);
    await reading(w, b.id, 100, 40);
    await w.accounts.setSettings({ outOfAllowance: 'pause' });
    // A new session (a plan / todo-run start): it starts idle and its first message waits.
    const session = await w.supervisor.start({ ...newSession({ task: 'plan item' }), profileId: 'default-claude' }, w.place);
    expect((await w.supervisor.heldMessages(session.id)).map((e) => (e.payload as UserPayload).origin)).toEqual(['task']);
    // A loop's firings (D94): one waits, the next ones of the same loop do not pile up; a service message once.
    const loop = { id: 'loop-1', label: 'Check CI', run: 1 };
    await w.supervisor.sendMessage(session.id, 'check CI', 'service', undefined, { loop });
    await w.supervisor.sendMessage(session.id, 'check CI', 'service', undefined, { loop: { ...loop, run: 2 } });
    await w.supervisor.sendMessage(session.id, 'start todo 3', 'service');
    await w.supervisor.sendMessage(session.id, 'start todo 3', 'service');
    await w.supervisor.sendMessage(session.id, 'mine', 'user');
    const held = await w.supervisor.heldMessages(session.id);
    expect(held.map((e) => (e.payload as UserPayload).text)).toEqual(['plan item', 'check CI', 'start todo 3', 'mine']);
    // Remove one, Edit another (its text comes back): both never go out.
    const mine = held[3] as (typeof held)[number];
    expect(await w.supervisor.withdrawHeld(session.id, mine.id)).toMatchObject({ text: 'mine' });
    await expect(w.supervisor.withdrawHeld(session.id, mine.id)).rejects.toMatchObject({ code: 'not-held' });
    await w.supervisor.withdrawHeld(session.id, (held[2] as (typeof held)[number]).id);
    expect((await w.store.events.get(mine.id))?.payload).toMatchObject({ withdrawn: true });
    expect((await w.supervisor.heldMessages(session.id)).map((e) => (e.payload as UserPayload).text)).toEqual(['plan item', 'check CI']);
    // The setting back to "use credits": the rest goes out by itself (nothing pauses any more).
    await w.accounts.setSettings({ outOfAllowance: 'use-credits' });
    await switcher?.releaseHeld();
    expect(await w.supervisor.heldMessages(session.id)).toEqual([]);
    await until(async () => ((await turnsOf(w, session.id)).length >= 2 ? true : undefined), 'the two turns', 20_000);
    const texts = (await claudeStdinTexts(w)).join('\n');
    expect(texts).toContain('plan item');
    expect(texts).not.toContain('start todo 3');
    expect(texts).not.toContain('mine');
  });

  it('the notices fire once: on credits, and credits below 20 % of the limit', async () => {
    const { w, notices } = await make();
    await w.accounts.create({ cli: 'claude', name: 'Private' });
    await workOnCredits(w, 45);
    await switcher?.tick();
    await switcher?.tick();
    expect(notices.map((n) => n.kind).sort()).toEqual(['account-credits', 'account-credits-low']);
    expect(notices.find((n) => n.kind === 'account-credits')?.title).toBe('Default is using credits');
    expect(notices.find((n) => n.kind === 'account-credits-low')?.detail).toContain('€5 left of €50');
    // A fresh reading of the same episode: still one each.
    await workOnCredits(w, 46);
    await switcher?.tick();
    expect(notices).toHaveLength(2);
  });

  it('the credit state is shared with a paired machine: its newer reading of the same account counts here (D98)', async () => {
    const w = await makeSupervisorWorld();
    world = w;
    await writeFile(path.join(w.configDir, '.fake-auth.json'), JSON.stringify({ loggedIn: true, email: 'dev@example.com' }));
    const credits = { onCredits: true, until: soon(48 * HOUR), enabled: true, currency: 'EUR', limit: 50, used: 40, left: 10, resetsAt: soon(400 * HOUR), limitReached: false, at: soon(5_000) };
    const theirs: SharedAccount = {
      profileId: 'r1',
      cli: 'claude',
      name: 'Default',
      identity: 'claude:dev@example.com',
      account: 'dev@example.com · max',
      enabled: true,
      position: 0,
      signIn: 'signed-in',
      usage: { fiveHourPct: 20, fiveHourResetsAt: soon(HOUR), sevenDayPct: 100, sevenDayResetsAt: soon(48 * HOUR), receivedAt: soon(5_000), credits },
      exhausted: null,
    };
    const sent: unknown[] = [];
    const peers: SharedAccountsPeers = {
      self: async () => ({ id: 'm-self', name: 'Desk' }),
      machines: async () => [{ id: 'm-studio', name: 'Studio', state: 'online' }],
      ask: async (_id, method, route, body) => {
        if (method === 'POST' && route === '/api/accounts/shared') {
          sent.push(body);
          return { status: 200, body: { v: 1, machine: { id: 'm-studio', name: 'Studio' }, accounts: [theirs], prefs: { names: {}, order: {} } } };
        }
        return { status: 404, body: null };
      },
    };
    shared = new SharedAccounts({ accounts: w.accounts, store: w.store, peers, pushDelayMs: 10, intervalMs: 3_600_000, log: () => undefined, onError: (error) => w.errors.push(error) });
    w.accounts.useShared(shared);
    await w.store.usage.add({ source: 'get_usage', sessionId: null, profileId: 'default-claude', fiveHourPct: 10, fiveHourResetsAt: soon(HOUR), sevenDayPct: 50, sevenDayResetsAt: soon(48 * HOUR), raw: getUsageRaw(10, 50, { enabled: true, limit: 5000, used: 1000 }) });
    await shared.sync();
    // This machine's own credit state goes out in the exchange …
    const outgoing = sent.at(-1) as { accounts: Array<{ usage: { credits?: unknown } | null }> };
    expect(outgoing.accounts[0]?.usage?.credits).toMatchObject({ onCredits: false, enabled: true, limit: 50, used: 10 });
    // … and the paired machine's newer reading, credits included, is the account's here.
    const [snapshot] = await w.accounts.snapshots('claude');
    expect(snapshot?.usage?.credits).toMatchObject({ onCredits: true, left: 10 });
    expect((await w.accounts.list({ check: false }))[0]).toMatchObject({ usageFrom: 'Studio', usage: { credits: { onCredits: true } } });
  });
});
