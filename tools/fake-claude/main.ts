#!/usr/bin/env node
/**
 * tools/fake-claude: a stand-in for the `claude` CLI (2.1.283) that replays the
 * M0 recordings in `fixtures/`. Tests and the SessionSupervisor start it through
 * an argv prefix (`command.ts` → `fakeClaudeCommand()`); on macOS/Linux this file
 * is also directly executable. Surface and behavior: `docs/fake-claude.md`.
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { CLI_VERSION, type FakeCommand, UsageError, parseArgv } from './args.ts';
import { FixtureStore } from './fixtures.ts';
import { runMcpCommand } from './mcp.ts';
import { Logger } from './log.ts';
import { Runner } from './session.ts';
import { listAgents } from './transcript.ts';

process.stdout.on('error', () => undefined);
process.stderr.on('error', () => undefined);

function writeOut(text: string): Promise<void> {
  return new Promise((resolve) => process.stdout.write(text, () => resolve()));
}

function writeErr(text: string): Promise<void> {
  return new Promise((resolve) => process.stderr.write(text, () => resolve()));
}

async function canonical(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch {
    return path.resolve(dir);
  }
}

const log = Logger.fromEnv(process.env);

async function exit(code: number): Promise<never> {
  await log?.flush();
  await writeOut('');
  await writeErr('');
  process.exit(code);
}

async function main(argv: readonly string[]): Promise<void> {
  const cwd = await canonical(process.cwd());
  await log?.argv(argv, cwd, process.env);

  let command: FakeCommand;
  try {
    command = parseArgv(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    await writeErr(`${error.message}\n`);
    return exit(1);
  }

  const configDir = process.env['CLAUDE_CONFIG_DIR']?.trim() ? path.resolve(process.env['CLAUDE_CONFIG_DIR']) : null;
  switch (command.kind) {
    case 'version':
      await writeOut(`${CLI_VERSION} (Claude Code)\n`);
      return exit(0);
    case 'auth-status':
      // Callers rely on the exit code only; the real output was never captured (M0).
      return exit(process.env['FAKE_CLAUDE_SIGNED_OUT'] === '1' ? 1 : 0);
    case 'agents': {
      const rows = await listAgents(configDir, command.cwd === null ? null : await canonical(command.cwd));
      if (command.json) await writeOut(`${JSON.stringify(rows)}\n`);
      else await writeOut(rows.map((r) => `${r.sessionId}  ${r.status}  ${r.name}  ${r.cwd}\n`).join(''));
      return exit(0);
    }
    case 'mcp':
      return exit(await runMcpCommand(command.argv, process.env, cwd));
    case 'run': {
      if (!command.args.print) {
        await writeErr('fake-claude: only print mode (-p) is supported\n');
        return exit(1);
      }
      const runner = new Runner({
        args: command.args,
        env: process.env,
        cwd,
        store: await FixtureStore.open(),
        log,
        stdin: process.stdin,
        writeStdout: (text) => {
          process.stdout.write(text);
        },
        writeStderr: (text) => {
          process.stderr.write(text);
        },
        exit,
      });
      await runner.start();
    }
  }
}

main(process.argv.slice(2)).catch(async (error: unknown) => {
  await writeErr(`fake-claude: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  await exit(1);
});
