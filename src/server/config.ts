import os from 'node:os';
import path from 'node:path';

/** The only address Switchboard ever binds to. Not configurable (ARCHITECTURE → Security). */
export const LOOPBACK_HOST = '127.0.0.1';

/** Default HTTP port of the real app. Tests use 4871–4879 instead. */
export const DEFAULT_PORT = 4870;

/** Runtime configuration, read once at startup from environment variables. */
export interface ServerConfig {
  /** Always {@link LOOPBACK_HOST}. */
  readonly host: typeof LOOPBACK_HOST;
  /** `SWITCHBOARD_PORT`, default {@link DEFAULT_PORT}. */
  readonly port: number;
  /** `SWITCHBOARD_DATA_DIR`, default: the per-user app-data folder (decisions gap #18). Absolute. */
  readonly dataDir: string;
  /** `SWITCHBOARD_WORKSPACE_ROOT`, absolute; `null` when not configured yet (no default). */
  readonly workspaceRoot: string | null;
  /** `SWITCHBOARD_CLAUDE_BIN` as an argv prefix, default `["claude"]`. */
  readonly claudeCommand: readonly string[];
  /**
   * `SWITCHBOARD_CLAUDE_EXTRA_ARGS`: dev-only flags appended to every supervised
   * `claude` spawn (a JSON array, e.g. `["--model","haiku","--max-turns","3"]` for the
   * D13 real-CLI smoke). Default none.
   */
  readonly claudeExtraArgs: readonly string[];
  /** `SWITCHBOARD_GH_BIN` as an argv prefix, default `["gh"]`. */
  readonly ghCommand: readonly string[];
  /** `SWITCHBOARD_DEMO=1` loads the demo seed (decisions gap #21). Anything else = off. */
  readonly demo: boolean;
}

/** Thrown when an environment variable has an unusable value. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Per-user app-data folder for the database and the token (decisions gap #18,
 * ARCHITECTURE → Security): macOS `~/Library/Application Support/Switchboard`,
 * Windows `%LOCALAPPDATA%\Switchboard`, Linux `$XDG_DATA_HOME/switchboard`
 * (default `~/.local/share/switchboard`).
 */
export function defaultDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (platform === 'darwin') {
    return path.posix.join(home, 'Library', 'Application Support', 'Switchboard');
  }
  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'];
    const base = localAppData && path.win32.isAbsolute(localAppData)
      ? localAppData
      : path.win32.join(home, 'AppData', 'Local');
    return path.win32.join(base, 'Switchboard');
  }
  const xdg = env['XDG_DATA_HOME'];
  const base = xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(home, '.local', 'share');
  return path.posix.join(base, 'switchboard');
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) throw new ConfigError(`SWITCHBOARD_PORT must be an integer, got "${raw}"`);
  const port = Number(text);
  if (port < 1 || port > 65535) throw new ConfigError(`SWITCHBOARD_PORT must be 1-65535, got ${port}`);
  return port;
}

/**
 * A CLI command is a plain executable (`claude`, `/opt/bin/gh`) or, when the value
 * starts with `[`, a JSON array used as an argv prefix (for example
 * `["/usr/local/bin/node","/repo/tools/fake-claude/main.ts"]`). It is always spawned
 * with `shell: false`, so no shell parsing ever happens.
 */
export function parseCommand(name: string, raw: string | undefined, fallback: string): string[] {
  if (raw === undefined || raw.trim() === '') return [fallback];
  const text = raw.trim();
  if (!text.startsWith('[')) return [text];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError(`${name} starts with "[" but is not a JSON array`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((part) => typeof part === 'string' && part !== '')) {
    throw new ConfigError(`${name} must be a non-empty JSON array of non-empty strings`);
  }
  return parsed as string[];
}

/**
 * A list of CLI arguments as a JSON array of non-empty strings (never shell-parsed).
 * Unset or blank = none.
 * @throws {ConfigError} on anything else.
 */
export function parseArgList(name: string, raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new ConfigError(`${name} must be a JSON array of strings`);
  }
  if (!Array.isArray(parsed) || !parsed.every((part) => typeof part === 'string' && part !== '')) {
    throw new ConfigError(`${name} must be a JSON array of non-empty strings`);
  }
  return parsed as string[];
}

function parseDir(raw: string | undefined, cwd: string): string | null {
  if (raw === undefined || raw.trim() === '') return null;
  return path.resolve(cwd, raw.trim());
}

/** Options for {@link loadConfig}; every field defaults to the current process. */
export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  cwd?: string;
}

/**
 * Reads the configuration from environment variables. There is deliberately no
 * host setting: the bind address is fixed to {@link LOOPBACK_HOST}.
 * @throws {ConfigError} on an invalid value.
 */
export function loadConfig(options: LoadConfigOptions = {}): ServerConfig {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  return {
    host: LOOPBACK_HOST,
    port: parsePort(env['SWITCHBOARD_PORT']),
    dataDir: parseDir(env['SWITCHBOARD_DATA_DIR'], cwd) ?? defaultDataDir(platform, env, home),
    workspaceRoot: parseDir(env['SWITCHBOARD_WORKSPACE_ROOT'], cwd),
    claudeCommand: parseCommand('SWITCHBOARD_CLAUDE_BIN', env['SWITCHBOARD_CLAUDE_BIN'], 'claude'),
    claudeExtraArgs: parseArgList('SWITCHBOARD_CLAUDE_EXTRA_ARGS', env['SWITCHBOARD_CLAUDE_EXTRA_ARGS']),
    ghCommand: parseCommand('SWITCHBOARD_GH_BIN', env['SWITCHBOARD_GH_BIN'], 'gh'),
    demo: env['SWITCHBOARD_DEMO'] === '1',
  };
}
