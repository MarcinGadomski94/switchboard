import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AccountUsageRow, SystemInfo, UsageWindow } from '../../src/core/api.ts';
import { UNKNOWN, conflictCount, cpuMeter, formatAge, formatResetsIn, modeLine, processCount, ramMeter, statusColor, urlHost, usageGridLines } from '../../src/web/shell/format.ts';

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const GIB = 1024 ** 3;
const SYSTEM: SystemInfo = {
  cli: 'claude',
  cliVersion: '2.1.283',
  signedIn: true,
  ghSignedIn: true,
  cpu: 38.4,
  ramUsed: 11.2 * GIB,
  ramTotal: 32 * GIB,
  processes: 9,
  usagePct: 62,
  usageResetsAt: '2026-09-28T13:48:00.000Z',
  usageWindows: [
    { key: 'session', label: 'Session', pct: 62, resetsAt: '2026-09-28T13:48:00.000Z' },
    { key: 'week', label: 'Week', pct: 18.4, resetsAt: '2026-10-01T13:00:00.000Z' },
  ],
};

describe('sidebar formatting (src/web/shell/format.ts)', () => {
  it('ages like the prototype', () => {
    expect(formatAge(null, NOW)).toBe('');
    expect(formatAge('2026-09-28T11:59:30.000Z', NOW)).toBe('now');
    expect(formatAge('2026-09-28T11:59:00.000Z', NOW)).toBe('1m');
    expect(formatAge('2026-09-28T11:19:00.000Z', NOW)).toBe('41m');
    expect(formatAge('2026-09-28T09:00:00.000Z', NOW)).toBe('3h');
    expect(formatAge('2026-09-26T12:00:00.000Z', NOW)).toBe('2d');
  });

  it('builds the mode line from the session-start answers', () => {
    expect(modeLine({ mode: 'orchestrator', workType: 'feature', phase: 'ui-first' })).toBe('orch · feature · UI-first');
    expect(modeLine({ mode: 'single', workType: 'qa', phase: 'integration' })).toBe('single · QA · integration');
    expect(modeLine({ mode: null, workType: null, phase: null })).toBe('');
    // D16: a session moved in from a terminal (developer ruling 2026-09-28).
    expect(modeLine({ mode: null, workType: null, phase: null, origin: 'terminal' })).toBe('terminal · moved');
    expect(modeLine({ mode: null, workType: null, phase: null, origin: 'switchboard' })).toBe('');
  });

  it('formats the footer meters and never invents values', () => {
    expect(cpuMeter(SYSTEM)).toEqual({ pct: 38.4, text: '38%' });
    expect(ramMeter(SYSTEM)).toEqual({ pct: 35, text: '11.2/32 GB' });
    expect(cpuMeter(null)).toEqual({ pct: 0, text: UNKNOWN });
    expect(ramMeter(null)).toEqual({ pct: 0, text: UNKNOWN });
    expect(processCount(SYSTEM)).toBe('9 bg processes');
    expect(processCount(null)).toBe('');
    expect(formatResetsIn('2026-09-28T12:48:00.000Z', NOW)).toBe('48m');
  });

  it('D66: a single Claude Code account is one grid line: both windows as bar + %, the resets and the model limits in its tooltip', () => {
    const fable = { key: 'model', label: 'Fable', pct: 104, resetsAt: '2026-09-28T12:45:00.000Z', model: 'Fable' } as const;
    const lines = usageGridLines({ ...SYSTEM, usageWindows: [...(SYSTEM.usageWindows ?? []), fable] }, NOW);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatchObject({ key: 'cli:claude', cli: 'claude', label: 'Claude', active: false, spent: false, outUntil: null });
    expect(line?.session).toMatchObject({ known: true, pct: 62, text: '62%' });
    expect(line?.week).toMatchObject({ known: true, pct: 18.4, text: '18%' });
    // The model limit has no bar of its own: it is a tooltip line.
    expect(line?.title.split('\n').filter((l) => !l.startsWith('  '))).toEqual(['Claude', '5h: 62% · resets in 1h48', 'Week: 18% · resets in 73h00', 'Fable week: 104% · resets in 45m', 'Settings → Accounts']);
    // An old reading (developer ruling 2026-09-28): the last value stays, marked with its age.
    const old = { ...fable, pct: 4, asOf: new Date(NOW - 25 * 60_000).toISOString() };
    expect(usageGridLines({ ...SYSTEM, usageWindows: [...(SYSTEM.usageWindows ?? []), old] }, NOW)[0]?.title).toContain('Fable week: 4% · as of 25m');
  });

  it('D66: a window the server does not list reads "—" (never derived from usagePct); before /api/system answers the Claude line is "—" too', () => {
    const onlyWeek = { ...SYSTEM, usageWindows: SYSTEM.usageWindows?.filter((w) => w.key === 'week') };
    const [line] = usageGridLines(onlyWeek, NOW);
    expect(line?.session).toEqual({ known: false, pct: 0, text: UNKNOWN });
    expect(line?.week).toMatchObject({ known: true, text: '18%' });
    expect(line?.title).toContain('5h: unknown');
    const { usageWindows: _omit, ...none } = SYSTEM;
    expect(usageGridLines(none, NOW).map((l) => [l.label, l.session.text, l.week.text])).toEqual([['Claude', UNKNOWN, UNKNOWN]]);
    expect(usageGridLines(null, NOW).map((l) => [l.label, l.session.text, l.week.text])).toEqual([['Claude', UNKNOWN, UNKNOWN]]);
  });

  it('D66: several Claude Code accounts and Codex: a line each, the active one marked, its bars the meter\'s; Codex by its CLI label', () => {
    const reset = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();
    const accountUsage: AccountUsageRow[] = [
      { profileId: 'default-claude', cli: 'claude', name: 'Work', active: true, pct: 62, exhaustedUntil: null, windows: [{ key: 'session', label: 'Session', pct: 1, resetsAt: reset(60) }] },
      {
        profileId: 'p2',
        cli: 'claude',
        name: 'Private',
        active: false,
        pct: 40,
        exhaustedUntil: null,
        windows: [
          { key: 'session', label: 'Session', pct: 10, resetsAt: reset(120) },
          { key: 'week', label: 'Week', pct: 40, resetsAt: reset(3 * 24 * 60) },
          { key: 'model', label: 'Opus', model: 'Opus', pct: 55, resetsAt: reset(3 * 24 * 60) },
        ],
      },
    ];
    const system: SystemInfo = {
      ...SYSTEM,
      accountUsage,
      cliUsage: [
        { provider: 'codex', label: 'Codex 5h', pct: 35, resetsAt: reset(90), key: 'session' },
        { provider: 'codex', label: 'Codex week', pct: 12, resetsAt: null, key: 'week' },
      ],
    };
    const lines = usageGridLines(system, NOW);
    expect(lines.map((l) => [l.key, l.label, l.active, l.session.text, l.week.text])).toEqual([
      // The active account's bars are the meter's usageWindows (62 / 18), not its row's windows.
      ['default-claude', 'Work', true, '62%', '18%'],
      ['p2', 'Private', false, '10%', '40%'],
      ['cli:codex', 'Codex', false, '35%', '12%'],
    ]);
    expect(lines[0]?.title.split('\n')[0]).toBe('Work · new sessions start here');
    // A Claude Code account's bars have a pace, Codex's none; the model limit is in the tooltip.
    expect(lines[1]?.session.pace).toBeDefined();
    expect(lines[2]?.session.pace).toBeUndefined();
    expect(lines[1]?.title).toContain('Opus week: 55% · resets in 72h00');
    expect(lines[2]?.title).toContain('Week: 12% · reset unknown');
  });

  it('D66: a Codex account of a CLI with several is labeled with its name and listed only with a known window or while spent; OpenCode without usage is left out', () => {
    const system = {
      ...SYSTEM,
      accountUsage: [
        { profileId: 'c1', cli: 'codex', name: 'Work', active: true, pct: 35, exhaustedUntil: null, windows: [{ key: 'session', label: 'Session', pct: 35, resetsAt: null }] },
        { profileId: 'c2', cli: 'codex', name: 'Spare', active: false, pct: null, exhaustedUntil: null, windows: [] },
      ],
      cliUsage: [{ provider: 'codex', label: 'Codex 5h', pct: 99, resetsAt: null, key: 'session' }],
    } as SystemInfo;
    expect(usageGridLines(system, NOW).map((l) => [l.label, l.active, l.session.text, l.week.text])).toEqual([
      ['Claude', false, '62%', '18%'],
      ['Codex Work', true, '35%', UNKNOWN],
    ]);
  });

  it('D66: a spent account says "out until HH:MM" in place of its bars; a mark whose time has passed does not', () => {
    const until = new Date(NOW + 30 * 60_000);
    const rows: AccountUsageRow[] = [
      { profileId: 'a', cli: 'claude', name: 'Work', active: false, pct: 100, exhaustedUntil: until.toISOString(), windows: [{ key: 'session', label: 'Session', pct: 100, resetsAt: until.toISOString() }] },
      { profileId: 'b', cli: 'claude', name: 'Private', active: true, pct: 10, exhaustedUntil: new Date(NOW - 60_000).toISOString() },
    ];
    const lines = usageGridLines({ ...SYSTEM, accountUsage: rows }, NOW);
    const hhmm = `${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`;
    expect(lines.map((l) => [l.label, l.spent, l.outUntil])).toEqual([
      ['Work', true, `out until ${hhmm}`],
      ['Private', false, null],
    ]);
    expect(lines[0]?.title).toContain(`Out of usage until ${hhmm}`);
  });

  it('maps statuses, hosts and conflicts', () => {
    expect(statusColor('need')).toBe('var(--status-need)');
    expect(statusColor('paused')).toBe('var(--status-idle)');
    expect(urlHost('http://localhost:13000')).toBe('localhost:13000');
    expect(urlHost(null)).toBe('');
    expect(conflictCount(null)).toBe(0);
  });
});

/** The component module, imported at run time (the server tsconfig has no JSX; Vitest transforms it). */
const SIDEBAR = '../../src/web/shell/Sidebar.tsx';

describe('D23, continuous (ruling 2026-09-29): the Week row shows its pace by the minute (src/web/shell/format.ts → usageGridLines, Sidebar UsageCellView)', () => {
  // Local times (the tooltip reads the local time), in a July week: no daylight-saving change anywhere.
  // A Thursday 15:00 reset: the window runs Thu 9 July 15:00 → Thu 16 July 15:00; Mon 14:59 is its 5 760th minute (57.14 %).
  const RESET = new Date(2026, 6, 16, 15, 0).toISOString();
  const MON_1459 = new Date(2026, 6, 13, 14, 59).getTime();
  const MON_1500 = new Date(2026, 6, 13, 15, 0).getTime();
  const system = (week: Partial<UsageWindow> | null, extra: UsageWindow[] = []): SystemInfo => ({
    ...SYSTEM,
    usageWindows: [
      { key: 'session', label: 'Session', pct: 62, resetsAt: new Date(2026, 6, 13, 16, 48).toISOString() },
      ...(week ? [{ key: 'week' as const, label: 'Week', pct: 33, resetsAt: RESET, ...week }] : []),
      ...extra,
    ],
  });
  const weekRow = (info: SystemInfo | null, now: number) => usageGridLines(info, now)[0]?.week;

  it('below the allowance: on pace (green), the marker at the allowance, the tooltip with the next step in local time', () => {
    expect(weekRow(system({ pct: 33 }), MON_1459)).toEqual({
      known: true,
      pct: 33,
      text: '33%',
      pace: { state: 'on', markerPct: 57.14, title: 'On pace: 33% of 57.14% until 15:00' },
    });
  });

  it('at or above the allowance: ahead of pace (yellow); each minute moves the allowance and the marker a little (no jump at the reset hour)', () => {
    expect(weekRow(system({ pct: 62 }), MON_1459)?.pace).toEqual({ state: 'ahead', markerPct: 57.14, title: 'Ahead of pace: 62% of 57.14% until 15:00' });
    expect(weekRow(system({ pct: 57.14 }), MON_1459)?.pace).toMatchObject({ state: 'ahead', title: 'Ahead of pace: 57.14% of 57.14% until 15:00' });
    expect(weekRow(system({ pct: 57.14 }), MON_1500)?.pace).toEqual({ state: 'on', markerPct: 57.15, title: 'On pace: 57.14% of 57.15% until 15:01' });
    expect(weekRow(system({ pct: 62 }), MON_1500)?.pace).toEqual({ state: 'ahead', markerPct: 57.15, title: 'Ahead of pace: 62% of 57.15% until 15:01' });
    // Day 7, Wed 18:30 (the 8 851st minute): 87.81 % allowed until 18:31.
    const wed = new Date(2026, 6, 15, 18, 30).getTime();
    expect(weekRow(system({ pct: 100 }), wed)?.pace).toEqual({ state: 'ahead', markerPct: 87.81, title: 'Ahead of pace: 100% of 87.81% until 18:31' });
    expect(weekRow(system({ pct: 18.4 }), wed)?.pace?.title).toBe('On pace: 18.4% of 87.81% until 18:31');
    // The last minute allows the whole week until the reset.
    expect(weekRow(system({ pct: 99 }), new Date(2026, 6, 16, 14, 59, 30).getTime())?.pace).toEqual({ state: 'on', markerPct: 100, title: 'On pace: 99% of 100% until 15:00' });
  });

  it('the Week pace is the Week bar\'s own: a model limit has no bar (D66: a tooltip line, no pace); the Session bar has its own (D46)', () => {
    const fable: UsageWindow = { key: 'model', label: 'Fable', model: 'Fable', pct: 93, resetsAt: RESET };
    const [line] = usageGridLines(system({ pct: 62 }, [fable]), MON_1459);
    // The Session (62 %, reset at 16:48, 1h49 ahead: in its 192nd minute, 64 % allowed) is on pace by its own rule.
    expect([line?.session, line?.week].map((cell) => [cell?.pace?.state ?? null, cell?.pace?.markerPct ?? null])).toEqual([
      ['on', 64],
      ['ahead', 57.14],
    ]);
    // The tooltip has each pace under its window; the model line has none.
    expect(line?.title.split('\n')).toEqual([
      'Claude',
      '5h: 62% · resets in 1h49',
      '  On pace: 62% of 64% until 15:00',
      'Week: 62% · resets in 72h01',
      '  Ahead of pace: 62% of 57.14% until 15:00',
      'Fable week: 93% · resets in 72h01',
      'Settings → Accounts',
    ]);
  });

  it('unknown stays unknown: no pace without a Week window, before /api/system answers, or once its reset has passed', () => {
    expect(weekRow(system(null), MON_1459)).toEqual({ known: false, pct: 0, text: UNKNOWN });
    expect(weekRow(null, MON_1459)).toEqual({ known: false, pct: 0, text: UNKNOWN });
    expect(weekRow(system({ pct: 33 }), Date.parse(RESET) + 60_000)?.pace).toBeUndefined();
  });

  it('UsageCellView: data-pace (the bar color in shell.css) and a marker at the allowance; without a pace no color, no marker', async () => {
    const { UsageCellView } = (await import(/* @vite-ignore */ SIDEBAR)) as { UsageCellView: (props: object) => unknown };
    const html = renderToStaticMarkup(createElement(UsageCellView as never, { name: 'week', cell: weekRow(system({ pct: 33 }), MON_1459) }));
    expect(html).toBe(
      '<span class="sb-usage-cell" data-window="week" data-known="true" data-pace="on">' +
        '<span class="sb-meter-track"><span class="sb-meter-fill" style="width:33%"></span>' +
        '<span class="sb-meter-marker" data-testid="pace-marker" style="left:calc(57.14% - 1px)"></span></span>' +
        '<span class="sb-usage-pct">33%</span></span>',
    );
    expect(renderToStaticMarkup(createElement(UsageCellView as never, { name: 'week', cell: weekRow(system({ pct: 62 }), MON_1459) }))).toContain('data-pace="ahead"');
    expect(renderToStaticMarkup(createElement(UsageCellView as never, { name: 'week', cell: weekRow(system(null), MON_1459) }))).toBe(
      '<span class="sb-usage-cell" data-window="week" data-known="false"><span class="sb-meter-track"><span class="sb-meter-fill" style="width:0%"></span></span><span class="sb-usage-pct">—</span></span>',
    );
  });
});

describe('D46: the Session row shows its pace by the minute (src/web/shell/format.ts → usageGridLines, Sidebar UsageCellView)', () => {
  // Local times (the tooltip reads the local time), on a July day: no daylight-saving change anywhere.
  // A 16:35 reset: the window runs 11:35 → 16:35, so 14:04 is in its 150th minute (50 % allowed) until the step at 14:05.
  const RESET = new Date(2026, 6, 13, 16, 35).toISOString();
  const at = (hours: number, minutes: number, seconds = 0): number => new Date(2026, 6, 13, hours, minutes, seconds).getTime();
  const system = (session: Partial<UsageWindow> | null, extra: UsageWindow[] = []): SystemInfo => ({
    ...SYSTEM,
    usageWindows: [...(session ? [{ key: 'session' as const, label: 'Session', pct: 38, resetsAt: RESET, ...session }] : []), ...extra],
  });
  const sessionRow = (info: SystemInfo | null, now: number) => usageGridLines(info, now)[0]?.session;

  it('below the allowance: on pace (green), the marker at the allowance, the tooltip with the next minute in local time', () => {
    expect(sessionRow(system({ pct: 38 }), at(14, 4, 30))).toEqual({
      known: true,
      pct: 38,
      text: '38%',
      pace: { state: 'on', markerPct: 50, title: 'On pace: 38% of 50% until 14:05' },
    });
  });

  it('at or above the allowance: ahead of pace (yellow); the step a minute later moves the allowance and the marker', () => {
    expect(sessionRow(system({ pct: 62 }), at(14, 4))?.pace).toEqual({ state: 'ahead', markerPct: 50, title: 'Ahead of pace: 62% of 50% until 14:05' });
    expect(sessionRow(system({ pct: 50 }), at(14, 4, 59))?.pace).toEqual({ state: 'ahead', markerPct: 50, title: 'Ahead of pace: 50% of 50% until 14:05' });
    expect(sessionRow(system({ pct: 50.2 }), at(14, 4, 59))?.pace?.state).toBe('ahead');
    expect(sessionRow(system({ pct: 50.2 }), at(14, 5))?.pace).toEqual({ state: 'on', markerPct: 50.33, title: 'On pace: 50.2% of 50.33% until 14:06' });
  });

  it('from the window\'s first minute (0.33 % allowed from its start, ruling 2026-09-29) to its last (100 % until the reset)', () => {
    expect(sessionRow(system({ pct: 0.2 }), at(11, 35))?.pace).toEqual({ state: 'on', markerPct: 0.33, title: 'On pace: 0.2% of 0.33% until 11:36' });
    expect(sessionRow(system({ pct: 3 }), at(11, 35))?.pace).toEqual({ state: 'ahead', markerPct: 0.33, title: 'Ahead of pace: 3% of 0.33% until 11:36' });
    expect(sessionRow(system({ pct: 3 }), at(11, 36))?.pace).toEqual({ state: 'ahead', markerPct: 0.67, title: 'Ahead of pace: 3% of 0.67% until 11:37' });
    expect(sessionRow(system({ pct: 92.5 }), at(16, 34, 59))?.pace).toEqual({ state: 'on', markerPct: 100, title: 'On pace: 92.5% of 100% until 16:35' });
  });

  it('unknown stays unknown: no Session window, before /api/system answers, a reset past or more than 5 h ahead → no pace', () => {
    expect(sessionRow(system(null), at(14, 4))).toEqual({ known: false, pct: 0, text: UNKNOWN });
    expect(sessionRow(null, at(14, 4))).toEqual({ known: false, pct: 0, text: UNKNOWN });
    expect(sessionRow(system({ pct: 38 }), at(16, 35))).toEqual({ known: true, pct: 38, text: '38%' });
    expect(sessionRow(system({ pct: 38 }), at(11, 34, 59))).toEqual({ known: true, pct: 38, text: '38%' });
    expect(sessionRow(system({ pct: 38 }), at(11, 0))?.pace).toBeUndefined();
  });

  it('the Week keeps its own pace next to it (by the minute over the week); a model limit gets none', () => {
    const week: UsageWindow = { key: 'week', label: 'Week', pct: 18, resetsAt: new Date(2026, 6, 16, 15, 0).toISOString() };
    const fable: UsageWindow = { key: 'model', label: 'Fable', model: 'Fable', pct: 93, resetsAt: RESET };
    const [line] = usageGridLines(system({ pct: 62 }, [week, fable]), at(14, 4));
    expect([line?.session.pace?.title, line?.week.pace?.title]).toEqual(['Ahead of pace: 62% of 50% until 14:05', 'On pace: 18% of 56.6% until 14:05']);
    expect(line?.title).toContain('Fable week: 93% · resets in 2h31\nSettings → Accounts');
  });

  it('UsageCellView: the Session bar with data-pace and the marker; without a pace no color, no marker', async () => {
    const { UsageCellView } = (await import(/* @vite-ignore */ SIDEBAR)) as { UsageCellView: (props: object) => unknown };
    expect(renderToStaticMarkup(createElement(UsageCellView as never, { name: 'session', cell: sessionRow(system({ pct: 38 }), at(14, 4)) }))).toBe(
      '<span class="sb-usage-cell" data-window="session" data-known="true" data-pace="on">' +
        '<span class="sb-meter-track"><span class="sb-meter-fill" style="width:38%"></span>' +
        '<span class="sb-meter-marker" data-testid="pace-marker" style="left:calc(50% - 1px)"></span></span>' +
        '<span class="sb-usage-pct">38%</span></span>',
    );
    expect(renderToStaticMarkup(createElement(UsageCellView as never, { name: 'session', cell: sessionRow(system({ pct: 62 }), at(14, 4)) }))).toContain('data-pace="ahead"');
    expect(renderToStaticMarkup(createElement(UsageCellView as never, { name: 'session', cell: sessionRow(system({ pct: 38 }), at(16, 40)) }))).toBe(
      '<span class="sb-usage-cell" data-window="session" data-known="true"><span class="sb-meter-track"><span class="sb-meter-fill" style="width:38%"></span></span><span class="sb-usage-pct">38%</span></span>',
    );
  });
});
