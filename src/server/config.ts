import os from 'node:os';
import path from 'node:path';

/** The only address Switchboard ever binds to. Not configurable (ARCHITECTURE → Security). */
export const LOOPBACK_HOST = '127.0.0.1';

/** Default HTTP port of the real app. Tests use 4871–4879 instead. */
export const DEFAULT_PORT = 13001;

/** Runtime configuration, read once at startup from environment variables. */
export interface ServerConfig {
  /** Always {@link LOOPBACK_HOST}. */
  readonly host: typeof LOOPBACK_HOST;
  /** `SWITCHBOARD_PORT`, default {@link DEFAULT_PORT}. */
  readonly port: number;
  /**
   * `SWITCHBOARD_DATA_DIR`, default: the per-user app-data folder (decisions gap #18). Absolute.
   * (D14: there is no workspace setting; sessions start in saved folders, `docs/folders.md`.)
   */
  readonly dataDir: string;
  /** `SWITCHBOARD_CLAUDE_BIN` as an argv prefix, default `["claude"]`. */
  readonly claudeCommand: readonly string[];
  /**
   * `SWITCHBOARD_CLAUDE_EXTRA_ARGS`: dev-only flags appended to every supervised
   * `claude` spawn (a JSON array, e.g. `["--model","haiku","--max-turns","3"]` for the
   * D13 real-CLI smoke). Default none.
   */
  readonly claudeExtraArgs: readonly string[];
  /** D62: `SWITCHBOARD_CODEX_BIN` as an argv prefix, default `["codex"]` (Settings → CLIs may override it). */
  readonly codexCommand: readonly string[];
  /** D62: `SWITCHBOARD_OPENCODE_BIN` as an argv prefix, default `["opencode"]` (Settings → CLIs may override it). */
  readonly opencodeCommand: readonly string[];
  /** `SWITCHBOARD_GH_BIN` as an argv prefix, default `["gh"]`. */
  readonly ghCommand: readonly string[];
  /** `SWITCHBOARD_DEMO=1` loads the demo seed (decisions gap #21). Anything else = off. */
  readonly demo: boolean;
  /**
   * D35 (`docs/frame-helper.md` → *Guided setup*): `SWITCHBOARD_OPEN_COMMAND`, an
   * argv prefix put in front of the OS opener the frame-helper setup runs (`open …`,
   * `explorer …`, `xdg-open …`, Chrome), so that command becomes its arguments.
   * Tests point it at `tools/fake-opener`, which records them and opens nothing.
   * Default `null`: the opener runs itself.
   */
  readonly openCommand: readonly string[] | null;
  /**
   * D48 (`docs/peers.md`): `SWITCHBOARD_TAILSCALE_BIN` as an argv prefix, default
   * `["tailscale"]`: `tailscale ip -4` gives the address the optional peer listener
   * binds. Tests point it at `tools/fake-tailscale`.
   */
  readonly tailscaleCommand: readonly string[];
  /**
   * D48, **tests only**: `SWITCHBOARD_PEER_TEST_LOOPBACK=1` lets the peer listener
   * bind 127.0.0.1 (two test servers on one machine act as peers). Without it the
   * peer listener binds only a Tailscale address (100.64.0.0/10).
   */
  readonly peerTestLoopback: boolean;
  /**
   * Fix · peer reconnects (`docs/peers.md` → *Connection states*): the peer
   * connections' grace period, stall limit and hold time, from
   * `SWITCHBOARD_PEER_GRACE_MS`, `SWITCHBOARD_PEER_STALL_MS` and
   * `SWITCHBOARD_PEER_HOLD_MS` (whole milliseconds, 100–600000); unset = the
   * defaults. Meant for tests and tuning.
   */
  readonly peerTimings: { readonly graceMs?: number; readonly stallMs?: number; readonly holdMs?: number };
  /**
   * Fix · peer reconnects, **tests only**: `SWITCHBOARD_PEER_TEST_HOOKS=1` adds
   * `POST /api/test/peers/drop` (cut the peers' open streams) and
   * `POST|DELETE /api/test/peers/outage` (stop the peer listener for a while).
   */
  readonly peerTestHooks: boolean;
  /**
   * D73, **tests only**: `SWITCHBOARD_DEVICE_TEST_ORIGIN` (`http://localhost:<port>`
   * or `http://127.0.0.1:<port>`) is the devices' origin instead of the
   * `https://<machine>.<tailnet>.ts.net` one `tailscale status` gives, so a test
   * browser reaches the device listener directly. `null` = the real origin.
   */
  readonly deviceTestOrigin: string | null;
  /**
   * D73, **tests only**: `SWITCHBOARD_PUSH_TEST_ENDPOINTS`, a comma list of
   * `http://127.0.0.1:<port>` origins accepted as Web Push endpoints next to the
   * browser vendors' push services (the fake push service). Default none.
   */
  readonly pushTestEndpoints: readonly string[];
}

/** D73: a test origin of the device listener (loopback http with a port), else a {@link ConfigError}. */
function parseDeviceTestOrigin(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null;
  const match = /^http:\/\/(localhost|127\.0\.0\.1):(\d{1,5})$/.exec(raw.trim());
  if (!match) throw new ConfigError('SWITCHBOARD_DEVICE_TEST_ORIGIN must be http://localhost:<port> or http://127.0.0.1:<port>');
  return `http://${match[1]}:${match[2]}`;
}

/** D73: the test push endpoints' origins (loopback http with a port), else a {@link ConfigError}. */
function parsePushTestEndpoints(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw.split(',').map((part) => {
    const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/.exec(part.trim());
    if (!match) throw new ConfigError('SWITCHBOARD_PUSH_TEST_ENDPOINTS must be a comma list of http://127.0.0.1:<port>');
    return `http://127.0.0.1:${match[1]}`;
  });
}

/** A millisecond setting of the peer timings; `undefined` when unset. */
function parsePeerMs(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 100 || value > 600_000) throw new ConfigError(`${name} must be whole milliseconds between 100 and 600000`);
  return value;
}

function parsePeerTimings(env: NodeJS.ProcessEnv): ServerConfig['peerTimings'] {
  const graceMs = parsePeerMs('SWITCHBOARD_PEER_GRACE_MS', env['SWITCHBOARD_PEER_GRACE_MS']);
  const stallMs = parsePeerMs('SWITCHBOARD_PEER_STALL_MS', env['SWITCHBOARD_PEER_STALL_MS']);
  const holdMs = parsePeerMs('SWITCHBOARD_PEER_HOLD_MS', env['SWITCHBOARD_PEER_HOLD_MS']);
  return { ...(graceMs === undefined ? {} : { graceMs }), ...(stallMs === undefined ? {} : { stallMs }), ...(holdMs === undefined ? {} : { holdMs }) };
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
    claudeCommand: parseCommand('SWITCHBOARD_CLAUDE_BIN', env['SWITCHBOARD_CLAUDE_BIN'], 'claude'),
    claudeExtraArgs: parseArgList('SWITCHBOARD_CLAUDE_EXTRA_ARGS', env['SWITCHBOARD_CLAUDE_EXTRA_ARGS']),
    codexCommand: parseCommand('SWITCHBOARD_CODEX_BIN', env['SWITCHBOARD_CODEX_BIN'], 'codex'),
    opencodeCommand: parseCommand('SWITCHBOARD_OPENCODE_BIN', env['SWITCHBOARD_OPENCODE_BIN'], 'opencode'),
    ghCommand: parseCommand('SWITCHBOARD_GH_BIN', env['SWITCHBOARD_GH_BIN'], 'gh'),
    demo: env['SWITCHBOARD_DEMO'] === '1',
    openCommand: env['SWITCHBOARD_OPEN_COMMAND']?.trim() ? parseCommand('SWITCHBOARD_OPEN_COMMAND', env['SWITCHBOARD_OPEN_COMMAND'], '') : null,
    tailscaleCommand: parseCommand('SWITCHBOARD_TAILSCALE_BIN', env['SWITCHBOARD_TAILSCALE_BIN'], 'tailscale'),
    peerTestLoopback: env['SWITCHBOARD_PEER_TEST_LOOPBACK'] === '1',
    peerTimings: parsePeerTimings(env),
    peerTestHooks: env['SWITCHBOARD_PEER_TEST_HOOKS'] === '1',
    deviceTestOrigin: parseDeviceTestOrigin(env['SWITCHBOARD_DEVICE_TEST_ORIGIN']),
    pushTestEndpoints: parsePushTestEndpoints(env['SWITCHBOARD_PUSH_TEST_ENDPOINTS']),
  };
}
