import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ServerConfig } from '../config.ts';
import type { SettingRepository } from '../db/repos/settings.ts';
import type { HubBus } from '../hub/bus.ts';
import type { LoginService } from '../service/login-service.ts';
import { APP_DIR, type ServiceRedirect, currentUid, serviceLocation } from '../service/target.ts';
import type { UpdateConfig } from './config.ts';
import { GitHubReleases } from './github.ts';
import { detectInstallKind, updatePaths } from './install.ts';
import { npmCi, resolveNpm } from './npm.ts';
import { type RestartEnvironment, defaultManager, detectRestartMode, restartIntoService } from './restart.ts';
import { type UpdateItems, UpdateService } from './service.ts';

/** The version in `<appDir>/package.json` (startup read). */
export async function appVersion(appDir: string = APP_DIR): Promise<string> {
  const parsed = JSON.parse(await readFile(path.join(appDir, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof parsed.version !== 'string') throw new Error(`${appDir}/package.json has no version`);
  return parsed.version;
}

/**
 * The real updater of a running Switchboard (main.ts, D55): this install's
 * folder, version and kind, GitHub releases of the configured repository (the
 * REST API, then `gh` through `SWITCHBOARD_GH_BIN`), `npm ci` through the npm
 * next to this node (or `SWITCHBOARD_NPM_BIN`), the login service of this OS
 * (or the test redirect) as the pointer and the restart.
 */
export async function createUpdateService(options: {
  readonly config: ServerConfig;
  readonly update: UpdateConfig;
  readonly settings: SettingRepository;
  readonly bus: HubBus;
  readonly items: UpdateItems;
  readonly loginService: LoginService;
  readonly redirect: ServiceRedirect | null;
  readonly liveSessions: () => number;
  /** Closes this Switchboard the normal way and exits 0 (the SIGTERM path). */
  readonly exit: () => void;
  readonly appDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<UpdateService> {
  const env = options.env ?? process.env;
  const appDir = options.appDir ?? APP_DIR;
  const current = await appVersion(appDir);
  const kind = options.update.testInstallKind ?? (await detectInstallKind(appDir));
  const paths = updatePaths(options.config.dataDir);
  const location = serviceLocation({ platform: process.platform, dataDir: options.config.dataDir, env, redirect: options.redirect });
  const restartEnv: RestartEnvironment = {
    location,
    manager: options.redirect?.manager ?? defaultManager(location),
    env,
    pid: process.pid,
    execArgv: process.execArgv,
    uid: currentUid(),
    testUnderService: options.update.testUnderService,
  };
  const service = new UpdateService({
    appDir,
    current,
    kind,
    repo: options.update.repo,
    paths,
    source: new GitHubReleases({
      repo: options.update.repo,
      testOrigin: options.update.testOrigin,
      ghCommand: options.config.ghCommand,
      userAgent: `switchboard/${current}`,
      cwd: options.config.dataDir,
      env,
    }),
    npmCi: async (dir) => {
      const npm = await resolveNpm({ override: options.update.npmCommand, env });
      if (!npm) return { code: null, signal: null, stdout: '', stderr: 'npm was not found next to this node (set SWITCHBOARD_NPM_BIN)', error: new Error('npm not found'), timedOut: false };
      return npmCi(npm, dir, env);
    },
    restartMode: () => detectRestartMode(restartEnv),
    restart: () => restartIntoService({ ...restartEnv, exit: options.exit, log: paths.log }),
    service: location
      ? {
          registered: async () => (await options.loginService.status()).startAtLogin,
          pointTo: (dir) => options.loginService.pointTo(dir),
        }
      : null,
    settings: options.settings,
    bus: options.bus,
    items: options.items,
    liveSessions: options.liveSessions,
  });
  await service.init();
  return service;
}
