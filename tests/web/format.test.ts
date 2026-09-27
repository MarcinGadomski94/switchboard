import { describe, expect, it } from 'vitest';
import type { SystemInfo } from '../../src/core/api.ts';
import { UNKNOWN, conflictCount, cpuMeter, formatAge, formatResetsIn, maxMeter, modeLine, processCount, ramMeter, statusColor, urlHost } from '../../src/web/shell/format.ts';

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
    expect(maxMeter(SYSTEM, NOW)).toEqual({ pct: 62, text: '62% · 1h48' });
    expect(maxMeter({ ...SYSTEM, usageResetsAt: undefined }, NOW)).toEqual({ pct: 62, text: '62%' });
    const { usagePct: _omit, ...unknownUsage } = SYSTEM;
    expect(maxMeter(unknownUsage, NOW)).toEqual({ pct: 0, text: 'unknown' });
    expect(cpuMeter(null)).toEqual({ pct: 0, text: UNKNOWN });
    expect(ramMeter(null)).toEqual({ pct: 0, text: UNKNOWN });
    expect(maxMeter(null, NOW)).toEqual({ pct: 0, text: UNKNOWN });
    expect(processCount(SYSTEM)).toBe('9 bg processes');
    expect(processCount(null)).toBe('');
    expect(formatResetsIn('2026-09-28T12:48:00.000Z', NOW)).toBe('48m');
  });

  it('maps statuses, hosts and conflicts', () => {
    expect(statusColor('need')).toBe('var(--status-need)');
    expect(statusColor('paused')).toBe('var(--status-idle)');
    expect(urlHost('http://localhost:13000')).toBe('localhost:13000');
    expect(urlHost(null)).toBe('');
    expect(conflictCount(null)).toBe(0);
  });
});
