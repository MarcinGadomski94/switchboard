import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { LAUNCHD_LABEL, MANAGER_BIN, type ServiceLocation, SYSTEMD_UNIT, TASK_NAME, servicePaths } from '../../core/service-files.ts';
import type { RestartMode } from '../../core/updates.ts';
import { type RunResult, failureText, runCommand, succeeded } from '../exec.ts';

/**
 * The restart after an update (D55, `docs/updates.md` → *Restarting*,
 * `docs/service.md` → *Restart after an update*). None of the login services
 * restarts Switchboard when it exits (`KeepAlive` false, `Restart=no`, no
 * `RestartOnFailure`: a crash loop would resume the sessions over and over), so
 * the updater asks the service manager for exactly one start of the new
 * definition:
 * - **macOS (launchd):** launchd keeps the definition it loaded, so a detached
 *   helper (its own session, so launchd's clean-up of the job's process group
 *   spares it) waits for this process to exit, then `launchctl bootout` +
 *   `launchctl bootstrap` of the rewritten plist (RunAtLoad starts it).
 * - **Linux (systemd):** `systemctl --user restart --no-block switchboard.service`
 *   (after the `daemon-reload` of the switch); systemd stops this process
 *   (SIGTERM: the normal shutdown) and starts the new unit. No helper: systemd
 *   would kill it with the unit.
 * - **Windows (Task Scheduler):** a detached helper waits for this process to
 *   exit, then `schtasks /Run /TN Switchboard` (the task was re-created with the
 *   new folder; one instance at a time, so it can only start once this one ended).
 * A Switchboard started by hand (`npm start`) is never exited: the developer
 * restarts it.
 */

/** How long the helper waits for the old process to exit. */
export const HELPER_WAIT_MS = 120_000;

/** How the running process relates to the login service. */
export interface RestartEnvironment {
  readonly location: ServiceLocation | null;
  /** The manager as an argv prefix (launchctl / systemctl / schtasks, or the test fake). */
  readonly manager: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly pid: number;
  readonly execArgv: readonly string[];
  readonly uid: number | null;
  /** Tests only (`SWITCHBOARD_UPDATE_TEST_UNDER_SERVICE=1` with the service redirect): act as the service. */
  readonly testUnderService?: boolean;
  /** Runs a manager command (default: {@link runCommand}, `shell: false`). */
  readonly run?: (command: readonly string[], args: readonly string[]) => Promise<RunResult>;
}

function runner(env: RestartEnvironment): (command: readonly string[], args: readonly string[]) => Promise<RunResult> {
  return env.run ?? ((command, args) => runCommand(command, args, { cwd: path.dirname(process.execPath), env: env.env, timeoutMs: 30_000 }));
}

/**
 * `service` when this process is the login service's instance: macOS, launchd
 * set `XPC_SERVICE_NAME` to its label; Linux, systemd's `MainPID` of the unit is
 * this process; Windows, the process was started with the task's
 * `--env-file=<dataDir>\service\switchboard.env`. Else `manual`.
 */
export async function detectRestartMode(env: RestartEnvironment): Promise<RestartMode> {
  const { location } = env;
  if (!location) return 'manual';
  if (env.testUnderService) return 'service';
  switch (location.platform) {
    case 'darwin':
      return env.env['XPC_SERVICE_NAME'] === LAUNCHD_LABEL ? 'service' : 'manual';
    case 'linux': {
      if (!env.env['INVOCATION_ID']) return 'manual';
      const result = await runner(env)(env.manager, ['--user', 'show', '--property', 'MainPID', '--value', SYSTEMD_UNIT]);
      return succeeded(result) && Number(result.stdout.trim()) === env.pid ? 'service' : 'manual';
    }
    case 'win32': {
      const envFile = servicePaths(location).envFile;
      if (!envFile) return 'manual';
      const flag = `--env-file=${envFile}`.toLowerCase();
      return env.execArgv.some((arg) => arg.toLowerCase() === flag) ? 'service' : 'manual';
    }
  }
}

/** The manager commands the helper runs once this process has exited (macOS, Windows); `[]` on Linux. */
export function helperSteps(location: ServiceLocation, manager: readonly string[], uid: number | null): string[][] {
  switch (location.platform) {
    case 'darwin': {
      const domain = `gui/${uid ?? 0}`;
      const plist = servicePaths(location).definition;
      return [
        [...manager, 'bootout', `${domain}/${LAUNCHD_LABEL}`],
        [...manager, 'bootstrap', domain, plist],
      ];
    }
    case 'win32':
      return [[...manager, '/Run', '/TN', TASK_NAME]];
    case 'linux':
      return [];
  }
}

/** What the helper (`relaunch.ts`) is started with, as one JSON argument. */
export interface HelperPlan {
  /** The process to wait for. */
  readonly pid: number;
  /** Commands, in order; only the last one must succeed (it is retried). */
  readonly steps: readonly (readonly string[])[];
  readonly waitMs: number;
  readonly log: string;
}

/** The helper script (in the running install, never in the downloaded package). */
export const HELPER_SCRIPT = path.join(import.meta.dirname, 'relaunch.ts');

/** Starts the detached helper; resolves once it is spawned. */
export async function spawnHelper(plan: HelperPlan, options: { readonly env: NodeJS.ProcessEnv; readonly script?: string }): Promise<void> {
  await mkdir(path.dirname(plan.log), { recursive: true });
  const log = await open(plan.log, 'a');
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [options.script ?? HELPER_SCRIPT, JSON.stringify(plan)], {
        detached: true,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', log.fd, log.fd],
        env: options.env,
        cwd: path.dirname(process.execPath),
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  } finally {
    await log.close();
  }
}

/** Options for {@link restartIntoService}. */
export interface RestartOptions extends RestartEnvironment {
  /** Closes this Switchboard the normal way (like SIGTERM) and exits 0. */
  readonly exit: () => void;
  /** Where the helper logs (`<dataDir>/logs/update.log`). */
  readonly log: string;
  /** Starts the helper (default {@link spawnHelper}). */
  readonly spawn?: (plan: HelperPlan) => Promise<void>;
}

/** A restart that could not be requested. */
export class RestartError extends Error {
  override name = 'RestartError';
}

/**
 * Asks the login service for one start of the (already re-pointed) definition
 * and lets this process end (see the module comment per OS).
 * @throws {RestartError} when the manager refuses (Linux) or the helper cannot start.
 */
export async function restartIntoService(options: RestartOptions): Promise<void> {
  const { location } = options;
  if (!location) throw new RestartError('no login service on this OS');
  if (location.platform === 'linux') {
    const result = await runner(options)(options.manager, ['--user', 'restart', '--no-block', SYSTEMD_UNIT]);
    if (!succeeded(result)) throw new RestartError(`systemctl --user restart failed: ${failureText(result)}`);
    // systemd sends SIGTERM now; the normal shutdown follows.
    return;
  }
  const plan: HelperPlan = { pid: options.pid, steps: helperSteps(location, options.manager, options.uid), waitMs: HELPER_WAIT_MS, log: options.log };
  try {
    await (options.spawn ?? ((p) => spawnHelper(p, { env: options.env })))(plan);
  } catch (error) {
    throw new RestartError(`could not start the restart helper: ${(error as Error).message}`);
  }
  options.exit();
}

/** The default manager of a platform (`launchctl`, `systemctl`, `schtasks`). */
export function defaultManager(location: ServiceLocation | null): readonly string[] {
  return location ? [MANAGER_BIN[location.platform]] : [];
}
