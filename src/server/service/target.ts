import os from 'node:os';
import path from 'node:path';
import { MANAGER_BIN, type ServiceLocation, type ServicePlatform, type ServiceTarget, isServicePlatform } from '../../core/service-files.ts';
import { ConfigError, DEFAULT_PORT, type ServerConfig, defaultDataDir, parseCommand } from '../config.ts';

/** The repo folder (the service's working directory). */
export const APP_DIR = path.resolve(import.meta.dirname, '..', '..', '..');

/** `<repo>/src/server/main.ts`, the service's entry point. */
export const SERVICE_ENTRY = path.join(APP_DIR, 'src', 'server', 'main.ts');

/**
 * Test / dev redirects of the per-user service (`docs/service.md` → *Test
 * redirects*): `SWITCHBOARD_SERVICE_HOME` puts the service files under that
 * folder instead of the real home, and `SWITCHBOARD_SERVICE_CTL` (an argv prefix,
 * like `SWITCHBOARD_GH_BIN`) replaces launchctl / systemctl / schtasks. They are
 * set together or not at all, so a test can never write fake files and then
 * register them with the real service manager (or the other way round).
 */
export interface ServiceRedirect {
  readonly home: string;
  readonly manager: readonly string[];
}

/**
 * Reads the redirect variables.
 * @throws {ConfigError} when only one of them is set, or the home is not absolute.
 */
export function loadServiceRedirect(env: NodeJS.ProcessEnv = process.env): ServiceRedirect | null {
  const home = env['SWITCHBOARD_SERVICE_HOME']?.trim() ?? '';
  const ctl = env['SWITCHBOARD_SERVICE_CTL']?.trim() ?? '';
  if (home === '' && ctl === '') return null;
  if (home === '' || ctl === '') {
    throw new ConfigError('SWITCHBOARD_SERVICE_HOME and SWITCHBOARD_SERVICE_CTL are test redirects and must be set together');
  }
  if (!path.isAbsolute(home)) throw new ConfigError(`SWITCHBOARD_SERVICE_HOME must be an absolute path, got "${home}"`);
  return { home, manager: parseCommand('SWITCHBOARD_SERVICE_CTL', ctl, MANAGER_BIN.darwin) };
}

/** An argv prefix as the value of a `*_BIN` variable (`docs/configuration.md`). */
function commandValue(command: readonly string[]): string {
  const [first] = command;
  return command.length === 1 && first !== undefined && !first.trim().startsWith('[') ? first : JSON.stringify(command);
}

/**
 * The `SWITCHBOARD_*` variables the installed service starts with, from the
 * running configuration: the port, data folder and CLI commands when they differ
 * from the defaults (D14: no workspace variable; the saved folders live in the
 * database of that data folder). Never the dev-only
 * `SWITCHBOARD_CLAUDE_EXTRA_ARGS`, `SWITCHBOARD_DEMO` or the test redirects.
 * `realDataDir` = the per-user default the service would pick without a variable.
 */
export function carriedEnvironment(config: ServerConfig, realDataDir: string = defaultDataDir()): Record<string, string> {
  const env: Record<string, string> = {};
  if (config.port !== DEFAULT_PORT) env['SWITCHBOARD_PORT'] = String(config.port);
  if (path.resolve(config.dataDir) !== path.resolve(realDataDir)) env['SWITCHBOARD_DATA_DIR'] = config.dataDir;
  if (!(config.claudeCommand.length === 1 && config.claudeCommand[0] === 'claude')) env['SWITCHBOARD_CLAUDE_BIN'] = commandValue(config.claudeCommand);
  if (!(config.ghCommand.length === 1 && config.ghCommand[0] === 'gh')) env['SWITCHBOARD_GH_BIN'] = commandValue(config.ghCommand);
  return env;
}

/**
 * PATH for the service and for finding its `node`: absolute folders only, first
 * occurrence kept, and without the folders npm prepends while it runs a script
 * (every `node_modules/.bin` up the tree and `@npmcli/run-script/lib/node-gyp-bin`),
 * which would otherwise be written into the unit when it is installed from
 * `npm start` / `npm run service:install`.
 */
export function cleanSearchPath(value: string, platform: NodeJS.Platform): string {
  const lib = platform === 'win32' ? path.win32 : path.posix;
  const sep = platform === 'win32' ? ';' : ':';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(sep)) {
    const entry = raw.trim();
    const bare = entry.replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
    if (!bare || !lib.isAbsolute(bare)) continue;
    const parts = bare.split(/[\\/]/);
    if (parts.at(-1) === '.bin' && parts.at(-2) === 'node_modules') continue;
    if (/[\\/]@npmcli[\\/]run-script[\\/]lib[\\/]node-gyp-bin$/.test(bare)) continue;
    const key = platform === 'win32' ? bare.toLowerCase() : bare;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.join(sep);
}

/** `env` with its PATH (any case on Windows) replaced by {@link cleanSearchPath}. */
export function withCleanSearchPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((name) => (platform === 'win32' ? name.toUpperCase() === 'PATH' : name === 'PATH'));
  if (!key) return env;
  return { ...env, [key]: cleanSearchPath(env[key] ?? '', platform) };
}

/** Where this machine's service files go (`null` on an unsupported OS). */
export function serviceLocation(options: {
  readonly platform: NodeJS.Platform;
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly redirect: ServiceRedirect | null;
  readonly home?: string;
}): ServiceLocation | null {
  const { platform } = options;
  if (!isServicePlatform(platform)) return null;
  const home = options.redirect?.home ?? options.home ?? os.homedir();
  const xdg = options.env['XDG_CONFIG_HOME'];
  // A redirect ignores XDG_CONFIG_HOME, so tests never write into the real config folder.
  const xdgConfigHome = !options.redirect && platform === 'linux' && xdg && path.posix.isAbsolute(xdg) ? xdg : null;
  return { platform, home, dataDir: options.dataDir, xdgConfigHome };
}

/** The Windows account of the logon trigger: `USERDOMAIN\USERNAME` (else the OS user name). */
export function windowsUser(env: NodeJS.ProcessEnv): string {
  const name = env['USERNAME']?.trim() || os.userInfo().username;
  const domain = env['USERDOMAIN']?.trim();
  return domain ? `${domain}\\${name}` : name;
}

/** The numeric user id for `launchctl` (`gui/<uid>`); `null` where there is none. */
export function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/** Builds the full target of a location once `node` is known. */
export function serviceTarget(options: {
  readonly location: ServiceLocation;
  readonly nodePath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly carried: Readonly<Record<string, string>>;
  readonly address: string;
  readonly appDir?: string;
  readonly entry?: string;
  readonly uid?: number | null;
}): ServiceTarget {
  const { location } = options;
  const platform: ServicePlatform = location.platform;
  const raw = platform === 'win32' ? undefined : options.env['PATH'];
  const searchPath = raw === undefined ? null : cleanSearchPath(raw, platform) || null;
  return {
    ...location,
    nodePath: options.nodePath,
    appDir: options.appDir ?? APP_DIR,
    entry: options.entry ?? SERVICE_ENTRY,
    env: options.carried,
    searchPath,
    uid: platform === 'darwin' ? (options.uid === undefined ? currentUid() : options.uid) : null,
    user: platform === 'win32' ? windowsUser(options.env) : null,
    address: options.address,
  };
}
