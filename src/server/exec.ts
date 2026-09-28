import { spawn } from 'node:child_process';

/** Options for {@link runCommand}. */
export interface RunOptions {
  readonly cwd: string;
  /** Child environment (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** Kill the child (SIGTERM, then SIGKILL 2 s later) after this many ms. Default 60 s. */
  readonly timeoutMs?: number;
  /** Kill the child once stdout + stderr exceed this many bytes. Default 64 MiB. */
  readonly maxOutputBytes?: number;
}

/** How a finished command ended. */
export interface RunResult {
  /** Exit code; `null` when the child died from a signal or never started. */
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the command could not be started (e.g. `ENOENT`) or was killed by a limit. */
  readonly error: Error | null;
  readonly timedOut: boolean;
}

/** `true` when the command started and exited with code 0. */
export function succeeded(result: RunResult): boolean {
  return result.error === null && result.code === 0;
}

/** One line for error messages: the stderr (or stdout) text, trimmed, else how it ended. */
export function failureText(result: RunResult): string {
  const text = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-3).join(' ').trim();
  if (text) return text;
  if (result.error) return result.error.message;
  return result.signal ? `killed by ${result.signal}` : `exit code ${String(result.code)}`;
}

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_MAX_OUTPUT = 64 * 1024 * 1024;

/**
 * Runs `command` (an argv prefix such as `["git"]` or `[node, script]`) with
 * `args`, **always** with `shell: false` (AGENTS.md: never a shell string), and
 * collects its output asynchronously. Never throws: a missing executable, a
 * timeout or too much output come back in {@link RunResult.error}.
 */
export function runCommand(command: readonly string[], args: readonly string[], options: RunOptions): Promise<RunResult> {
  const [cmd, ...prefix] = command;
  if (!cmd) {
    return Promise.resolve({ code: null, signal: null, stdout: '', stderr: '', error: new Error('empty command'), timedOut: false });
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  return new Promise<RunResult>((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let error: Error | null = null;
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(cmd, [...prefix, ...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stop = (reason: Error): void => {
      if (error === null) error = reason;
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2_000);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref();
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxOutput) {
        stop(new Error(`output exceeded ${maxOutput} bytes`));
        return;
      }
      into.push(chunk);
    };
    child.stdout?.on('data', collect(stdout));
    child.stderr?.on('data', collect(stderr));
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        error,
        timedOut,
      });
    };
    child.on('error', (spawnError) => {
      error ??= spawnError;
      // 'close' may not follow a spawn failure.
      setImmediate(() => finish(null, null));
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}
