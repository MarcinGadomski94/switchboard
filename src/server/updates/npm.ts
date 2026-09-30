import { stat } from 'node:fs/promises';
import path from 'node:path';
import { type RunResult, runCommand } from '../exec.ts';

/**
 * `npm ci --omit=dev` in a staged release (D55, `docs/updates.md` →
 * *Installing*). npm is run as `node <npm-cli.js>` wherever that file can be
 * found: on Windows `npm` is `npm.cmd`, which Node refuses to spawn without a
 * shell, and the service never runs one (AGENTS.md: `shell: false` only).
 */

/** The only command the updater runs from a downloaded package (besides starting it). */
export const NPM_CI_ARGS: readonly string[] = ['ci', '--omit=dev', '--no-audit', '--no-fund'];

/** Time limit of `npm ci`. */
export const NPM_CI_TIMEOUT_MS = 15 * 60_000;

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * The places `npm-cli.js` is looked for, in order: `npm_execpath` (set when
 * Switchboard was started through `npm start`), then next to this `node`: the
 * Windows installer's `<node dir>\node_modules\npm\bin\npm-cli.js`, and on
 * macOS / Linux `<prefix>/lib/node_modules/npm/bin/npm-cli.js`.
 */
export function npmCliCandidates(execPath: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const lib = platform === 'win32' ? path.win32 : path.posix;
  const out: string[] = [];
  const fromNpm = env['npm_execpath'];
  if (fromNpm && /npm-cli\.js$/.test(fromNpm) && lib.isAbsolute(fromNpm)) out.push(fromNpm);
  const dir = lib.dirname(execPath);
  if (platform === 'win32') out.push(lib.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  else out.push(lib.join(lib.dirname(dir), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  return out;
}

/**
 * The npm command as an argv prefix: `override` (`SWITCHBOARD_NPM_BIN`) when
 * set, else `[node, <npm-cli.js>]` from {@link npmCliCandidates}, else plain
 * `npm` on macOS / Linux; `null` on Windows when no `npm-cli.js` was found.
 */
export async function resolveNpm(options: {
  readonly override?: readonly string[] | null;
  readonly execPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly exists?: (file: string) => Promise<boolean>;
}): Promise<string[] | null> {
  if (options.override && options.override.length > 0) return [...options.override];
  const execPath = options.execPath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? isFile;
  for (const candidate of npmCliCandidates(execPath, options.env ?? process.env, platform)) {
    if (await exists(candidate)) return [execPath, candidate];
  }
  return platform === 'win32' ? null : ['npm'];
}

/**
 * The environment of `npm ci`: this process's, without the `npm_*` variables
 * of the `npm start` that may have started it (they describe that run), and
 * with npm's update notice, funding and audit messages off.
 */
export function npmEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^npm_/i.test(key)) out[key] = value;
  }
  return { ...out, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
}

/** Runs `npm ci --omit=dev` in `dir`. Never throws: the result says how it went. */
export function npmCi(command: readonly string[], dir: string, env: NodeJS.ProcessEnv = process.env, timeoutMs: number = NPM_CI_TIMEOUT_MS): Promise<RunResult> {
  return runCommand(command, NPM_CI_ARGS, { cwd: dir, env: npmEnvironment(env), timeoutMs, maxOutputBytes: 16 * 1024 * 1024 });
}
