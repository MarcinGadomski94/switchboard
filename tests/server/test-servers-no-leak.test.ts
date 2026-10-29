import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT, makeTempDir, removeTempDir, workerTestPortsEnv } from '../helpers/net.ts';
import { TEST_RUN_DIR_ENV } from '../helpers/server-registry.ts';

/**
 * No test server outlives its run (CONTRIBUTING.md → *Test servers never outlive a run*):
 * a nested Vitest run of deliberately failing fixtures (`tests/fixtures/server-leak/`) that
 * start a paired pair and time out before registering it, start a server after their test
 * gave up, hang a `beforeAll` on a server that ignores SIGTERM, and kill their own worker
 * with a server running. When the nested run ends, every server it spawned is gone.
 */

let root = '';
afterEach(async () => {
  if (root) await removeTempDir(root);
  root = '';
});

function alive(pid: number, group: boolean): boolean {
  try {
    process.kill(process.platform !== 'win32' && group ? -pid : pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function runNested(env: NodeJS.ProcessEnv): Promise<{ readonly code: number | null; readonly output: string }> {
  const vitest = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  const config = path.join(REPO_ROOT, 'tests', 'fixtures', 'server-leak', 'vitest.config.ts');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [vitest, 'run', '--config', config, '--reporter', 'verbose'], { cwd: REPO_ROOT, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('close', (code) => resolve({ code, output }));
  });
}

describe.skipIf(process.platform === 'win32')('test servers never outlive a run', () => {
  it('servers of timed-out tests and hooks, a late start, a hung server and a killed worker are all gone after the run', { timeout: 180_000 }, async () => {
    root = await makeTempDir('leak-proof');
    const log = path.join(root, 'pids.log');
    // The nested run's servers stay inside this worker's port slice (its own workers slice it further).
    const env: NodeJS.ProcessEnv = { ...process.env, LEAK_LOG: log, LEAK_ROOT: root, SWITCHBOARD_TEST_PORTS: workerTestPortsEnv() };
    delete env[TEST_RUN_DIR_ENV]; // the nested run makes its own

    const { code, output } = await runNested(env);

    // The fixtures fail on purpose.
    expect(code, output).not.toBe(0);
    const lines = (await readFile(log, 'utf8')).trim().split('\n');
    const pids = lines.filter((line) => line.startsWith('pid ')).map((line) => Number(line.slice(4)));
    // Every scenario got as far as it should: a and b paired, the hung server stopped, the crash.
    expect(lines, output).toEqual(expect.arrayContaining(['paired', 'stopped', 'crashing']));
    expect(lines.find((line) => line.startsWith('late ')), output).toMatch(/^late refused: refusing to start a test server/);
    // a + b, the hung one, the crashed worker's one (more when a start retried a port another test took).
    expect(pids.length, output).toBeGreaterThanOrEqual(4);
    for (const pid of pids) {
      expect(alive(pid, false), `server ${pid} still running\n${output}`).toBe(false);
      expect(alive(pid, true), `process group ${pid} still has members\n${output}`).toBe(false);
    }
    // The nets that took them: the end-of-file sweep (the hung one) and the global teardown (the crash).
    expect(output).toMatch(/\[test servers\] stopped 1 test server\(s\) still running at the end of the file/);
    expect(output).toMatch(/\[test servers\] vitest teardown killed 1 leftover test server\(s\) of this run/);
    // The run's pid-file folder is removed.
    const runDirs = [...new Set(lines.filter((line) => line.startsWith('run ')).map((line) => line.slice(4)))];
    expect(runDirs).toHaveLength(1);
    expect(path.basename(runDirs[0] as string)).toMatch(/^switchboard-test-run-/);
    await expect(readdir(runDirs[0] as string)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
