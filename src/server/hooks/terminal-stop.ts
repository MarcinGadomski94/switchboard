import { setTimeout as sleep } from 'node:timers/promises';
import { runCommand } from '../exec.ts';

/**
 * D65 (`docs/peers.md` → *Taking a session over* → *Hooked terminal sessions*):
 * stops the terminal's `claude` process after its conversation and files are
 * captured. The approach per OS (ASSUMED D65-stop-approach, the CLI's own
 * handling of SIGTERM was not probed): macOS / Linux: SIGTERM, then SIGKILL after
 * the grace time if it still lives; Windows: `taskkill /PID <pid> /T` (the
 * process tree, asking it to close), then `/F` after the grace time. Only the
 * process the registry named for the session is touched (the caller verified
 * pid and session id against `claude agents --json`); the terminal window and
 * its shell stay open.
 */

/** How a stop ended. */
export type StopHow = 'gone' | 'terminated' | 'killed';

/** `true` while a process with `pid` exists. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, we may not signal it.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Options of {@link stopProcess}. */
export interface StopProcessOptions {
  readonly platform?: NodeJS.Platform;
  /** How long a polite stop gets before the force (default 10 s). */
  readonly graceMs?: number;
  /** Signals / commands (tests replace them). */
  readonly signal?: (pid: number, signal: NodeJS.Signals) => void;
  readonly taskkill?: (pid: number, force: boolean) => Promise<void>;
  readonly alive?: (pid: number) => boolean;
}

async function waitGone(pid: number, ms: number, alive: (pid: number) => boolean): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await sleep(50);
  }
  return !alive(pid);
}

/**
 * Stops `pid`. Resolves with how it ended (`gone`: it was not running;
 * `terminated`: it left after the polite stop; `killed`: it needed the force);
 * rejects when the process is still there after the force.
 */
export async function stopProcess(pid: number, options: StopProcessOptions = {}): Promise<StopHow> {
  const platform = options.platform ?? process.platform;
  const grace = options.graceMs ?? 10_000;
  const alive = options.alive ?? processAlive;
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`not a process id: ${String(pid)}`);
  if (!alive(pid)) return 'gone';
  if (platform === 'win32') {
    const taskkill =
      options.taskkill ??
      (async (target: number, force: boolean): Promise<void> => {
        await runCommand(['taskkill'], ['/PID', String(target), '/T', ...(force ? ['/F'] : [])], { cwd: process.cwd(), timeoutMs: 15_000 });
      });
    await taskkill(pid, false);
    if (await waitGone(pid, grace, alive)) return 'terminated';
    await taskkill(pid, true);
    if (await waitGone(pid, 3_000, alive)) return 'killed';
    throw new Error(`process ${pid} is still running after taskkill /F`);
  }
  const signal = options.signal ?? ((target: number, name: NodeJS.Signals) => process.kill(target, name));
  try {
    signal(pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'gone';
    throw error;
  }
  if (await waitGone(pid, grace, alive)) return 'terminated';
  try {
    signal(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'killed';
    throw error;
  }
  if (await waitGone(pid, 3_000, alive)) return 'killed';
  throw new Error(`process ${pid} is still running after SIGKILL`);
}
