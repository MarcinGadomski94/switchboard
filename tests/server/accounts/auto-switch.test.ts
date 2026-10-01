import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AutoSwitcher } from '../../../src/server/accounts/auto-switch.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, spawnedArgv, stdinOf, until, waitForStatus } from '../../helpers/supervisor.ts';

let world: SupervisorWorld | undefined;
let switcher: AutoSwitcher | undefined;

afterEach(async () => {
  await switcher?.stop();
  await world?.cleanup();
  switcher = undefined;
  world = undefined;
});

interface Notice {
  readonly kind: string;
  readonly sessionId: string;
  readonly title: string;
  readonly detail: string;
}

async function make(): Promise<{ w: SupervisorWorld; notices: Notice[]; logs: string[] }> {
  const w = await makeSupervisorWorld();
  world = w;
  const notices: Notice[] = [];
  const logs: string[] = [];
  switcher = new AutoSwitcher({
    store: w.store,
    supervisor: w.supervisor,
    accounts: w.accounts,
    dataDir: w.root,
    systemItems: { accountNotice: async (input) => (notices.push(input), null) },
    clis: { refusal: async () => null },
    intervalMs: 3_600_000,
    onError: (error) => w.errors.push(error),
    log: (line) => logs.push(line),
  });
  switcher.start();
  return { w, notices, logs };
}

async function claudeSpawns(w: SupervisorWorld) {
  return (await spawnedArgv(w.logFile)).filter((line) => line.argv?.[0] !== 'agents' && line.argv?.[0] !== 'auth');
}

async function turnsOf(w: SupervisorWorld, sessionId: string) {
  return (await w.store.events.list(sessionId)).filter((e) => (e.payload as { type?: string } | null)?.type === 'result');
}

describe('D63 · automatic switching on a usage limit', () => {
  it('the limit error of the Default switches the session to the next profile, which carries on; the Default is marked spent until its reset', async () => {
    const { w, logs } = await make();
    const b = await w.accounts.create({ cli: 'claude', name: 'Private' });
    const session = await w.supervisor.start(newSession({ task: 'first task' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    // The Default hits its session limit (the fake's marker in that config folder).
    await writeFile(path.join(w.configDir, '.fake-limit'), "You've hit your session limit · resets 11:59pm");
    await w.supervisor.sendMessage(session.id, 'second task');
    await until(async () => (await w.store.sessions.get(session.id))?.profileId === b.id || undefined, 'the switch to Private');
    // The divider carries the window and the reset; the interrupted turn is picked up on the new account.
    const divider = await until(async () => (await w.store.events.list(session.id)).find((e) => e.label.startsWith('Switched account:')), 'the divider');
    expect(divider.label).toMatch(/^Switched account: Default → Private \(session limit, resets \d\d:\d\d\)$/);
    await until(async () => ((await turnsOf(w, session.id)).length >= 3 ? true : undefined), 'the continued turn');
    const spawns = await claudeSpawns(w);
    expect(spawns.at(-1)?.env?.['CLAUDE_CONFIG_DIR']).toBe(b.dir);
    const texts = (await stdinOf(w.logFile, spawns.at(-1)?.pid ?? -1)).filter((l) => l['type'] === 'user').map((l) => JSON.stringify(l));
    expect(texts.join('')).toContain('Continue where you left off');
    // The Default is marked spent until the CLI's reset time (23:59 today at the latest tomorrow); the session is on B.
    const spent = await w.store.profiles.get('default-claude');
    expect(spent?.exhaustedWindow).toBe('session');
    expect(Date.parse(spent?.exhaustedUntil ?? '')).toBeGreaterThan(Date.now());
    expect(spent?.exhaustedText).toContain("You've hit your session limit");
    expect((await w.accounts.list({ check: false })).find((p) => p.id === 'default-claude')?.exhausted).toMatchObject({ window: 'session' });
    expect(logs.some((line) => line.includes('switched account (session limit, resets'))).toBe(true);
    // A new session now starts on the first profile with allowance: B (the Default is spent).
    expect(await w.accounts.pick('claude')).toBe(b.id);
  });

  it('no loops: when the next profile is at its limit too, the session stays put, nothing more is switched, and an Inbox item says every account is spent', async () => {
    const { w, notices } = await make();
    const b = await w.accounts.create({ cli: 'claude', name: 'Private' });
    const session = await w.supervisor.start(newSession({ task: 'first task' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    await writeFile(path.join(w.configDir, '.fake-limit'), "You've hit your session limit · resets 11:59pm");
    await writeFile(path.join(b.dir as string, '.fake-limit'), "You've hit your weekly limit · resets 11:59pm");
    await w.supervisor.sendMessage(session.id, 'second task');
    await until(async () => (notices.length > 0 ? true : undefined), 'the Inbox item', 15_000);
    expect(notices[0]).toMatchObject({ kind: 'account-exhausted', sessionId: session.id });
    expect(notices[0]?.title).toBe('Every Claude Code account is out of usage');
    // One switch (Default → Private); Private's own limit found Default spent: no third one.
    const switches = (await w.store.events.list(session.id)).filter((e) => e.label.startsWith('Switched account:'));
    expect(switches).toHaveLength(1);
    expect((await w.store.sessions.get(session.id))?.profileId).toBe(b.id);
    expect((await w.store.profiles.get(b.id))?.exhaustedWindow).toBe('weekly');
    expect(await w.accounts.pick('claude')).toBeNull();
  });

  it('a pinned session is not switched (its profile is marked spent, an Inbox item says why)', async () => {
    const { w, notices } = await make();
    await w.accounts.create({ cli: 'claude', name: 'Private' });
    const session = await w.supervisor.start(newSession({ task: 'first task' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.setProfilePinned(session.id, true);
    await writeFile(path.join(w.configDir, '.fake-limit'), "You've hit your session limit");
    await w.supervisor.sendMessage(session.id, 'second task');
    await until(async () => (notices.length > 0 ? true : undefined), 'the Inbox item');
    expect(notices[0]?.detail).toContain('pinned');
    expect((await w.store.sessions.get(session.id))?.profileId).toBe('default-claude');
    expect((await w.store.profiles.get('default-claude'))?.exhaustedUntil).not.toBeNull();
  });

  it('the master and per-CLI toggles stop it; "every account spent → another CLI" hands the session over with the D62 handover', async () => {
    const { w, notices } = await make();
    await w.accounts.setSettings({ enabled: false });
    const session = await w.supervisor.start(newSession({ task: 'first task' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    await writeFile(path.join(w.configDir, '.fake-limit'), "You've hit your session limit");
    await w.supervisor.sendMessage(session.id, 'second task');
    await until(async () => ((await turnsOf(w, session.id)).length >= 2 ? true : undefined), 'the failed turn');
    await switcher?.onFailedTurn(session.id, "You've hit your session limit");
    expect((await w.store.sessions.get(session.id))?.provider).toBe('claude');
    expect(notices).toEqual([]);
    // On again, with "switch to Codex CLI" when every account is spent (a single account here, so it is spent at once).
    await w.accounts.setSettings({ enabled: true, exhausted: { action: 'switch-cli', cli: 'codex' } });
    await switcher?.onFailedTurn(session.id, "You've hit your session limit");
    await until(async () => (await w.store.sessions.get(session.id))?.provider === 'codex' || undefined, 'the handover to Codex', 20_000);
    expect(notices).toEqual([]);
  });

  it('thresholds: a profile past 98 % moves the live session to one under them; the cooldown keeps it from bouncing', async () => {
    const { w, logs } = await make();
    const b = await w.accounts.create({ cli: 'claude', name: 'Private' });
    const session = await w.supervisor.start(newSession({ task: 'first task' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    const soon = (ms: number): string => new Date(Date.now() + ms).toISOString();
    await w.store.usage.add({ source: 'get_usage', sessionId: null, profileId: 'default-claude', fiveHourPct: 99, fiveHourResetsAt: soon(3_600_000), sevenDayPct: 20, sevenDayResetsAt: soon(86_400_000), raw: {} });
    await w.store.usage.add({ source: 'get_usage', sessionId: null, profileId: b.id, fiveHourPct: 10, fiveHourResetsAt: soon(3_600_000), sevenDayPct: 5, sevenDayResetsAt: soon(86_400_000), raw: {} });
    await switcher?.tick();
    expect((await w.store.sessions.get(session.id))?.profileId).toBe(b.id);
    expect((await w.store.events.list(session.id)).some((e) => e.label === 'Switched account: Default → Private (session at 99 %)')).toBe(true);
    // B turns hot and the Default is fine: the cooldown (120 s) still holds the session.
    await w.store.usage.add({ source: 'get_usage', sessionId: null, profileId: b.id, fiveHourPct: 99, fiveHourResetsAt: soon(3_600_000), sevenDayPct: 5, sevenDayResetsAt: soon(86_400_000), raw: {} });
    await w.store.usage.add({ source: 'get_usage', sessionId: null, profileId: 'default-claude', fiveHourPct: 1, fiveHourResetsAt: soon(3_600_000), sevenDayPct: 5, sevenDayResetsAt: soon(86_400_000), raw: {} });
    await switcher?.tick();
    expect((await w.store.sessions.get(session.id))?.profileId).toBe(b.id);
    expect(logs.filter((line) => line.includes('switched account'))).toHaveLength(1);
  });

  it('after a reset, "switch back to the first profile" returns an idle session; "stay" does not', async () => {
    const { w } = await make();
    const b = await w.accounts.create({ cli: 'claude', name: 'Private' });
    const session = await w.supervisor.start({ ...newSession({ task: 'first task' }), profileId: b.id }, w.place);
    await waitForStatus(w.store, session.id, ['done']);
    expect((await w.store.sessions.get(session.id))?.profileId).toBe(b.id);
    await w.accounts.setSettings({ afterReset: 'stay', cooldownSeconds: 0 });
    await switcher?.tick();
    expect((await w.store.sessions.get(session.id))?.profileId).toBe(b.id);
    await w.accounts.setSettings({ afterReset: 'back-to-first' });
    // The Default's mark has passed (a reset): it has allowance again and is first.
    await w.store.profiles.update('default-claude', { exhaustedUntil: new Date(Date.now() - 1_000).toISOString(), exhaustedWindow: 'session', exhaustedText: 'x' });
    await switcher?.tick();
    expect((await w.store.sessions.get(session.id))?.profileId).toBe('default-claude');
    const spawns = await until(async () => {
      const found = await claudeSpawns(w);
      return found.length >= 2 ? found : undefined;
    }, 'the resumed process');
    expect(spawns.at(-1)?.argv).toContain('--resume');
    expect(spawns.at(-1)?.env?.['CLAUDE_CONFIG_DIR']).toBe(w.configDir);
  });
});
