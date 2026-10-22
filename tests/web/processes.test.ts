import { describe, expect, it } from 'vitest';
import type { SessionProcess } from '../../src/core/api.ts';
import { ageLabel, footerLine, kindTag, processTitle, stopLine } from '../../src/web/processes/processes.ts';

/** D127 (`docs/processes.md`): the Processes views' pure parts (footer line, ages, the stop line). */

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const GB = 1024 ** 3;

function proc(patch: Partial<SessionProcess> = {}): SessionProcess {
  return { pid: 42, ppid: 1, name: 'MSBuild node', kind: 'build-server', rssBytes: GB / 4, startedAt: new Date(NOW - 27 * 60_000).toISOString(), cpuPct: 0, command: 'dotnet ~/sdk/MSBuild.dll /nodemode:1', keep: false, keptBy: null, keepReason: null, ...patch };
}

describe('D127 · Processes views', () => {
  it('the footer line: the total memory, nothing without processes', () => {
    expect(footerLine({ count: 12, rssBytes: 4.5 * GB })).toEqual({ text: 'procs 4.5 GB', title: '12 processes left running by sessions (4.5 GB). Open Settings → Processes.' });
    expect(footerLine({ count: 0, rssBytes: 0 })).toBeNull();
    expect(footerLine(undefined)).toBeNull();
  });

  it('ages and kind tags', () => {
    expect(ageLabel(new Date(NOW - 20_000).toISOString(), NOW)).toBe('<1m');
    expect(ageLabel(new Date(NOW - 27 * 60_000).toISOString(), NOW)).toBe('27m');
    expect(ageLabel(new Date(NOW - 185 * 60_000).toISOString(), NOW)).toBe('3h05');
    expect(ageLabel(new Date(NOW - 52 * 3_600_000).toISOString(), NOW)).toBe('2d4h');
    expect(['build-server', 'test-host', 'dev-server', 'other'].map((kind) => kindTag(kind as SessionProcess['kind']))).toEqual(['build', 'test', 'dev', 'other']);
  });

  it('the stop line under a session', () => {
    const view = { working: false, closed: false, stopsAt: new Date(NOW + 4 * 60_000).toISOString(), processes: [proc()] };
    expect(stopLine(view, 10, NOW)).toBe('Stops in 4 min if it stays idle (after 10 min idle).');
    expect(stopLine({ ...view, working: true, stopsAt: null }, 10, NOW)).toBe('Working now: nothing is stopped while it works.');
    expect(stopLine({ ...view, processes: [proc({ keep: true })] }, 10, NOW)).toBe('All kept: never stopped automatically.');
    expect(stopLine({ ...view, stopsAt: null }, 0, NOW)).toBe('Idle stop is off: stopped when the session is closed.');
    expect(stopLine({ ...view, processes: [] }, 10, NOW)).toBe('Nothing left running.');
  });

  it("a kept process's tooltip says who kept it and why", () => {
    expect(processTitle(proc({ keep: true, keptBy: 'agent', keepReason: 'dev server for the review' }))).toBe('build server · pid 42\ndotnet ~/sdk/MSBuild.dll /nodemode:1\nKept by the agent: dev server for the review');
  });
});
