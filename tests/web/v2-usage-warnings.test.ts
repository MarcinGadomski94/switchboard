import { describe, expect, it } from 'vitest';
import type { SystemInfo, UsageWarning } from '../../src/core/api.ts';
import { usageWarningKey, warningsToShow } from '../../src/web/toast/usage-warning.ts';
import { DISMISSED_ALERTS_KEY, createNeedsYouStore, usageAlerts } from '../../src/web/v2/shared/needs-you-store.ts';
import type { NeedsItem } from '../../src/web/v2/shared/needs-you-model.ts';
import { resetsText, usageWarningAlerts, usageWarningToastText, warningAccount, warningsInForce } from '../../src/web/v2/shared/usage-warning-model.ts';
import { statusPill, usageTone } from '../../src/web/v2/shell/status-model.ts';

/** Fix after 2.0 · the Max usage warnings in v2 and the "Warn at" threshold (`docs/v2.md` → *Usage warnings*). */

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const RESET = new Date(NOW + 108 * 60_000).toISOString();

const warning = (extra: Partial<UsageWarning> = {}): UsageWarning => ({ window: 'five_hour', pct: 92, threshold: 90, resetsAt: RESET, firedAt: '2026-10-26T11:55:00.000Z', ...extra });

function system(extra: Partial<SystemInfo> = {}, sessionPct = 92): SystemInfo {
  return {
    cli: 'claude',
    cliVersion: '2',
    signedIn: true,
    ghSignedIn: true,
    cpu: 10,
    ramUsed: 1,
    ramTotal: 2,
    processes: 0,
    activeAccounts: [{ cli: 'claude', profileId: 'work', name: 'Work' }],
    usageWindows: [
      { key: 'session', label: 'Session', pct: sessionPct, resetsAt: RESET },
      { key: 'week', label: 'Week', pct: 40, resetsAt: RESET },
    ],
    usageWarnings: [warning()],
    ...extra,
  } as unknown as SystemInfo;
}

describe('fix after 2.0 · the status pill uses the developer’s "Warn at"', () => {
  it('amber from the configured threshold, not 90; red when spent', () => {
    expect(usageTone(72, false, 70)).toBe('amber');
    expect(usageTone(72, false, 75)).toBe('green');
    expect(usageTone(72, false)).toBe('green');
    expect(usageTone(92, false)).toBe('amber');
    expect(usageTone(10, true, 70)).toBe('red');
    expect(usageTone(null, false, 1)).toBe('green');
  });

  it('the pill and every account row of its popover', () => {
    const info = {
      ...system(),
      accountUsage: [
        { cli: 'claude', profileId: 'work', name: 'Work', active: true, pct: 72, exhaustedUntil: null, windows: [{ key: 'session', label: '5h', pct: 72, resetsAt: null }, { key: 'week', label: 'Week', pct: 48, resetsAt: null }] },
        { cli: 'claude', profileId: 'side', name: 'Side', active: false, pct: 61, exhaustedUntil: null, windows: [{ key: 'session', label: '5h', pct: 61, resetsAt: null }, { key: 'week', label: 'Week', pct: 20, resetsAt: null }] },
      ],
      usageWindows: undefined,
    } as unknown as SystemInfo;
    const at60 = statusPill(info, [], 'Acme-MacBook', NOW, 60);
    expect(at60.usage?.tone).toBe('amber');
    expect(at60.accounts.map((a) => [a.name, a.sessionTone, a.weekTone])).toEqual([
      ['Work', 'amber', 'green'],
      ['Side', 'amber', 'green'],
    ]);
    const at45 = statusPill(info, [], 'Acme-MacBook', NOW, 45);
    expect(at45.accounts.map((a) => [a.sessionTone, a.weekTone])).toEqual([
      ['amber', 'amber'],
      ['amber', 'green'],
    ]);
    const at90 = statusPill(info, [], 'Acme-MacBook', NOW);
    expect(at90.usage?.tone).toBe('green');
    expect(at90.accounts.every((a) => a.sessionTone === 'green' && a.weekTone === 'green')).toBe(true);
  });
});

describe('fix after 2.0 · usage warnings → toast words and Needs-you alerts', () => {
  it('the toast reads the active account, the window, the percentage and the reset', () => {
    expect(warningAccount(system())).toBe('Claude ‘Work’');
    expect(warningAccount(system({ activeAccounts: [] }))).toBe('Claude');
    const text = usageWarningToastText(warning(), system(), NOW);
    expect(text).toMatch(/^Claude ‘Work’ — 5-hour window at 92% · Resets \d\d:\d\d$/);
    expect(usageWarningToastText(warning({ window: 'model', model: 'Fable', pct: 93.4 }), system(), NOW)).toMatch(/^Claude ‘Work’ — Fable weekly limit at 93% · /);
    expect(resetsText(new Date(NOW + 3 * 86_400_000).toISOString(), NOW)).toMatch(/^Resets [A-Z][a-z]{2} \d\d:\d\d$/);
  });

  it('a warning in force is a dismissible "Usage warning" alert, one per window and reset', () => {
    const alerts = usageWarningAlerts(system(), NOW);
    expect(alerts).toEqual([
      {
        key: `warn:${usageWarningKey(warning())}`,
        title: 'Usage warning',
        text: expect.stringMatching(/^Claude ‘Work’ — 5-hour window at 92% \(warning at 90%\)\. Resets \d\d:\d\d\. Nothing is paused automatically\.$/),
        createdAt: '2026-10-26T11:55:00.000Z',
      },
    ]);
    // Merged with the other usage alerts.
    expect(usageAlerts(system(), NOW, () => 'x').map((a) => a.key)).toContain(alerts[0]?.key);
    expect(usageWarningAlerts(system({ usageWarnings: undefined }), NOW)).toEqual([]);
  });

  it('clears when the window resets or its use drops below the threshold', () => {
    expect(warningsInForce(system(), NOW)).toHaveLength(1);
    // The reset has passed.
    expect(warningsInForce(system(), Date.parse(RESET) + 1)).toEqual([]);
    // The 5-hour window reads 40% now (e.g. after a switch of account): no longer in force.
    expect(warningsInForce(system({}, 40), NOW)).toEqual([]);
    // A window not known now keeps it; a model warning reads its own model's window.
    expect(warningsInForce(system({ usageWindows: [] }), NOW)).toHaveLength(1);
    const model = warning({ window: 'model', model: 'Fable', pct: 93 });
    const withModel = system({ usageWarnings: [model], usageWindows: [{ key: 'model', label: 'Fable', pct: 50, model: 'Fable', resetsAt: RESET }, { key: 'model', label: 'Opus', pct: 99, model: 'Opus', resetsAt: RESET }] });
    expect(warningsInForce(withModel, NOW)).toEqual([]);
  });

  it('the toast dedupe is classic’s: once per window and reset (a later reset is a new one)', () => {
    const shown = new Set([usageWarningKey(warning())]);
    expect(warningsToShow(warningsInForce(system(), NOW), shown, NOW)).toEqual([]);
    const next = warning({ resetsAt: new Date(NOW + 5 * 3_600_000).toISOString() });
    expect(warningsToShow(warningsInForce(system({ usageWarnings: [next] }), NOW), shown, NOW)).toEqual([next]);
  });

  it('the store: the alert shows, OK dismisses it on this browser, and it is gone once the warning is', async () => {
    const storage = new Map<string, string>();
    let now = NOW;
    const make = () => createNeedsYouStore({
      inbox: async () => [],
      team: async () => [],
      notes: async () => [],
      system: async () => system(),
      send: async () => undefined,
      now: () => now,
      storage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => void storage.set(key, value) },
      undoMs: 5_000,
    });
    let store = make();
    await store.reload();
    store.usageChanged(system());
    const alert = store.getSnapshot().items.find((item) => item.source === 'usage') as NeedsItem;
    expect(alert).toMatchObject({ kind: 'alert', title: 'Usage warning', agent: null });
    store.answer(alert, { type: 'dismiss-local' }, 'home');
    expect(store.getSnapshot().items.some((item) => item.source === 'usage')).toBe(false);
    expect(JSON.parse(storage.get(DISMISSED_ALERTS_KEY) ?? '[]')).toEqual([alert.id]);
    store.usageChanged(system());
    expect(store.getSnapshot().items.some((item) => item.source === 'usage')).toBe(false);

    // Not dismissed: it goes by itself when the use drops or the window resets.
    storage.clear();
    store = make();
    store.usageChanged(system());
    expect(store.getSnapshot().items.filter((item) => item.source === 'usage')).toHaveLength(1);
    store.usageChanged(system({}, 30));
    expect(store.getSnapshot().items.filter((item) => item.source === 'usage')).toHaveLength(0);
    store.usageChanged(system());
    now = Date.parse(RESET) + 1;
    store.usageChanged(system());
    expect(store.getSnapshot().items.filter((item) => item.source === 'usage')).toHaveLength(0);
  });
});
