import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SystemInfo } from '../../../src/core/api.ts';
import type { Providers } from '../../../src/server/providers.ts';
import { createUsageMeter, profileUsageWindows, withAccountUsage } from '../../../src/server/usage/wire.ts';
import { writeFile } from 'node:fs/promises';
import { fakeClaudeCommand } from '../../../tools/fake-claude/command.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, waitForStatus } from '../../helpers/supervisor.ts';

let world: SupervisorWorld | undefined;

afterEach(async () => {
  await world?.cleanup();
  world = undefined;
});

function soon(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

describe('D63 · usage per account profile', () => {
  it('the meter reads each enabled Claude Code profile: the poller runs with that profile\'s CLAUDE_CONFIG_DIR; the bars are the active profile\'s', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const b = await w.accounts.create({ cli: 'claude', name: 'Private' });
    // The fake CLI reports this folder's numbers (its `.fake-usage.json`), resetting in 3 hours / 3 days.
    await writeFile(path.join(b.dir as string, '.fake-usage.json'), JSON.stringify({ five_hour: 62, seven_day: 10 }));
    const meter = createUsageMeter({
      config: { claudeCommand: fakeClaudeCommand(), claudeExtraArgs: [], dataDir: w.root },
      store: w.store,
      sessions: w.supervisor,
      accounts: w.accounts,
    });
    meter.watchViewers(() => 1);
    // The Default has a reading of its own (the fake's recording for it is long past, so it reads as unknown).
    await w.store.usage.add({ source: 'get_usage', sessionId: null, profileId: 'default-claude', fiveHourPct: 20, fiveHourResetsAt: soon(3_600_000), sevenDayPct: 5, sevenDayResetsAt: soon(86_400_000), raw: {} });
    expect(await meter.tick()).toBe('poller');
    const reading = await w.store.usage.latest(undefined, b.id);
    expect(reading).toMatchObject({ fiveHourPct: 62, sevenDayPct: 10, profileId: b.id });
    // The active profile is the first with allowance: the Default (20 %).
    expect((await meter.state()).known && (await meter.state())).toMatchObject({ pct: 20 });
    // Spent Default: the bars follow the next profile.
    await w.accounts.markExhausted({ profileId: 'default-claude', until: soon(3_600_000), window: 'session', text: 'x' });
    expect(await meter.state()).toMatchObject({ known: true, pct: 62 });
    const fields = await meter.systemFields();
    expect(fields.usagePct).toBe(62);
    expect(fields.usageWindows?.map((window) => [window.key, window.pct])).toEqual([['session', 62], ['week', 10]]);
    await meter.stop();
  });

  it('a live session\'s `get_usage` goes to its own profile; a profile with a live session is not polled', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const b = await w.accounts.create({ cli: 'claude', name: 'Private' });
    await writeFile(path.join(b.dir as string, '.fake-usage.json'), JSON.stringify({ five_hour: 33, seven_day: 44 }));
    const session = await w.supervisor.start({ ...newSession({ task: 'first task' }), profileId: b.id }, w.place);
    await waitForStatus(w.store, session.id, ['done']);
    expect(w.supervisor.liveClaudeSessions()).toEqual([{ id: session.id, profileId: b.id, idle: true }]);
    const meter = createUsageMeter({ config: { claudeCommand: fakeClaudeCommand(), claudeExtraArgs: [], dataDir: w.root }, store: w.store, sessions: w.supervisor, accounts: w.accounts });
    meter.watchViewers(() => 1);
    // The Default comes first in priority order and has no live session: it is polled; then B asks its live session.
    expect(await meter.tick()).toBe('poller');
    expect(await meter.tick()).toBe('live');
    expect(await w.store.usage.latest(undefined, b.id)).toMatchObject({ fiveHourPct: 33, sevenDayPct: 44, sessionId: session.id });
    await meter.stop();
  });

  it('rate_limit_event readings of a session are stored under its profile', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const b = await w.accounts.create({ cli: 'claude', name: 'Private' });
    const session = await w.supervisor.start({ ...newSession({ task: 'first task' }), profileId: b.id }, w.place);
    await waitForStatus(w.store, session.id, ['done']);
    const stored = (await w.store.usage.list()).filter((r) => r.source === 'rate_limit_event');
    expect(stored.length).toBeGreaterThan(0);
    for (const reading of stored) expect(reading.profileId).toBe(b.id);
  });

  it('the footer line: each profile\'s usage while a CLI has more than one enabled; the active one marked; a spent one says when', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const b = await w.accounts.create({ cli: 'claude', name: 'Private' });
    await w.store.usage.add({ source: 'get_usage', sessionId: null, profileId: 'default-claude', fiveHourPct: 62, fiveHourResetsAt: soon(3_600_000), sevenDayPct: 5, sevenDayResetsAt: soon(86_400_000), raw: {} });
    await w.store.usage.add({ source: 'get_usage', sessionId: null, profileId: b.id, fiveHourPct: 10, fiveHourResetsAt: soon(3_600_000), sevenDayPct: 5, sevenDayResetsAt: soon(86_400_000), raw: {} });
    const base: Providers = { system: { system: async () => ({ cli: 'claude' }) as unknown as SystemInfo } };
    const rows = async (): Promise<SystemInfo['accountUsage']> => ((await withAccountUsage(base, w.accounts).system?.system()) as SystemInfo).accountUsage;
    const actives = async (): Promise<SystemInfo['activeAccounts']> => ((await withAccountUsage(base, w.accounts).system?.system()) as SystemInfo).activeAccounts;
    expect(await rows()).toEqual([
      { profileId: 'default-claude', cli: 'claude', name: 'Default', active: true, pct: 62, exhaustedUntil: null, windows: [expect.objectContaining({ key: 'session', pct: 62 }), expect.objectContaining({ key: 'week', pct: 5 })] },
      { profileId: b.id, cli: 'claude', name: 'Private', active: false, pct: 10, exhaustedUntil: null, windows: [expect.objectContaining({ key: 'session', pct: 10 }), expect.objectContaining({ key: 'week', pct: 5 })] },
    ]);
    const until1 = soon(3_600_000);
    await w.accounts.markExhausted({ profileId: 'default-claude', until: until1, window: 'session', text: 'x' });
    expect(await rows()).toMatchObject([{ active: false, exhaustedUntil: until1 }, { active: true }]);
    // D66: each CLI's active account by name (the Codex Default is its only one).
    expect(await actives()).toEqual([
      { cli: 'claude', profileId: b.id, name: 'Private' },
      { cli: 'codex', profileId: 'default-codex', name: 'Default' },
    ]);
    // A single enabled profile: no line.
    await w.accounts.update(b.id, { enabled: false });
    expect(((await withAccountUsage(base, w.accounts).system?.system()) as SystemInfo).accountUsage).toBeUndefined();
    // D66: the single account is still named (the footer grid's line label).
    expect((await actives())?.find((a) => a.cli === 'claude')).toEqual({ cli: 'claude', profileId: 'default-claude', name: 'Default' });
  });

  it('D66: each row lists its own windows; with the meter a Claude Code profile\'s include its model limits in use', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const b = await w.accounts.create({ cli: 'claude', name: 'Private' });
    const week = soon(3 * 86_400_000);
    // A `get_usage` answer of B's with an Opus weekly limit in use; the Default only has a 5-hour reading (its week unknown).
    const raw = {
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 10, resets_at: soon(3_600_000) },
        seven_day: { utilization: 40, resets_at: week },
        model_scoped: [{ display_name: 'Opus', utilization: 55, resets_at: week }],
      },
    };
    await w.store.usage.add({ source: 'get_usage', sessionId: null, profileId: b.id, fiveHourPct: 10, fiveHourResetsAt: soon(3_600_000), sevenDayPct: 40, sevenDayResetsAt: week, raw });
    await w.store.usage.add({ source: 'rate_limit_event', sessionId: null, profileId: 'default-claude', fiveHourPct: 62, fiveHourResetsAt: soon(3_600_000), sevenDayPct: null, sevenDayResetsAt: null, raw: {} });
    const meter = createUsageMeter({ config: { claudeCommand: fakeClaudeCommand(), claudeExtraArgs: [], dataDir: w.root }, store: w.store, sessions: w.supervisor, accounts: w.accounts });
    const base: Providers = { system: { system: async () => ({ cli: 'claude' }) as unknown as SystemInfo } };
    const info = (await withAccountUsage(base, w.accounts, Date.now, (id) => meter.profileWindows(id)).system?.system()) as SystemInfo;
    expect(info.accountUsage?.map((row) => [row.name, row.windows?.map((window) => [window.key, window.label, window.pct])])).toEqual([
      ['Default', [['session', 'Session', 62]]],
      [
        'Private',
        [
          ['session', 'Session', 10],
          ['week', 'Week', 40],
          ['model', 'Opus', 55],
        ],
      ],
    ]);
    await meter.stop();
  });

  it('D66: a profile\'s Session and Week from its latest usage (Codex\'s windows): unknown and reset windows are left out', () => {
    const now = Date.parse('2026-10-01T12:00:00.000Z');
    expect(profileUsageWindows({ fiveHourPct: 35, fiveHourResetsAt: null, sevenDayPct: 12, sevenDayResetsAt: '2026-10-04T00:00:00.000Z', receivedAt: null }, now)).toEqual([
      { key: 'session', label: 'Session', pct: 35, resetsAt: null },
      { key: 'week', label: 'Week', pct: 12, resetsAt: '2026-10-04T00:00:00.000Z' },
    ]);
    expect(profileUsageWindows({ fiveHourPct: 35, fiveHourResetsAt: '2026-10-01T11:00:00.000Z', sevenDayPct: null, sevenDayResetsAt: null, receivedAt: null }, now)).toEqual([]);
    expect(profileUsageWindows(null, now)).toEqual([]);
  });
});
