import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { LoginServiceStatus } from '../../core/login-service.ts';
import { MANAGER_BIN, type ServiceLocation, installPlan, serviceManager, servicePaths, uninstallPlan } from '../../core/service-files.ts';
import type { ServerConfig } from '../config.ts';
import type { SettingRepository } from '../db/repos/settings.ts';
import type { RunResult } from '../exec.ts';
import type { LoginServiceProvider } from '../providers.ts';
import { ServiceError } from './errors.ts';
import { executePlan } from './executor.ts';
import { checkNode } from './node-check.ts';
import { APP_DIR, SERVICE_ENTRY, type ServiceRedirect, carriedEnvironment, currentUid, serviceLocation, serviceTarget, withCleanSearchPath } from './target.ts';

/** The settings key the toggle mirrors its state into (`GET /api/settings`, M8.2). */
export const START_AT_LOGIN_SETTING = 'service.startAtLogin';

/** Options for {@link LoginService}. */
export interface LoginServiceOptions {
  /** Where the files go; `null` = unsupported OS (the toggle refuses). */
  readonly location: ServiceLocation | null;
  /** The service manager as an argv prefix (default: launchctl / systemctl / schtasks). */
  readonly manager?: readonly string[];
  /** Environment of the checks and commands: PATH (node lookup + the unit's PATH), USERNAME, … */
  readonly env: NodeJS.ProcessEnv;
  /** The `SWITCHBOARD_*` values the service starts with ({@link carriedEnvironment}). */
  readonly carried: Readonly<Record<string, string>>;
  /** `127.0.0.1:<port>`. */
  readonly address: string;
  /** Where the toggle's state is mirrored (`service.startAtLogin`). */
  readonly settings?: SettingRepository;
  readonly appDir?: string;
  readonly entry?: string;
  /** macOS user id (default: the process's). */
  readonly uid?: number | null;
  /** How PATH is searched for node (default: this process's platform). */
  readonly hostPlatform?: NodeJS.Platform;
  /** Runs `node --version` and the manager commands (default: real spawns, `shell: false`). */
  readonly run?: (command: readonly string[], args: readonly string[]) => Promise<RunResult>;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * "Start at login" (M9.1, `docs/service.md`): registers or removes this user's
 * background service definition. Turning it on checks for Node ≥ 24 on PATH,
 * writes the definition and registers it for the next login (it never starts a
 * second instance now); turning it off removes the registration (it never stops
 * the running service, which may be the one answering). The state is the
 * definition file's existence, mirrored into `service.startAtLogin`. Changes run
 * one at a time.
 */
export class LoginService implements LoginServiceProvider {
  readonly #options: LoginServiceOptions;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: LoginServiceOptions) {
    this.#options = options;
  }

  async status(): Promise<LoginServiceStatus> {
    const { location } = this.#options;
    if (!location) return { manager: null, startAtLogin: false, file: null };
    const file = servicePaths(location).definition;
    return { manager: serviceManager(location.platform), startAtLogin: await exists(file), file };
  }

  setStartAtLogin(enabled: boolean): Promise<LoginServiceStatus> {
    const next = this.#queue.then(() => this.#set(enabled));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /**
   * D55 (`docs/updates.md` → *Switching*): registers the service definition
   * again for another install folder (`<appDir>/src/server/main.ts`, working
   * folder `appDir`), the updater's switch to a new version. The same steps as
   * turning it on (a failed manager command puts the files back); it never
   * starts or stops anything.
   */
  pointTo(appDir: string): Promise<LoginServiceStatus> {
    const next = this.#queue.then(() => this.#set(true, appDir));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #set(enabled: boolean, appDir?: string): Promise<LoginServiceStatus> {
    const options = this.#options;
    const { location } = options;
    if (!location) throw new ServiceError('unsupported', `Start at login is not supported on ${process.platform}.`);
    const manager = options.manager ?? [MANAGER_BIN[location.platform]];
    const cwd = appDir ?? options.appDir ?? APP_DIR;
    const entry = appDir ? path.join(appDir, 'src', 'server', 'main.ts') : (options.entry ?? SERVICE_ENTRY);
    const run = options.run;
    if (enabled) {
      // PATH is this machine's, so it is searched the host's way (tests simulate other platforms' files).
      const host = options.hostPlatform ?? process.platform;
      const node = await checkNode({ env: withCleanSearchPath(options.env, host), platform: host, cwd, ...(run ? { run } : {}) });
      const target = serviceTarget({
        location,
        nodePath: node.path,
        env: options.env,
        carried: options.carried,
        address: options.address,
        appDir: cwd,
        entry,
        uid: options.uid === undefined ? currentUid() : options.uid,
      });
      await executePlan(installPlan(target), { manager, cwd, env: options.env, ...(run ? { run } : {}) });
    } else if ((await this.status()).startAtLogin) {
      const plan = uninstallPlan({ ...location, uid: options.uid === undefined ? currentUid() : options.uid });
      await executePlan(plan, { manager, cwd, env: options.env, ...(run ? { run } : {}) });
    }
    const status = await this.status();
    await options.settings?.set(START_AT_LOGIN_SETTING, status.startAtLogin);
    return status;
  }
}

/**
 * The real service of a running Switchboard (main.ts): this OS, the real home
 * (or the test redirect), the configured data folder, and the running
 * configuration carried into the service.
 */
export function createLoginService(options: {
  readonly config: ServerConfig;
  readonly settings: SettingRepository;
  readonly redirect: ServiceRedirect | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}): LoginService {
  const env = options.env ?? process.env;
  const location = serviceLocation({ platform: options.platform ?? process.platform, dataDir: options.config.dataDir, env, redirect: options.redirect });
  return new LoginService({
    location,
    ...(options.redirect ? { manager: options.redirect.manager } : {}),
    env,
    carried: carriedEnvironment(options.config),
    address: `${options.config.host}:${options.config.port}`,
    settings: options.settings,
  });
}
