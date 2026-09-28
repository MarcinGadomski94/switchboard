import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { MIN_NODE_MAJOR, parseNodeMajor } from '../../core/service-files.ts';
import { type RunResult, failureText, runCommand, succeeded } from '../exec.ts';
import { ServiceError } from './errors.ts';

/** The `node` the service will run. */
export interface NodeOnPath {
  /** Absolute path found on PATH. */
  readonly path: string;
  /** Its `--version` answer, e.g. `v24.21.0`. */
  readonly version: string;
}

/** Options for {@link findOnPath}. */
export interface FindOnPathOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** `true` when `file` is an executable file (default: a real check on disk). */
  readonly isExecutable?: (file: string, platform: NodeJS.Platform) => Promise<boolean>;
}

async function executableFile(file: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    if (platform !== 'win32') await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathValue(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return env['PATH'] ?? '';
  // Windows environment names are case-insensitive (`Path` is common).
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  return key ? (env[key] ?? '') : '';
}

/**
 * The first executable `name` on the PATH of `env` (absolute folders only), as
 * the OS would find it: on Windows every `PATHEXT` extension is tried in order.
 * `null` when there is none.
 */
export async function findOnPath(name: string, options: FindOnPathOptions): Promise<string | null> {
  const { env, platform } = options;
  const isExecutable = options.isExecutable ?? executableFile;
  const lib = platform === 'win32' ? path.win32 : path.posix;
  const folders = pathValue(env, platform)
    .split(platform === 'win32' ? ';' : ':')
    .map((folder) => folder.trim().replace(/^"(.*)"$/, '$1'))
    .filter((folder) => folder !== '' && lib.isAbsolute(folder));
  const extKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATHEXT');
  const exts =
    platform === 'win32'
      ? (extKey ? (env[extKey] ?? '') : '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map((ext) => ext.trim().toLowerCase())
          .filter((ext) => ext !== '')
      : [''];
  for (const folder of folders) {
    for (const ext of exts) {
      const candidate = lib.join(folder, `${name}${ext}`);
      if (await isExecutable(candidate, platform)) return candidate;
    }
  }
  return null;
}

/** Options for {@link checkNode}. */
export interface CheckNodeOptions extends FindOnPathOptions {
  /** Runs `<node> --version` (default: a real spawn, `shell: false`). */
  readonly run?: (command: readonly string[], args: readonly string[]) => Promise<RunResult>;
  /** Working folder for the version probe. */
  readonly cwd: string;
}

/**
 * The `node` on PATH, which must be ≥ {@link MIN_NODE_MAJOR} (the service runs
 * TypeScript through Node's type stripping).
 * @throws {ServiceError} `node-missing` or `node-too-old`.
 */
export async function checkNode(options: CheckNodeOptions): Promise<NodeOnPath> {
  const found = await findOnPath('node', options);
  if (!found) throw new ServiceError('node-missing', `Node.js ≥ ${MIN_NODE_MAJOR} must be on PATH: no node was found there.`);
  const run = options.run ?? ((command, args) => runCommand(command, args, { cwd: options.cwd, env: options.env, timeoutMs: 15_000 }));
  const result = await run([found], ['--version']);
  if (!succeeded(result)) throw new ServiceError('node-missing', `${found} --version failed: ${failureText(result)}`);
  const version = result.stdout.trim();
  const major = parseNodeMajor(version);
  if (major === null) throw new ServiceError('node-missing', `${found} --version answered "${version}", not a Node.js version.`);
  if (major < MIN_NODE_MAJOR) throw new ServiceError('node-too-old', `Node.js ≥ ${MIN_NODE_MAJOR} is required on PATH; ${found} is ${version}.`);
  return { path: found, version };
}
