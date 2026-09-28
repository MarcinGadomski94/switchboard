import { describe, expect, it } from 'vitest';
import type { SystemInfo } from '../../src/core/api.ts';
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
    expect(usageRows(SYSTEM, NOW)).toEqual([
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
