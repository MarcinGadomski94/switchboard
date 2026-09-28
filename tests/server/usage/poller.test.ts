import { mkdir, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readingFromGetUsage } from '../../../src/core/usage.ts';
import { USAGE_POLLER_ARGS, UsagePoller } from '../../../src/server/usage/poller.ts';
import { fakeClaudeCommand } from '../../../tools/fake-claude/command.ts';
import { fakeEnv } from '../../helpers/fake-claude.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { readFakeLog, spawnedArgv, stdinOf } from '../../helpers/supervisor.ts';

/**
 * M9.2 oracle, the short-lived poller against fake-claude (a real spawn, D13):
 * its exact argv and cwd (the app-data folder), the M2.1 env scrub, one
 * `get_usage` on stdin and nothing else (no user message → no model call, no
 * transcript), then EOF; and its failures (missing CLI, exit without an
 * answer, no answer in time) become an unknown reading.
 */

let root: string;
let dataDir: string;
let configDir: string;
let logFile: string;

beforeEach(async () => {
  root = await realpath(await makeTempDir('usage-poller'));
  dataDir = path.join(root, 'app data');
  configDir = path.join(root, 'claude-config');
  logFile = path.join(root, 'fake.log');
  await mkdir(dataDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
});

afterEach(async () => {
  await removeTempDir(root);
});

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return fakeEnv({ CLAUDE_CONFIG_DIR: configDir, FAKE_CLAUDE_LOG: logFile, ...extra });
}

describe('UsagePoller (fake-claude)', () => {
  it('spawns `claude -p` stream-json in the app-data folder, asks get_usage once, closes stdin, reads 10 / 18', async () => {
    const poller = new UsagePoller({
      claudeCommand: fakeClaudeCommand(),
      cwd: dataDir,
      // A parent Claude Code session's variables must not reach the child (M2.1 scrub).
      env: env({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: '42' }),
    });
    const outcome = await poller.getUsage();
    expect(outcome.kind).toBe('response');
    expect(readingFromGetUsage(outcome)).toMatchObject({
      source: 'get_usage',
      fiveHourPct: 10,
      fiveHourResetsAt: '2026-09-27T23:40:00.290Z',
      sevenDayPct: 18,
      sevenDayResetsAt: '2026-10-01T13:00:00.290Z',
      unknown: null,
    });

    const [spawned, ...more] = await spawnedArgv(logFile);
    expect(more).toEqual([]);
    expect(spawned?.argv).toEqual([...USAGE_POLLER_ARGS]);
    expect(spawned?.argv).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio']);
    expect(spawned?.cwd).toBe(dataDir);
    expect(spawned?.claudeEnvKeys).toEqual(['CLAUDE_CONFIG_DIR']);

    const stdin = await stdinOf(logFile, spawned?.pid as number);
    expect(stdin).toHaveLength(1);
    expect(stdin[0]).toMatchObject({ type: 'control_request', request: { subtype: 'get_usage', skip_behaviors: true } });
    expect(String(stdin[0]?.['request_id'])).toMatch(/^sb-usage-/);
    expect((await readFakeLog(logFile)).some((line) => line.kind === 'stdin' && String(line.line).includes('"type":"user"'))).toBe(false);

    // No user message → no turn, no transcript, and the process is gone (not listed live).
    const written = await readdir(configDir, { recursive: true });
    expect(written.filter((file) => file.endsWith('.jsonl'))).toEqual([]);
    expect(written.filter((file) => file.startsWith('sessions') && file.endsWith('.json'))).toEqual([]);
  });

  it('appends the dev-only extra args like every spawn (D13 real-CLI smoke)', async () => {
    const poller = new UsagePoller({ claudeCommand: fakeClaudeCommand(), extraArgs: ['--model', 'haiku', '--max-turns', '3'], cwd: dataDir, env: env() });
    expect((await poller.getUsage()).kind).toBe('response');
    const [spawned] = await spawnedArgv(logFile);
    expect(spawned?.argv).toEqual([...USAGE_POLLER_ARGS, '--model', 'haiku', '--max-turns', '3']);
  });

  it('a missing CLI → failed (unknown reading)', async () => {
    const outcome = await new UsagePoller({ claudeCommand: [path.join(root, 'no-such-claude')], cwd: dataDir, env: env() }).getUsage();
    expect(outcome).toMatchObject({ kind: 'failed' });
    expect(outcome.kind === 'failed' && outcome.error).toMatch(/^could not start claude: /);
    expect(readingFromGetUsage(outcome)).toMatchObject({ fiveHourPct: null, sevenDayPct: null, unknown: 'error' });
  });

  it('a CLI that exits without answering → failed with the exit and the last stderr line', async () => {
    const script = "process.stderr.write('not signed in\\n'); process.exit(3)";
    const outcome = await new UsagePoller({ claudeCommand: [process.execPath, '-e', script, '--'], cwd: dataDir, env: env() }).getUsage();
    expect(outcome).toEqual({ kind: 'failed', error: 'claude exited (code 3) without answering get_usage: not signed in' });
  });

  it('a CLI that never answers is stopped after the timeout → failed', async () => {
    const script = 'process.stdin.resume(); setInterval(() => {}, 1000)';
    const started = Date.now();
    const outcome = await new UsagePoller({ claudeCommand: [process.execPath, '-e', script, '--'], cwd: dataDir, env: env(), timeoutMs: 300 }).getUsage();
    expect(outcome).toEqual({ kind: 'failed', error: 'claude did not answer get_usage in time' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
