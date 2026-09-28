import { type ChildProcess, spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FrameHelperInfo } from '../../core/api.ts';
import { APP_DIR } from '../service/target.ts';

/*
 * D35 (`docs/frame-helper.md` → *Guided setup*): the service's part of the guided
 * frame-helper setup. A browser never lets a page install an extension, and a page
 * cannot open `chrome://` URLs or the OS file manager, so the service runs the OS
 * openers for the two steps around Chrome's "Load unpacked" click. Every command is
 * a fixed argv built here (the folder of this checkout, `chrome://extensions`);
 * nothing comes from a request. Spawned with `shell: false` only.
 */

/** `tools/frame-helper` in the checkout the service runs from: the folder Chrome's "Load unpacked" takes. */
export const FRAME_HELPER_DIR = path.join(APP_DIR, 'tools', 'frame-helper');

/** The page the "Open Chrome's extensions page" step opens. */
export const EXTENSIONS_URL = 'chrome://extensions';

/**
 * How long a launched opener may run before it counts as started. `open`,
 * `explorer` and `xdg-open` hand over and exit at once; a browser binary that was
 * not running yet (Linux, Windows) keeps running as the browser, and is left to run.
 */
export const LAUNCH_GRACE_MS = 2_000;

/** The folder path and the manifest's version (`GET /api/frame-helper`). Async: it runs on a request. */
export async function readFrameHelperInfo(dir: string = FRAME_HELPER_DIR): Promise<FrameHelperInfo> {
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as { version?: unknown };
  if (typeof manifest.version !== 'string' || manifest.version.trim() === '') throw new Error(`${path.join(dir, 'manifest.json')} has no version`);
  return { path: dir, version: manifest.version };
}

/** One OS command the setup runs. */
export interface OpenCommand {
  /** The full argv, the executable first (before any `SWITCHBOARD_OPEN_COMMAND` prefix). */
  readonly argv: readonly string[];
  /** `explorer.exe` exits with 1 even when it opened the window: any exit code counts as done. */
  readonly anyExitCode?: boolean;
}

/** `path.join` of `platform`, so a test can build the Windows form on any OS. */
function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === 'win32' ? path.win32.join(...parts) : path.posix.join(...parts);
}

/**
 * The "Reveal in Finder" command for `platform`: macOS `open -R <dir>/manifest.json`
 * (Finder opens the folder with the manifest selected); Windows `explorer /select,
 * <dir>\manifest.json` (two arguments, so a path with spaces is quoted on its own);
 * elsewhere `xdg-open <dir>` (the file manager on the folder).
 */
export function revealCommand(platform: NodeJS.Platform, dir: string): OpenCommand {
  if (platform === 'darwin') return { argv: ['open', '-R', joinFor(platform, dir, 'manifest.json')] };
  if (platform === 'win32') return { argv: ['explorer', '/select,', joinFor(platform, dir, 'manifest.json')], anyExitCode: true };
  return { argv: ['xdg-open', dir] };
}

/** Where Chrome's installer puts `chrome.exe` on Windows (machine-wide, 32-bit, per-user), from `env`. */
export function windowsChromePaths(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const name of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']) {
    const base = env[name]?.trim();
    if (!base || !path.win32.isAbsolute(base)) continue;
    const exe = path.win32.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe');
    if (!out.some((known) => known.toLowerCase() === exe.toLowerCase())) out.push(exe);
  }
  return out;
}

/**
 * The "Open Chrome's extensions page" commands for `platform`, tried in order until
 * one works: macOS `open -a "Google Chrome" chrome://extensions`; Windows each
 * `chrome.exe` of {@link windowsChromePaths} that exists, then `cmd /c start ""
 * chrome chrome://extensions` (an argv array: `start` resolves Chrome's registered
 * app path); elsewhere `google-chrome`, then `chromium`.
 */
export async function extensionsCommands(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (file: string) => Promise<boolean> = fileExists,
): Promise<OpenCommand[]> {
  if (platform === 'darwin') return [{ argv: ['open', '-a', 'Google Chrome', EXTENSIONS_URL] }];
  if (platform === 'win32') {
    const found: OpenCommand[] = [];
    for (const exe of windowsChromePaths(env)) {
      if (await exists(exe)) found.push({ argv: [exe, EXTENSIONS_URL] });
    }
    return [...found, { argv: ['cmd', '/c', 'start', '', 'chrome', EXTENSIONS_URL] }];
  }
  return [{ argv: ['google-chrome', EXTENSIONS_URL] }, { argv: ['chromium', EXTENSIONS_URL] }];
}

/** `true` when `file` exists (async). */
export async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** How one launch went. */
export interface LaunchOutcome {
  readonly ok: boolean;
  /** Why it failed (`<argv>: <stderr, or how it ended>`); `null` when it worked. */
  readonly error: string | null;
}

/** Options for {@link launch}. */
export interface LaunchOptions {
  /** `SWITCHBOARD_OPEN_COMMAND`: an argv prefix run instead, with the command's argv as its arguments. */
  readonly prefix?: readonly string[] | null;
  readonly env?: NodeJS.ProcessEnv;
  /** Default {@link LAUNCH_GRACE_MS}. */
  readonly graceMs?: number;
}

/**
 * Runs `command` detached (`shell: false`, no stdin/stdout, stderr read for the
 * error text). It worked when it exits 0 (any code for `anyExitCode`) or is still
 * running after `graceMs` (then it is left to run on its own: it is the app it
 * opened). It failed when it cannot start (e.g. `ENOENT`) or exits otherwise.
 * Never throws.
 */
export function launch(command: OpenCommand, options: LaunchOptions = {}): Promise<LaunchOutcome> {
  const label = command.argv.join(' ');
  const [cmd, ...args] = [...(options.prefix ?? []), ...command.argv];
  if (!cmd) return Promise.resolve({ ok: false, error: 'empty command' });
  return new Promise<LaunchOutcome>((resolve) => {
    let settled = false;
    let stderr = '';
    let grace: NodeJS.Timeout | undefined;
    const finish = (outcome: LaunchOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(grace);
      resolve(outcome);
    };
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        shell: false,
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        env: options.env ?? process.env,
      });
    } catch (error) {
      finish({ ok: false, error: `${label}: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    const started = child;
    started.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < 4_096) stderr += chunk;
    });
    grace = setTimeout(() => {
      // Still running: the app itself (a browser that was not open yet). Leave it be.
      started.stderr?.destroy();
      started.unref();
      finish({ ok: true, error: null });
    }, options.graceMs ?? LAUNCH_GRACE_MS);
    started.once('error', (error) => finish({ ok: false, error: `${label}: ${error.message}` }));
    started.once('exit', (code, signal) => {
      if (code === 0 || (command.anyExitCode === true && code !== null)) {
        finish({ ok: true, error: null });
        return;
      }
      // Its last words may still be in the pipe: read them before answering.
      const fail = (): void => {
        const text = stderr.trim().split('\n').slice(-3).join(' ').trim();
        finish({ ok: false, error: `${label}: ${text || (signal ? `killed by ${signal}` : `exit code ${String(code)}`)}` });
      };
      const pipe = started.stderr;
      if (!pipe || pipe.readableEnded || pipe.destroyed) fail();
      else {
        pipe.once('close', fail);
        setTimeout(fail, 200).unref();
      }
    });
  });
}

/** Thrown by {@link FrameHelperOpener} when every command for a step failed; `message` names each failure. */
export class OpenFailedError extends Error {
  override name = 'OpenFailedError';
}

/** The two steps the service runs (`POST /api/frame-helper/reveal`, `/open-extensions`). */
export interface FrameHelperOpener {
  /** Opens the OS file manager on the frame helper's folder. Rejects with {@link OpenFailedError}. */
  reveal(): Promise<void>;
  /** Opens `chrome://extensions` in Chrome. Rejects with {@link OpenFailedError}. */
  openExtensions(): Promise<void>;
}

/** Options for {@link createFrameHelperOpener}; each defaults to this process and this checkout. */
export interface FrameHelperOpenerOptions {
  /** Default {@link FRAME_HELPER_DIR}. */
  readonly dir?: string;
  /** Picks the commands (tests inject each OS). Default `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** `SWITCHBOARD_OPEN_COMMAND` (`ServerConfig.openCommand`); `null` = run the commands themselves. */
  readonly prefix?: readonly string[] | null;
  readonly env?: NodeJS.ProcessEnv;
  /** Whether a file exists (Windows' `chrome.exe` paths). Default: the file system. */
  readonly exists?: (file: string) => Promise<boolean>;
  readonly graceMs?: number;
}

/**
 * The frame-helper setup's openers (D35): each step runs its commands in order
 * until one works ({@link launch}), and rejects with every failure otherwise.
 */
export function createFrameHelperOpener(options: FrameHelperOpenerOptions = {}): FrameHelperOpener {
  const dir = options.dir ?? FRAME_HELPER_DIR;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const launchOptions: LaunchOptions = { prefix: options.prefix ?? null, env, ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }) };
  const runFirst = async (commands: readonly OpenCommand[]): Promise<void> => {
    const errors: string[] = [];
    for (const command of commands) {
      const outcome = await launch(command, launchOptions);
      if (outcome.ok) return;
      errors.push(outcome.error ?? command.argv.join(' '));
    }
    throw new OpenFailedError(errors.join('; '));
  };
  return {
    reveal: () => runFirst([revealCommand(platform, dir)]),
    openExtensions: async () => runFirst(await extensionsCommands(platform, env, options.exists)),
  };
}
