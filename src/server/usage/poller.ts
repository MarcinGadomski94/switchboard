import { randomUUID } from 'node:crypto';
import { parseStreamLine } from '../../core/stream-json.ts';
import { type GetUsageOutcome, getUsageLine } from '../../core/usage.ts';
import { childEnv } from '../supervisor/argv.ts';
import { ClaudeProcess } from '../supervisor/process.ts';

/**
 * The short-lived usage poller's argv (without the CLI command; BACKLOG M9.2,
 * `docs/spike-m0.md` → *Implications* → M9.2 usage meter): stream-json in and out
 * so `get_usage` can go over stdin, `--permission-prompt-tool stdio` as recorded
 * in `usage-ctl`. No prompt, no `--session-id`: with no user message the CLI makes
 * no model call and writes no transcript, and exits 0 at EOF (~3.5 s in M0.3).
 */
export const USAGE_POLLER_ARGS: readonly string[] = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--permission-prompt-tool',
  'stdio',
];

/** Default limit for one poll, spawn to exit (the CLI's own SessionStart hooks run first). */
export const DEFAULT_POLL_TIMEOUT_MS = 30_000;

/** How long the poller waits after each signal once the timeout passed. */
const KILL_GRACE_MS = 2_000;

/** Something that reads `get_usage` once (the poller; tests fake it). */
export interface UsageFetcher {
  getUsage(): Promise<GetUsageOutcome>;
}

/** Options for {@link UsagePoller}. */
export interface UsagePollerOptions {
  /** CLI argv prefix (`SWITCHBOARD_CLAUDE_BIN`). */
  readonly claudeCommand: readonly string[];
  /** Dev-only flags appended like on every supervised spawn (`SWITCHBOARD_CLAUDE_EXTRA_ARGS`, the D13 real-CLI smoke). */
  readonly extraArgs?: readonly string[];
  /** The working folder: Switchboard's app-data folder, never a repo. It must exist. */
  readonly cwd: string;
  /** Base environment (default `process.env`), scrubbed like the supervisor's children (M2.1). */
  readonly env?: NodeJS.ProcessEnv;
  /** Spawn-to-exit limit (default 30 s); past it the process is stopped and the poll failed. */
  readonly timeoutMs?: number;
}

/**
 * Reads the Max usage when no supervised session is live: spawns
 * `claude <USAGE_POLLER_ARGS>` in the app-data folder, writes one `get_usage`
 * control request (`skip_behaviors: true`), closes stdin once it is answered, and
 * waits for the exit. Never a user message, never a model call.
 */
export class UsagePoller implements UsageFetcher {
  readonly #options: UsagePollerOptions;

  constructor(options: UsagePollerOptions) {
    this.#options = options;
  }

  /** The argv after the CLI command. */
  get args(): readonly string[] {
    return [...USAGE_POLLER_ARGS, ...(this.#options.extraArgs ?? [])];
  }

  async getUsage(): Promise<GetUsageOutcome> {
    const requestId = `sb-usage-${randomUUID()}`;
    const holder: { proc?: ClaudeProcess; outcome?: GetUsageOutcome } = {};
    let proc: ClaudeProcess;
    try {
      proc = new ClaudeProcess({
        command: this.#options.claudeCommand,
        args: this.args,
        cwd: this.#options.cwd,
        env: childEnv(this.#options.env ?? process.env),
        onLine: (line) => {
          if (holder.outcome) return;
          const message = parseStreamLine(line);
          if (message.kind !== 'control-response' || message.requestId !== requestId) return;
          holder.outcome = { kind: 'response', message };
          // Answered: EOF lets the CLI exit without a turn.
          holder.proc?.endInput();
        },
      });
    } catch (error) {
      return { kind: 'failed', error: `could not start claude: ${error instanceof Error ? error.message : String(error)}` };
    }
    holder.proc = proc;
    proc.write(getUsageLine(requestId));
    if (!(await proc.waitForExit(this.#options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS))) {
      // Too slow (answered or not): stop it; an answer that did come still counts.
      proc.endInput();
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        proc.kill(signal);
        if (await proc.waitForExit(KILL_GRACE_MS)) break;
      }
      return holder.outcome ?? { kind: 'failed', error: 'claude did not answer get_usage in time' };
    }
    const exit = await proc.exited;
    if (holder.outcome) return holder.outcome;
    if (exit.spawnError) return { kind: 'failed', error: `could not start claude: ${exit.spawnError.message}` };
    const stderr = proc.stderrTail().trim().split('\n').pop() ?? '';
    const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
    return { kind: 'failed', error: `claude exited (${how}) without answering get_usage${stderr ? `: ${stderr}` : ''}` };
  }
}
