import type os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { SystemInfo } from '../../../src/core/api.ts';
import type { PowerStatus } from '../../../src/core/power.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { RunResult } from '../../../src/server/exec.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { IOREG_PATH, PMSET_PATH, POWER_COMMAND_TIMEOUT_MS, PowerSampler, type PowerRunner } from '../../../src/server/system/power.ts';
import { SystemProbe } from '../../../src/server/system/probe.ts';
import { generateToken } from '../../../src/server/token.ts';
import { fakeClaudeCommand } from '../../../tools/fake-claude/command.ts';
import { fakeGhCommand } from '../../../tools/fake-gh/command.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D125 (`docs/power.md`): the power sampler with a mocked command runner (no
 * real pmset / ioreg / nvidia-smi / PowerShell): what each OS reports, no
 * overlapping samples, the time limit, a missing source cached (not asked every
 * sample), and `GET /api/system` carrying `power`.
 */

const ok = (stdout: string): RunResult => ({ code: 0, signal: null, stdout, stderr: '', error: null, timedOut: false });
const missing = (): RunResult => ({ code: null, signal: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' }), timedOut: false });

const PMSET = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234567)\t64%; discharging; 2:10 remaining present: true\n";
const IOREG = '  |   "Amperage" = 18446744073709550616\n  |   "Voltage" = 12000\n  |   "IsCharging" = No\n';

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

function runner(answers: (command: string, args: readonly string[]) => RunResult | Promise<RunResult>): { run: PowerRunner; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    run: async (command, args, timeoutMs) => {
      calls.push({ command, args, timeoutMs });
      return answers(command, args);
    },
  };
}

function cpus(user: number, idle: number, count = 8): () => readonly os.CpuInfo[] {
  return () => Array.from({ length: count }, () => ({ model: 'test', speed: 1, times: { user, nice: 0, sys: 0, idle, irq: 0 } }));
}

describe('PowerSampler (D125)', () => {
  it('macOS laptop: pmset + ioreg (absolute paths, the time limit) → battery with the OS estimate and the draw', async () => {
    const { run, calls } = runner((command) => ok(command === PMSET_PATH ? PMSET : IOREG));
    const changes: PowerStatus[] = [];
    const sampler = new PowerSampler({ platform: 'darwin', arch: 'arm64', run, now: () => Date.parse('2026-10-21T10:00:00Z'), onChange: (p) => changes.push(p) });
    expect(sampler.current()).toBeNull();
    await sampler.refresh();
    expect(sampler.last).toEqual({ kind: 'battery', percent: 64, charging: false, pluggedIn: false, minutesLeft: 130, watts: 12, at: '2026-10-21T10:00:00.000Z' });
    expect(calls).toEqual([
      { command: PMSET_PATH, args: ['-g', 'batt'], timeoutMs: POWER_COMMAND_TIMEOUT_MS },
      { command: IOREG_PATH, args: ['-rn', 'AppleSmartBattery'], timeoutMs: POWER_COMMAND_TIMEOUT_MS },
    ]);
    expect(changes).toHaveLength(1);
  });

  it('never overlaps: callers share the running sample; current() starts one only when the last is due', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let running = 0;
    let most = 0;
    const { run, calls } = runner(async (command) => {
      running += 1;
      most = Math.max(most, running);
      await gate;
      running -= 1;
      return ok(command === PMSET_PATH ? PMSET : IOREG);
    });
    let now = 0;
    const sampler = new PowerSampler({ platform: 'darwin', run, now: () => now, intervalMs: 30_000 });
    const first = sampler.refresh();
    expect(sampler.refresh()).toBe(first);
    sampler.current();
    sampler.current();
    release();
    await first;
    expect(most).toBe(1);
    expect(calls.map((call) => call.command)).toEqual([PMSET_PATH, IOREG_PATH]);
    expect(sampler.samples).toBe(1);
    // Not due yet: the last reading, nothing runs.
    now = 10_000;
    expect(sampler.current()?.percent).toBe(64);
    await Promise.resolve();
    expect(calls).toHaveLength(2);
    // Due: a new sample starts in the background.
    now = 30_000;
    sampler.current();
    await sampler.refresh();
    expect(sampler.samples).toBe(2);
    expect(calls).toHaveLength(4);
  });

  it('Windows desktop: one PowerShell call finds no battery, nvidia-smi sums two GPUs; the CPU from utilisation, settings applied', async () => {
    const { run, calls } = runner((command) => {
      if (command.toLowerCase().endsWith('powershell.exe')) return ok('{"battery":[],"status":[],"full":[]}');
      if (command === 'nvidia-smi') return ok('100.4\n20.2\n');
      throw new Error(`unexpected ${command}`);
    });
    let user = 0;
    let idle = 0;
    const sampler = new PowerSampler({
      platform: 'win32',
      arch: 'x64',
      run,
      cpus: () => cpus(user, idle, 16)(),
      estimateSettings: async () => ({ cpuIdleW: null, cpuMaxW: null, baseW: 30 }),
      now: () => 0,
    });
    // 25% busy since construction.
    user = 250;
    idle = 750;
    await sampler.refresh();
    // 16 cores: idle 12, max 125 → 12 + 0.25 × 113 = 40.25 → 40; GPU 120.6 → 121; base 30 (the setting).
    expect(sampler.last).toEqual({ kind: 'estimated', watts: 191, parts: { gpu: 121, gpuCount: 2, cpu: 40, cpuPct: 25, base: 30 }, at: '1970-01-01T00:00:00.000Z' });
    const shell = calls.find((call) => call.command.toLowerCase().endsWith('powershell.exe'));
    expect(shell?.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(shell?.args[3]).toContain('ConvertTo-Json');
  });

  it('caches what is not there: no battery and no nvidia-smi are asked again only after the retry time', async () => {
    let now = 0;
    const { run, calls } = runner((command) => (command === PMSET_PATH ? ok("Now drawing from 'AC Power'\n") : missing()));
    const sampler = new PowerSampler({ platform: 'darwin', arch: 'x64', run, now: () => now, retryMs: 3_600_000, cpus: cpus(0, 0) });
    await sampler.refresh();
    expect(sampler.last?.kind).toBe('estimated');
    expect(sampler.last?.parts?.gpu).toBeUndefined();
    expect(calls.map((call) => call.command)).toEqual([PMSET_PATH]);
    now = 60_000;
    await sampler.refresh();
    expect(calls).toHaveLength(1);
    now = 3_600_000;
    await sampler.refresh();
    expect(calls.map((call) => call.command)).toEqual([PMSET_PATH, PMSET_PATH]);

    // Linux: nvidia-smi missing → asked once in the hour.
    const linux = runner(() => missing());
    let t = 0;
    const onLinux = new PowerSampler({ platform: 'linux', run: linux.run, now: () => t, listDir: async () => [], readText: async () => Promise.reject(new Error('ENOENT')), cpus: cpus(0, 0) });
    await onLinux.refresh();
    t = 30_000;
    await onLinux.refresh();
    expect(linux.calls.map((call) => call.command)).toEqual(['nvidia-smi']);
    expect(onLinux.last?.kind).toBe('estimated');
  });

  it('a timed-out (failed) battery read keeps the last reading and does not throw', async () => {
    let fail = false;
    const { run } = runner((command) => (fail ? { ...missing(), error: new Error('timed out after 5000 ms'), timedOut: true } : ok(command === PMSET_PATH ? PMSET : IOREG)));
    const errors: unknown[] = [];
    let now = 0;
    const sampler = new PowerSampler({ platform: 'darwin', run, now: () => now, onError: (error) => errors.push(error) });
    await sampler.refresh();
    fail = true;
    now = 60_000;
    await sampler.refresh();
    expect(sampler.last?.percent).toBe(64);
    expect(errors).toHaveLength(1);
  });

  it('Linux: a RAPL counter replaces the CPU estimate from the second sample on; amdgpu hwmon is measured', async () => {
    const files: Record<string, string> = {
      '/sys/class/powercap/intel-rapl:0/energy_uj': '1000000',
      '/sys/class/powercap/intel-rapl:0/max_energy_range_uj': '262143328850',
      '/sys/class/drm/card0/device/hwmon/hwmon3/name': 'amdgpu',
      '/sys/class/drm/card0/device/hwmon/hwmon3/power1_average': '45000000',
    };
    const dirs: Record<string, string[]> = {
      '/sys/class/power_supply': ['AC'],
      '/sys/class/powercap': ['intel-rapl:0', 'intel-rapl:0:0'],
      '/sys/class/drm': ['card0', 'card0-DP-1', 'renderD128'],
      '/sys/class/drm/card0/device/hwmon': ['hwmon3'],
    };
    files['/sys/class/power_supply/AC/type'] = 'Mains';
    let now = 0;
    const { run } = runner(() => missing());
    const sampler = new PowerSampler({
      platform: 'linux',
      arch: 'x64',
      run,
      now: () => now,
      cpus: cpus(0, 0, 8),
      readText: async (file) => (file in files ? files[file]! : Promise.reject(new Error(`ENOENT ${file}`))),
      listDir: async (dir) => (dir in dirs ? dirs[dir]! : Promise.reject(new Error(`ENOENT ${dir}`))),
    });
    await sampler.refresh();
    expect(sampler.last?.parts).toEqual({ gpu: 45, gpuCount: 1, cpu: 8, cpuPct: 0, base: 40 });
    files['/sys/class/powercap/intel-rapl:0/energy_uj'] = String(1_000_000 + 30 * 25_000_000);
    now = 30_000;
    await sampler.refresh();
    expect(sampler.last?.parts).toEqual({ gpu: 45, gpuCount: 1, cpu: 25, cpuPct: 0, cpuMeasured: true, base: 40 });
    expect(sampler.last?.watts).toBe(110);
  });
});

let app: FastifyInstance | undefined;
let store: Store | undefined;
let tmp: string | undefined;

afterEach(async () => {
  await app?.close();
  await store?.close();
  if (tmp) await removeTempDir(tmp);
  app = undefined;
  store = undefined;
  tmp = undefined;
});

describe('GET /api/system carries power (D125)', () => {
  it('the probe answers the sampler\'s last reading (and starts the first sample)', async () => {
    tmp = await makeTempDir('system-power');
    store = await openTempStore(path.join(tmp, 'data'));
    const { run } = runner((command) => ok(command === PMSET_PATH ? PMSET : IOREG));
    const sampler = new PowerSampler({ platform: 'darwin', run });
    const probe = new SystemProbe({ claudeCommand: fakeClaudeCommand(), ghCommand: fakeGhCommand(), cwd: tmp, processCount: () => 0, power: sampler });
    const token = generateToken();
    const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: path.join(tmp, 'data') }, platform: 'linux', home: tmp, cwd: tmp });
    app = await buildApp({ config: { ...base, port: 4871 }, token, store, webRoot: tmp, providers: { system: probe } });
    await app.ready();
    const get = async (): Promise<SystemInfo> =>
      (await app!.inject({ method: 'GET', url: '/api/system', headers: { host: '127.0.0.1:4871', cookie: `sb_token=${token}` } })).json() as SystemInfo;
    // Before the first sample: no field (never invented).
    expect((await get()).power).toBeUndefined();
    await sampler.refresh();
    expect((await get()).power).toMatchObject({ kind: 'battery', percent: 64, charging: false, minutesLeft: 130, watts: 12 });
  });
});
