import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SystemInfo, UsageWindow } from '../../src/core/api.ts';
import { UNKNOWN, conflictCount, cpuMeter, formatAge, formatResetsIn, modeLine, processCount, ramMeter, statusColor, urlHost, usageRows } from '../../src/web/shell/format.ts';

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

  it('D17: Session and Week rows (bar = %, % · time to reset); a model row only when the server lists one', () => {
    // The Week row's D23 pace is checked in its own describe below.
    expect(usageRows(SYSTEM, NOW).map(({ pace: _pace, ...row }) => row)).toEqual([
      { key: 'session', label: 'Session', pct: 62, text: '62% · 1h48' },
      { key: 'week', label: 'Week', pct: 18.4, text: '18% · 73h00' },
    ]);
    const fable = { key: 'model', label: 'Fable', pct: 104, resetsAt: '2026-09-28T12:45:00.000Z', model: 'Fable' } as const;
    expect(usageRows({ ...SYSTEM, usageWindows: [...(SYSTEM.usageWindows ?? []), fable] }, NOW)[2]).toEqual({
      key: 'model',
      label: 'Fable',
      model: 'Fable',
      pct: 100,
      text: '104% · 45m',
    });
    // An old reading (developer ruling 2026-09-28): the last value stays, marked with its age.
    const old = { ...fable, pct: 4, asOf: new Date(NOW - 25 * 60_000).toISOString() };
    expect(usageRows({ ...SYSTEM, usageWindows: [...(SYSTEM.usageWindows ?? []), old] }, NOW)[2]).toMatchObject({ label: 'Fable', pct: 4, text: '4% · as of 25m' });
  });

  it('D17: a window the server does not list reads "unknown", never derived from usagePct; "—" before /api/system answers', () => {
    const onlyWeek = { ...SYSTEM, usageWindows: SYSTEM.usageWindows?.filter((w) => w.key === 'week') };
    expect(usageRows(onlyWeek, NOW).map((row) => [row.label, row.text])).toEqual([
      ['Session', 'unknown'],
      ['Week', '18% · 73h00'],
    ]);
    const { usageWindows: _omit, ...none } = SYSTEM;
    expect(usageRows(none, NOW)).toEqual([
      { key: 'session', label: 'Session', pct: 0, text: 'unknown' },
      { key: 'week', label: 'Week', pct: 0, text: 'unknown' },
    ]);
    expect(usageRows(null, NOW).map((row) => row.text)).toEqual([UNKNOWN, UNKNOWN]);
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

describe('D23: the Week row shows its pace (src/web/shell/format.ts → usageRows, Sidebar MeterRow)', () => {
  // Local times (the tooltip reads the local weekday and time), in a July week: no daylight-saving change anywhere.
  // A Thursday 15:00 reset: day 4 runs Mon 13 July 15:00 − 24 h … Mon 15:00, day 5 from Mon 15:00.
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
  const weekRow = (info: SystemInfo | null, now: number) => usageRows(info, now).find((row) => row.key === 'week');

  it('below the allowance: on pace (green), the marker at the allowance, the tooltip with the next step in local time', () => {
    expect(weekRow(system({ pct: 33 }), MON_1459)).toEqual({
      key: 'week',
      label: 'Week',
      pct: 33,
      text: '33% · 72h01',
      pace: { state: 'on', markerPct: 57.14, title: 'On pace: 33% of 57.14% allowed until Mon 15:00' },
    });
  });

  it('at or above the allowance: ahead of pace (yellow); the step at the reset hour moves the allowance and the marker', () => {
    expect(weekRow(system({ pct: 62 }), MON_1459)?.pace).toEqual({ state: 'ahead', markerPct: 57.14, title: 'Ahead of pace: 62% of 57.14% allowed until Mon 15:00' });
    expect(weekRow(system({ pct: 57.14 }), MON_1459)?.pace).toMatchObject({ state: 'ahead', title: 'Ahead of pace: 57.14% of 57.14% allowed until Mon 15:00' });
    expect(weekRow(system({ pct: 62 }), MON_1500)?.pace).toEqual({ state: 'on', markerPct: 71.43, title: 'On pace: 62% of 71.43% allowed until Tue 15:00' });
    // Day 7: the whole week is allowed until the reset.
    const wed = new Date(2026, 6, 15, 18, 30).getTime();
    expect(weekRow(system({ pct: 100 }), wed)?.pace).toEqual({ state: 'ahead', markerPct: 100, title: 'Ahead of pace: 100% of 100% allowed until Thu 15:00' });
    expect(weekRow(system({ pct: 18.4 }), wed)?.pace?.title).toBe('On pace: 18.4% of 100% allowed until Thu 15:00');
  });

  it('only the Week row: Session and model rows keep no pace, whatever their numbers', () => {
    const fable: UsageWindow = { key: 'model', label: 'Fable', model: 'Fable', pct: 93, resetsAt: RESET };
    const rows = usageRows(system({ pct: 62 }, [fable]), MON_1459);
    expect(rows.map((row) => [row.key, row.pace?.state ?? null])).toEqual([
      ['session', null],
      ['week', 'ahead'],
      ['model', null],
    ]);
  });

  it('unknown stays unknown: no pace without a Week window, before /api/system answers, or once its reset has passed', () => {
    expect(weekRow(system(null), MON_1459)).toEqual({ key: 'week', label: 'Week', pct: 0, text: 'unknown' });
    expect(weekRow(null, MON_1459)).toEqual({ key: 'week', label: 'Week', pct: 0, text: UNKNOWN });
    expect(weekRow(system({ pct: 33 }), Date.parse(RESET) + 60_000)?.pace).toBeUndefined();
  });

  it('MeterRow: data-pace (the bar color in shell.css), the title and a marker at the allowance; without a pace the D17 markup', async () => {
    const { MeterRow } = (await import(/* @vite-ignore */ SIDEBAR)) as { MeterRow: (props: object) => unknown };
    const known = weekRow(system({ pct: 33 }), MON_1459);
    const html = renderToStaticMarkup(createElement(MeterRow as never, { label: 'Week', name: 'week', meter: known, pace: known?.pace }));
    expect(html).toBe(
      '<div class="sb-meter" data-meter="week" data-pace="on" title="On pace: 33% of 57.14% allowed until Mon 15:00"><span>Week</span>' +
        '<div class="sb-meter-track"><div class="sb-meter-fill" style="width:33%"></div>' +
        '<div class="sb-meter-marker" data-testid="pace-marker" style="left:calc(57.14% - 1px)"></div></div>' +
        '<span class="sb-meter-value">33% · 72h01</span></div>',
    );
    const ahead = weekRow(system({ pct: 62 }), MON_1459);
    expect(renderToStaticMarkup(createElement(MeterRow as never, { label: 'Week', name: 'week', meter: ahead, pace: ahead?.pace }))).toContain('data-pace="ahead"');
    const unknown = weekRow(system(null), MON_1459);
    expect(renderToStaticMarkup(createElement(MeterRow as never, { label: 'Week', name: 'week', meter: unknown }))).toBe(
      '<div class="sb-meter" data-meter="week"><span>Week</span><div class="sb-meter-track"><div class="sb-meter-fill" style="width:0%"></div></div><span class="sb-meter-value">unknown</span></div>',
    );
  });
});
