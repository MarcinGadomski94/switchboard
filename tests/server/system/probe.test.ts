import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import type os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SystemProbe, parseCliVersion, resolveExecutable } from '../../../src/server/system/probe.ts';
import { fakeClaudeCommand } from '../../../tools/fake-claude/command.ts';
import { fakeGhCommand } from '../../../tools/fake-gh/command.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';

/**
 * M5.3: the real SystemProvider behind `GET /api/system` (docs/setup.md →
 * *System*) against tools/fake-claude and tools/fake-gh: `--version`, `auth
 * status` exit codes, the cache, machine metrics and the process count.
 */
let tmp: string;
let claudeLog: string;
let ghLog: string;

/** Parent env without CLAUDE* / FAKE_* (the runner may run inside Claude Code). */
function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('CLAUDE') && !key.startsWith('FAKE_')) env[key] = value;
  }
  return { ...env, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'), FAKE_CLAUDE_LOG: claudeLog, FAKE_GH_LOG: ghLog, ...extra };
}

async function logLines(file: string): Promise<Array<{ argv?: string[] }>> {
  try {
    return (await readFile(file, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { argv?: string[] });
  } catch {
    return [];
  }
}

function cpuInfo(user: number, idle: number): os.CpuInfo {
  return { model: 'test', speed: 1, times: { user, nice: 0, sys: 0, idle, irq: 0 } };
}

beforeEach(async () => {
  tmp = await realpath(await makeTempDir('system-probe'));
  await mkdir(path.join(tmp, 'claude-config'), { recursive: true });
  claudeLog = path.join(tmp, 'claude.log');
  ghLog = path.join(tmp, 'gh.log');
});

afterEach(async () => {
  await removeTempDir(tmp);
});

describe('SystemProbe (M5.3)', () => {
  it('reports the CLI, its version and both logins from the fake CLIs; usage stays unknown', async () => {
    let live = 2;
    const probe = new SystemProbe({
      claudeCommand: fakeClaudeCommand(),
      ghCommand: fakeGhCommand(),
      cwd: tmp,
      env: baseEnv(),
      processCount: () => live,
      memory: () => ({ total: 32 * 1024 ** 3, free: 20 * 1024 ** 3 }),
      memoryInUse: async () => 7 * 1024 ** 3,
    });
    await probe.refreshMemory();
    const info = await probe.system();
    expect(info).toEqual({
      cli: fakeClaudeCommand().join(' '),
      cliVersion: '2.1.283',
      signedIn: true,
      ghSignedIn: true,
      cpu: expect.any(Number) as number,
      ramUsed: 7 * 1024 ** 3,
      ramTotal: 32 * 1024 ** 3,
      processes: 2,
    });
    expect(info).not.toHaveProperty('usagePct');
    live = 0;
    expect((await probe.system()).processes).toBe(0);
    // Exactly the three checks, no model call: --version, auth status (claude), auth status (gh).
    const claudeCalls = (await logLines(claudeLog)).filter((l) => l.argv).map((l) => l.argv);
    expect(claudeCalls.length).toBe(2);
    expect(new Set(claudeCalls.map((argv) => JSON.stringify(argv)))).toEqual(new Set([JSON.stringify(['--version']), JSON.stringify(['auth', 'status'])]));
    expect((await logLines(ghLog)).map((l) => l.argv)).toEqual([['auth', 'status']]);
  });

  it('signed out: claude auth status and gh auth status exit 1 → false', async () => {
    const probe = new SystemProbe({
      claudeCommand: fakeClaudeCommand(),
      ghCommand: fakeGhCommand(),
      cwd: tmp,
      env: baseEnv({ FAKE_CLAUDE_SIGNED_OUT: '1', FAKE_GH_SIGNED_OUT: '1' }),
      processCount: () => 0,
    });
    const info = await probe.system();
    expect(info.cli).not.toBeNull();
    expect(info.signedIn).toBe(false);
    expect(info.ghSignedIn).toBe(false);
  });

  it('a CLI that cannot be started: cli and version null, not signed in; a missing gh: not signed in', async () => {
    const probe = new SystemProbe({
      claudeCommand: [path.join(tmp, 'no-such-claude')],
      ghCommand: [path.join(tmp, 'no-such-gh')],
      cwd: tmp,
      env: baseEnv(),
      processCount: () => 0,
    });
    expect(await probe.cliStatus()).toEqual({ cli: null, cliVersion: null, signedIn: false, ghSignedIn: false });
  });

  it('reuses a check for the cache period, shares a running one, and checks again when fresh', async () => {
    let clock = 1_000_000;
    const probe = new SystemProbe({
      claudeCommand: fakeClaudeCommand(),
      ghCommand: fakeGhCommand(),
      cwd: tmp,
      env: baseEnv(),
      processCount: () => 0,
      cacheMs: 30_000,
      now: () => clock,
    });
    const ghCalls = async () => (await logLines(ghLog)).length;
    await Promise.all([probe.system(), probe.system(), probe.system()]);
    expect(await ghCalls()).toBe(1);
    clock += 29_000;
    await probe.system();
    expect(await ghCalls()).toBe(1);
    await probe.system({ fresh: true });
    expect(await ghCalls()).toBe(2);
    clock += 31_000;
    await probe.system();
    expect(await ghCalls()).toBe(3);
  });

  it('CPU is the machine-wide busy share since the previous reading', async () => {
    const samples = [
      [cpuInfo(100, 900), cpuInfo(100, 900)],
      [cpuInfo(400, 1600), cpuInfo(100, 1000)],
      [cpuInfo(400, 1600), cpuInfo(100, 1000)],
    ];
    let index = 0;
    const probe = new SystemProbe({
      claudeCommand: fakeClaudeCommand(),
      ghCommand: fakeGhCommand(),
      cwd: tmp,
      env: baseEnv(),
      processCount: () => 0,
      cpus: () => samples[Math.min(index, samples.length - 1)] as os.CpuInfo[],
    });
    index = 1;
    // Busy 300 of 1100 ms since construction → 27%.
    expect((await probe.system()).cpu).toBe(27);
    index = 2;
    // No time passed: the last value is kept.
    expect((await probe.system()).cpu).toBe(27);
  });
});

describe('SystemProbe · RAM in use (D17)', () => {
  const GIB = 1024 ** 3;
  const memory = () => ({ total: 32 * GIB, free: 20 * GIB });

  function probeWith(options: Partial<ConstructorParameters<typeof SystemProbe>[0]>): SystemProbe {
    return new SystemProbe({
      claudeCommand: fakeClaudeCommand(),
      ghCommand: fakeGhCommand(),
      cwd: tmp,
      env: baseEnv(),
      processCount: () => 0,
      memory,
      ...options,
    });
  }

  it('ramUsed is the platform reader’s value (vm_stat / meminfo), capped at the total', async () => {
    let value = 9.5 * GIB;
    const probe = probeWith({ memoryInUse: async () => value, now: () => 0 });
    await probe.refreshMemory();
    expect((await probe.system()).ramUsed).toBe(9.5 * GIB);
    value = 40 * GIB;
    await probe.refreshMemory();
    expect((await probe.system()).ramUsed).toBe(32 * GIB);
  });

  it('a failed read falls back to total − free: null, a rejection, a throw, a negative or non-number value', async () => {
    const readers = [
      async () => null,
      async (): Promise<number> => {
        throw new Error('vm_stat: ENOENT');
      },
      (): Promise<number> => {
        throw new Error('sync throw');
      },
      async () => -1,
      async () => Number.NaN,
    ];
    for (const memoryInUse of readers) {
      const probe = probeWith({ memoryInUse });
      await probe.refreshMemory();
      expect((await probe.system()).ramUsed).toBe(12 * GIB);
    }
  });

  it('a good read after a failed one is used; a failed one after a good one falls back again', async () => {
    const answers: Array<number | null> = [null, 6 * GIB, null];
    const probe = probeWith({ memoryInUse: async () => answers.shift() ?? null });
    await probe.refreshMemory();
    expect((await probe.system()).ramUsed).toBe(12 * GIB);
    await probe.refreshMemory();
    expect((await probe.system()).ramUsed).toBe(6 * GIB);
    await probe.refreshMemory();
    expect((await probe.system()).ramUsed).toBe(12 * GIB);
  });

  it('never blocks a request: a read still running answers total − free (or the last read) at once', async () => {
    let release: (value: number) => void = () => undefined;
    const reads: number[] = [];
    const probe = probeWith({
      memoryInUse: () => {
        reads.push(reads.length);
        return new Promise<number>((resolve) => {
          release = resolve;
        });
      },
    });
    // The constructor's read is still running.
    expect((await probe.system()).ramUsed).toBe(12 * GIB);
    release(5 * GIB);
    await probe.refreshMemory();
    expect(reads).toHaveLength(1);
  });

  it('cached between system ticks: one read per interval, shared by concurrent callers', async () => {
    let clock = 1_000_000;
    let reads = 0;
    const probe = probeWith({
      now: () => clock,
      memoryInUse: async () => {
        reads += 1;
        return reads * GIB;
      },
    });
    // The constructor started the first read; this waits for it.
    await probe.refreshMemory();
    expect(reads).toBe(1);
    await Promise.all([probe.system(), probe.system(), probe.system()]);
    expect(reads).toBe(1);
    expect((await probe.system()).ramUsed).toBe(1 * GIB);
    // The next /hub tick (5 s later) answers from the last read and starts one new read.
    clock += 5_000;
    expect((await probe.system()).ramUsed).toBe(1 * GIB);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toBe(2);
    expect((await probe.system()).ramUsed).toBe(2 * GIB);
    expect(reads).toBe(2);
  });
});

describe('parseCliVersion / resolveExecutable', () => {
  it('reads the version word of `claude --version`', () => {
    expect(parseCliVersion('2.1.283 (Claude Code)\n')).toBe('2.1.283');
    expect(parseCliVersion('Claude Code 3.0.0-beta.1\n')).toBe('3.0.0-beta.1');
    expect(parseCliVersion('dev build\n')).toBe('dev build');
    expect(parseCliVersion('')).toBeNull();
  });

  it('finds a one-word command on PATH, like the shell; null when it is not there', async () => {
    const bin = path.join(tmp, 'bin');
    await mkdir(bin);
    const file = path.join(bin, 'claude-probe-test');
    await writeFile(file, '#!/bin/sh\nexit 0\n');
    await chmod(file, 0o755);
    const env = { PATH: [path.join(tmp, 'empty'), bin].join(path.delimiter) };
    if (process.platform !== 'win32') {
      expect(await resolveExecutable('claude-probe-test', env)).toBe(file);
    }
    expect(await resolveExecutable('not-there-at-all', env)).toBeNull();
    expect(await resolveExecutable(file, env)).toBe(file);
  });
});
