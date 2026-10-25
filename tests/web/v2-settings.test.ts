import { describe, expect, it } from 'vitest';
import type { AccountProfile } from '../../src/core/accounts.ts';
import { DEFAULT_ACCOUNT_SETTINGS } from '../../src/core/accounts.ts';
import { SETTINGS_SECTIONS, resolveSection } from '../../src/web/views/settings/model.ts';
import { V2_SETTINGS_SECTIONS, toV2Path } from '../../src/web/v2/routes.ts';
import { DENSITY_STORAGE_KEY, readDensity, writeDensity } from '../../src/web/v2/settings/density.ts';
import { ADVANCED_PAGES, CLASSIC_SECTION_KEYS, classicSectionTarget, isV2Section, resolveAdvanced, shownSection } from '../../src/web/v2/settings/settings-map.ts';
import { accountCard, accountTitle, inUseIds, offlineSince, secondsLeft, switchAtChoices, switchAtOf, switchAtPatch } from '../../src/web/v2/settings/settings-model.ts';

/** D131 · lane R · v2 Settings: the section map, the account cards, the switching rules, the density. */

const NOW = Date.parse('2026-10-25T10:00:00Z');
const later = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

function profile(over: Partial<AccountProfile>): AccountProfile {
  return {
    id: 'p1',
    cli: 'claude',
    name: 'Work',
    dir: '/tmp/x',
    builtin: false,
    enabled: true,
    position: 0,
    shareSettings: true,
    signIn: 'signed-in',
    account: 'me@example.test · max',
    usage: null,
    exhausted: null,
    signInCommand: 'claude /login',
    sessions: 0,
    ...over,
  };
}

describe('the settings section map', () => {
  it('reaches every classic Settings section (its own v2 section or an Advanced page)', () => {
    for (const key of CLASSIC_SECTION_KEYS) {
      const target = classicSectionTarget(key);
      expect(target, key).not.toBeNull();
      expect(isV2Section(target?.section)).toBe(true);
      if (target?.section === 'advanced') expect(resolveAdvanced(target.sub)).not.toBeNull();
    }
    // Every classic key from the classic list is covered, not just a copy of it.
    for (const section of SETTINGS_SECTIONS) expect(CLASSIC_SECTION_KEYS).toContain(section.key);
  });

  it('every classic /settings/<key> address lands on a v2 page that exists', () => {
    for (const section of SETTINGS_SECTIONS) {
      const path = toV2Path(`/settings/${section.key}`);
      const [, , v2, sub] = path.split('/');
      expect(isV2Section(v2), path).toBe(true);
      if (v2 === 'advanced') expect(resolveAdvanced(sub ?? null), path).not.toBeNull();
    }
  });

  it('old and prototype keys resolve; unknown ones do not', () => {
    expect(resolveAdvanced('folders')?.key).toBe('workspace');
    expect(resolveAdvanced('experimental')?.key).toBe('jira');
    expect(resolveSection('experimental')).toBe('jira');
    expect(resolveAdvanced('mcp')?.key).toBe('connections');
    expect(resolveAdvanced('solutions')?.key).toBe('code-projects');
    expect(resolveAdvanced('nope')).toBeNull();
    expect(resolveAdvanced(null)).toBeNull();
  });

  it('lists the brief’s Advanced pages, each once', () => {
    const keys = ADVANCED_PAGES.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of ['code-projects', 'connections', 'clis', 'workspace', 'sessions', 'schedules', 'tools', 'github', 'ci', 'processes', 'jira', 'updates', 'tutorial', 'cleanup', 'setup', 'login']) {
      expect(keys).toContain(key);
    }
  });

  it('/settings opens Usage on a desktop and the list on a phone', () => {
    expect(shownSection(null, false)).toBe('usage');
    expect(shownSection(null, true)).toBeNull();
    expect(shownSection('phones', true)).toBe('phones');
    expect(V2_SETTINGS_SECTIONS).toContain('appearance');
  });
});

describe('switch at', () => {
  it('reads the D63 thresholds as one percentage (100 = off)', () => {
    expect(switchAtOf(DEFAULT_ACCOUNT_SETTINGS)).toBe(98);
    expect(switchAtOf({ thresholds: { enabled: false, fiveHourPct: 90, weeklyPct: 90 } })).toBe(100);
    expect(switchAtOf({ thresholds: { enabled: true, fiveHourPct: 95, weeklyPct: 90 } })).toBe(90);
  });

  it('writes both windows, or turns the thresholds off at 100', () => {
    expect(switchAtPatch(95)).toEqual({ thresholds: { enabled: true, fiveHourPct: 95, weeklyPct: 95 } });
    expect(switchAtPatch(100)).toEqual({ thresholds: { enabled: false } });
  });

  it('offers the four choices plus a stored odd one', () => {
    expect(switchAtChoices(98)).toEqual([90, 95, 98, 100]);
    expect(switchAtChoices(80)).toEqual([80, 90, 95, 98, 100]);
  });
});

describe('account cards', () => {
  it('names an account by engine and name; the own login by the engine', () => {
    expect(accountTitle({ cli: 'claude', name: 'Work', builtin: false })).toBe('Claude “Work”');
    expect(accountTitle({ cli: 'codex', name: 'Default', builtin: true })).toBe('Codex CLI');
  });

  it('shows what is left of each window, and nothing invented without a reading', () => {
    const card = accountCard(profile({ usage: { fiveHourPct: 72, fiveHourResetsAt: later(60), sevenDayPct: 48, sevenDayResetsAt: later(3000), receivedAt: later(-1) } }), true, NOW);
    expect(card.status).toBe('working');
    expect(card.statusLabel).toBe('In use now');
    expect(card.windows[0]).toMatchObject({ label: '5 hours', used: 72 });
    expect(card.windows[0]?.text).toMatch(/^28% left · resets/);
    expect(card.windows[1]).toMatchObject({ label: 'Week', used: 48 });
    const bare = accountCard(profile({}), false, NOW);
    expect(bare.windows.map((w) => w.used)).toEqual([null, null]);
    expect(bare.statusLabel).toBe('Available');
  });

  it('says out of usage, on paid extra, signed out and turned off in words', () => {
    expect(accountCard(profile({ exhausted: { until: later(30), window: 'session', text: null } }), false, NOW).statusLabel).toBe('Out of usage');
    const paid = accountCard(
      profile({ usage: { fiveHourPct: 100, fiveHourResetsAt: later(30), sevenDayPct: 50, sevenDayResetsAt: later(3000), receivedAt: null, credits: { onCredits: true, until: later(30), enabled: true, currency: 'EUR', limit: 50, used: 37.6, left: 12.4, resetsAt: later(9000), limitReached: false } as never } }),
      false,
      NOW,
    );
    expect(paid.statusLabel).toBe('On paid extra');
    expect(paid.credits?.onCredits).toBe(true);
    expect(paid.credits?.text).toContain('12.40');
    expect(accountCard(profile({ signIn: 'signed-out' }), false, NOW).statusLabel).toBe('Signed out');
    expect(accountCard(profile({ enabled: false }), false, NOW).statusLabel).toBe('Turned off');
  });

  it('the account in use is the first usable one of each engine', () => {
    const ids = inUseIds(
      [
        profile({ id: 'a', position: 0, exhausted: { until: later(10), window: 'session', text: null } }),
        profile({ id: 'b', position: 1 }),
        profile({ id: 'c', position: 2 }),
        profile({ id: 'x', cli: 'codex', position: 0 }),
      ],
      NOW,
    );
    expect([...ids].sort()).toEqual(['b', 'x']);
  });
});

describe('times', () => {
  it('counts down to the next try, never below 0', () => {
    expect(secondsLeft(new Date(NOW + 7_200).toISOString(), NOW)).toBe(8);
    expect(secondsLeft(new Date(NOW - 5_000).toISOString(), NOW)).toBe(0);
    expect(secondsLeft(null, NOW)).toBeNull();
  });

  it('says since when a computer is offline', () => {
    expect(offlineSince(null, NOW)).toBe('Offline');
    expect(offlineSince(later(-30), NOW)).toMatch(/^Offline since \d\d:\d\d$/);
  });
});

describe('density', () => {
  it('is Comfortable by default and keeps Compact per browser', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    expect(readDensity(storage)).toBe('comfortable');
    writeDensity(storage, 'compact');
    expect(map.get(DENSITY_STORAGE_KEY)).toBe('compact');
    expect(readDensity(storage)).toBe('compact');
    expect(readDensity(null)).toBe('comfortable');
    map.set(DENSITY_STORAGE_KEY, 'weird');
    expect(readDensity(storage)).toBe('comfortable');
  });
});
