import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServiceLocation } from '../../../src/core/service-files.ts';
import type { RunResult } from '../../../src/server/exec.ts';
import { type HelperPlan, RestartError, detectRestartMode, helperSteps, restartIntoService, spawnHelper } from '../../../src/server/updates/restart.ts';
import { fakeServiceCtlCommand } from '../../../tools/fake-servicectl/command.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';

/**
 * D55 restart after an update (`docs/updates.md` → *Restarting*,
 * `docs/service.md` → *Restart after an update*): which processes count as
 * the login service's, the manager commands per OS, and the detached helper
 * that runs them once the old process has exited (for real, against
 * tools/fake-servicectl).
 */

let tmp: string;
beforeEach(async () => {
  tmp = await makeTempDir('restart');
});
afterEach(async () => {
  await removeTempDir(tmp);
});

const ok = (stdout = ''): RunResult => ({ code: 0, signal: null, stdout, stderr: '', error: null, timedOut: false });
const fail = (stderr: string): RunResult => ({ code: 1, signal: null, stdout: '', stderr, error: null, timedOut: false });

function location(platform: ServiceLocation['platform']): ServiceLocation {
  return { platform, home: path.join(tmp, 'home'), dataDir: path.join(tmp, 'data'), xdgConfigHome: null };
}

describe('detectRestartMode', () => {
  const base = { manager: ['ctl'], pid: 4242, execArgv: [] as string[], uid: 501 };

  it('macOS: launchd set XPC_SERVICE_NAME to the job label', async () => {
    expect(await detectRestartMode({ ...base, location: location('darwin'), env: { XPC_SERVICE_NAME: 'local.switchboard' } })).toBe('service');
    expect(await detectRestartMode({ ...base, location: location('darwin'), env: { XPC_SERVICE_NAME: 'com.apple.Terminal' } })).toBe('manual');
    expect(await detectRestartMode({ ...base, location: location('darwin'), env: {} })).toBe('manual');
  });

  it("Linux: the unit's MainPID is this process", async () => {
    const calls: string[][] = [];
    const run = async (command: readonly string[], args: readonly string[]): Promise<RunResult> => {
      calls.push([...command, ...args]);
      return ok('4242\n');
    };
    expect(await detectRestartMode({ ...base, location: location('linux'), env: { INVOCATION_ID: 'abc' }, run })).toBe('service');
    expect(calls).toEqual([['ctl', '--user', 'show', '--property', 'MainPID', '--value', 'switchboard.service']]);
    expect(await detectRestartMode({ ...base, location: location('linux'), env: { INVOCATION_ID: 'abc' }, run: async () => ok('99\n') })).toBe('manual');
    expect(await detectRestartMode({ ...base, location: location('linux'), env: {}, run })).toBe('manual');
  });

  it("Windows: started with the task's --env-file", async () => {
    const envFile = path.win32.join(path.join(tmp, 'data'), 'service', 'switchboard.env');
    expect(await detectRestartMode({ ...base, location: location('win32'), env: {}, execArgv: [`--env-file=${envFile.toUpperCase()}`] })).toBe('service');
    expect(await detectRestartMode({ ...base, location: location('win32'), env: {}, execArgv: ['--env-file=C:\\other.env'] })).toBe('manual');
  });

  it('no location = manual; the test flag = service', async () => {
    expect(await detectRestartMode({ ...base, location: null, env: {} })).toBe('manual');
    expect(await detectRestartMode({ ...base, location: location('darwin'), env: {}, testUnderService: true })).toBe('service');
  });
});

describe('helperSteps', () => {
  it('macOS: bootout the loaded job, bootstrap the rewritten plist', () => {
    expect(helperSteps(location('darwin'), ['launchctl'], 501)).toEqual([
      ['launchctl', 'bootout', 'gui/501/local.switchboard'],
      ['launchctl', 'bootstrap', 'gui/501', path.posix.join(tmp, 'home', 'Library', 'LaunchAgents', 'local.switchboard.plist')],
    ]);
  });

  it('Windows: run the re-created task; Linux: none (systemd restarts it)', () => {
    expect(helperSteps(location('win32'), ['schtasks'], null)).toEqual([['schtasks', '/Run', '/TN', 'Switchboard']]);
    expect(helperSteps(location('linux'), ['systemctl'], null)).toEqual([]);
  });
});

describe('restartIntoService', () => {
  it('Linux: asks systemd for a non-blocking restart and does not exit itself', async () => {
    const calls: string[][] = [];
    let exited = false;
    await restartIntoService({
      location: location('linux'),
      manager: ['systemctl'],
      env: {},
      pid: 1,
      execArgv: [],
      uid: null,
      log: path.join(tmp, 'update.log'),
      exit: () => {
        exited = true;
      },
      run: async (command, args) => {
        calls.push([...command, ...args]);
        return ok();
      },
    });
    expect(calls).toEqual([['systemctl', '--user', 'restart', '--no-block', 'switchboard.service']]);
    expect(exited).toBe(false);
    await expect(
      restartIntoService({ location: location('linux'), manager: ['systemctl'], env: {}, pid: 1, execArgv: [], uid: null, log: 'x', exit: () => undefined, run: async () => fail('Unit not found') }),
    ).rejects.toThrow(RestartError);
  });

  for (const platform of ['darwin', 'win32'] as const) {
    it(`${platform}: starts the helper with the steps, then exits`, async () => {
      const plans: HelperPlan[] = [];
      const order: string[] = [];
      await restartIntoService({
        location: location(platform),
        manager: ['m'],
        env: {},
        pid: 77,
        execArgv: [],
        uid: 501,
        log: path.join(tmp, 'update.log'),
        exit: () => order.push('exit'),
        spawn: async (plan) => {
          order.push('helper');
          plans.push(plan);
        },
      });
      expect(order).toEqual(['helper', 'exit']);
      expect(plans[0]).toMatchObject({ pid: 77, steps: helperSteps(location(platform), ['m'], 501), log: path.join(tmp, 'update.log') });
    });
  }
});

describe('the helper (relaunch.ts)', () => {
  it('waits for the old process to exit, then runs the manager commands in order', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 700)'], { stdio: 'ignore' });
    const pid = child.pid ?? 0;
    const ctlLog = path.join(tmp, 'ctl.log');
    const log = path.join(tmp, 'logs', 'update.log');
    const exited = new Promise<number>((resolve) => child.once('exit', () => resolve(Date.now())));
    await spawnHelper(
      { pid, steps: [[...fakeServiceCtlCommand(), 'bootout', 'gui/501/local.switchboard'], [...fakeServiceCtlCommand(), 'bootstrap', 'gui/501', '/x.plist']], waitMs: 10_000, log },
      { env: { ...process.env, FAKE_SERVICECTL_LOG: ctlLog } },
    );
    const exitAt = await exited;
    const deadline = Date.now() + 10_000;
    let text = '';
    while (Date.now() < deadline) {
      text = await readFile(log, 'utf8').catch(() => '');
      if (text.includes('done')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(text).toContain(`waiting for process ${pid} to exit`);
    expect(text).toContain('done');
    const calls = (await readFile(ctlLog, 'utf8')).trim().split('\n').map((line) => (JSON.parse(line) as { argv: string[] }).argv);
    expect(calls).toEqual([['bootout', 'gui/501/local.switchboard'], ['bootstrap', 'gui/501', '/x.plist']]);
    expect(Date.now()).toBeGreaterThan(exitAt);
  });

  it('retries the last step and gives up with a line in the log', async () => {
    const log = path.join(tmp, 'update.log');
    await spawnHelper({ pid: 999_999_9, steps: [[...fakeServiceCtlCommand(), '/Run', '/TN', 'Switchboard']], waitMs: 1000, log }, { env: { ...process.env, FAKE_SERVICECTL_FAIL: '/Run' } });
    const deadline = Date.now() + 20_000;
    let text = '';
    while (Date.now() < deadline) {
      text = await readFile(log, 'utf8').catch(() => '');
      if (text.includes('restart Switchboard yourself')) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(text.match(/\/Run \/TN Switchboard → 1/g)).toHaveLength(5);
    expect(text).toContain('the service could not be started; restart Switchboard yourself');
  }, 30_000);
});
