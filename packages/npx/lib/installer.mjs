// @ts-check
/**
 * The installer behind `npx @marcingadomski94/switchboard` (docs/publishing.md): the
 * same steps as the repo's install.sh / install.ps1, in Node, so it runs on macOS,
 * Linux and Windows. It downloads a GitHub release of Switchboard and its .sha256,
 * verifies the checksum (nothing is unpacked on a mismatch), unpacks it into
 * `<dir>/switchboard-<version>` (the manual install's layout, which the in-app
 * updater takes over from: docs/updates.md), runs `npm ci --omit=dev`, optionally
 * registers the login service and starts Switchboard.
 *
 * Plain JavaScript with no dependencies: Node does not strip types under
 * node_modules, and a launcher should install nothing but Switchboard. The pure
 * helpers are exported for tests (`tests/tools/installer.test.ts`).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, openSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

/** The repository releases come from (`owner/name`); `SWITCHBOARD_UPDATE_REPO` overrides it, as for the updater. */
export const DEFAULT_REPO = 'MarcinGadomski94/switchboard';
/** The port Switchboard listens on unless `SWITCHBOARD_PORT` says otherwise. */
export const DEFAULT_PORT = 13001;
/** The file in the install folder that says which version this installer installed. */
export const MARKER_NAME = '.switchboard-install';

/**
 * @typedef {object} Options
 * @property {string | null} dir
 * @property {string | null} version
 * @property {'ask' | 'yes' | 'no'} service
 * @property {boolean} start
 * @property {boolean} uninstall
 * @property {boolean} purge
 * @property {boolean} help
 */

/**
 * Reads the command line (`--dir`, `--version`, `--service`, `--no-service`,
 * `--no-start`, `--uninstall`, `--purge`, `--help`).
 * @param {readonly string[]} argv
 * @returns {Options | string} the options, or the problem
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const out = { dir: null, version: null, service: 'ask', start: true, uninstall: false, purge: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = /** @type {string} */ (argv[i]);
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    const inline = arg.startsWith('--') && eq > 0 ? arg.slice(eq + 1) : null;
    const value = () => {
      const next = inline ?? argv[++i];
      if (next === undefined || next === '') throw new Error(`${name} needs a value`);
      return next;
    };
    try {
      if (name === '--dir') out.dir = value();
      else if (name === '--version') out.version = value();
      else if (name === '--service') out.service = 'yes';
      else if (name === '--no-service') out.service = 'no';
      else if (name === '--no-start') out.start = false;
      else if (name === '--uninstall') out.uninstall = true;
      else if (name === '--purge') out.purge = true;
      else if (name === '--help' || name === '-h') out.help = true;
      else return `unknown option ${arg} (try --help)`;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  if (out.purge && !out.uninstall) return '--purge only goes with --uninstall';
  return out;
}

/**
 * `x.y.z` from a release version or tag (`2.0.2`, `v2.0.2`); `null` for anything
 * else, pre-releases included (the updater ignores those too).
 * @param {string | null | undefined} text
 * @returns {string | null}
 */
export function releaseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec((text ?? '').trim());
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null;
}

/**
 * Compares two `x.y.z` versions.
 * @param {string} a
 * @param {string} b
 * @returns {number} negative, zero or positive
 */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The version of GitHub's `releases/latest` answer (its `tag_name`); `null` for a
 * draft, a pre-release or a tag that is not `x.y.z`.
 * @param {unknown} json
 * @returns {string | null}
 */
export function versionFromLatestRelease(json) {
  if (typeof json !== 'object' || json === null) return null;
  const release = /** @type {Record<string, unknown>} */ (json);
  if (release['draft'] === true || release['prerelease'] === true) return null;
  return typeof release['tag_name'] === 'string' ? releaseVersion(release['tag_name']) : null;
}

/**
 * The version in the URL `https://github.com/<repo>/releases/latest` redirects to
 * (`…/releases/tag/v2.0.2`); the fallback when the API is rate limited.
 * @param {string} url
 * @returns {string | null}
 */
export function versionFromTagUrl(url) {
  const match = /\/releases\/tag\/([^/?#]+)$/.exec(url);
  return match ? releaseVersion(decodeURIComponent(/** @type {string} */ (match[1]))) : null;
}

/**
 * The newest release among the file names of a folder (`switchboard-<x.y.z>.tar.gz`).
 * @param {readonly string[]} names
 * @returns {string | null}
 */
export function newestTarball(names) {
  let best = /** @type {string | null} */ (null);
  for (const name of names) {
    const match = /^switchboard-(\d+\.\d+\.\d+)\.tar\.gz$/.exec(name);
    const version = match ? releaseVersion(match[1]) : null;
    if (version && (best === null || compareVersions(version, best) > 0)) best = version;
  }
  return best;
}

/**
 * Reads a `.sha256` file for `file`: exactly one line `<64 hex>  <name>` (or
 * `<64 hex> *<name>`, the binary marker), the name being `file`, as the updater
 * accepts it (`src/core/release.ts`). `null` when the text is anything else.
 * @param {string} text
 * @param {string} file
 * @returns {string | null} the lower-case hash
 */
export function parseChecksum(text, file) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length !== 1) return null;
  const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(/** @type {string} */ (lines[0]).trim());
  if (!match || match[2] !== file) return null;
  return /** @type {string} */ (match[1]).toLowerCase();
}

/**
 * The default install folder: `~/Applications/Switchboard` (macOS),
 * `~/.local/opt/switchboard` (Linux), `%LOCALAPPDATA%\Programs\Switchboard` (Windows).
 * @param {NodeJS.Platform} platform
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 * @returns {string}
 */
export function defaultInstallDir(platform, env, home) {
  if (platform === 'darwin') return path.posix.join(home, 'Applications', 'Switchboard');
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'] && path.win32.isAbsolute(env['LOCALAPPDATA']) ? env['LOCALAPPDATA'] : path.win32.join(home, 'AppData', 'Local');
    return path.win32.join(local, 'Programs', 'Switchboard');
  }
  return path.posix.join(home, '.local', 'opt', 'switchboard');
}

/**
 * Switchboard's data folder, as `defaultDataDir` in `src/server/config.ts` computes
 * it (`SWITCHBOARD_DATA_DIR` first).
 * @param {NodeJS.Platform} platform
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 * @returns {string}
 */
export function dataDir(platform, env, home) {
  if (env['SWITCHBOARD_DATA_DIR']) return env['SWITCHBOARD_DATA_DIR'];
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'Switchboard');
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'] && path.win32.isAbsolute(env['LOCALAPPDATA']) ? env['LOCALAPPDATA'] : path.win32.join(home, 'AppData', 'Local');
    return path.win32.join(local, 'Switchboard');
  }
  const xdg = env['XDG_DATA_HOME'];
  return path.posix.join(xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(home, '.local', 'share'), 'switchboard');
}

/**
 * The login service's definition file, where `tools/service` writes it
 * (`src/core/service-files.ts`; `SWITCHBOARD_SERVICE_HOME` is its test redirect).
 * @param {NodeJS.Platform} platform
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 * @returns {string | null}
 */
export function serviceDefinition(platform, env, home) {
  const serviceHome = env['SWITCHBOARD_SERVICE_HOME'] || home;
  if (platform === 'darwin') return path.posix.join(serviceHome, 'Library', 'LaunchAgents', 'local.switchboard.plist');
  if (platform === 'linux') {
    const xdg = env['SWITCHBOARD_SERVICE_HOME'] ? null : env['XDG_CONFIG_HOME'];
    const config = xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(serviceHome, '.config');
    return path.posix.join(config, 'systemd', 'user', 'switchboard.service');
  }
  if (platform === 'win32') return path.win32.join(dataDir(platform, env, home), 'service', 'switchboard-task.xml');
  return null;
}

/**
 * The URLs (or file paths, for a `file://` source) of a release's tarball and checksum.
 * @param {string | null} source `SWITCHBOARD_INSTALL_SOURCE`: a folder URL, or null for GitHub
 * @param {string} repo
 * @param {string} version
 * @returns {{ tarball: string, checksum: string, name: string }}
 */
export function releaseUrls(source, repo, version) {
  const name = `switchboard-${version}.tar.gz`;
  const base = source ? source.replace(/\/+$/, '') : `https://github.com/${repo}/releases/download/v${version}`;
  return { tarball: `${base}/${name}`, checksum: `${base}/${name}.sha256`, name };
}

/**
 * The npm command as an argv prefix: `npm-cli.js` through this node (npx sets
 * `npm_execpath`; else next to node), because Windows' `npm.cmd` cannot be
 * spawned without a shell; plain `npm` as a last resort outside Windows.
 * @param {string} execPath
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @returns {string[]} candidates, the first existing one wins
 */
export function npmCandidates(execPath, env, platform) {
  const lib = platform === 'win32' ? path.win32 : path.posix;
  const out = [];
  const fromNpm = env['npm_execpath'];
  if (fromNpm && /npm-cli\.js$/.test(fromNpm) && lib.isAbsolute(fromNpm)) out.push(fromNpm);
  const dir = lib.dirname(execPath);
  if (platform === 'win32') out.push(lib.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  else out.push(lib.join(lib.dirname(dir), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  return out;
}

export const HELP = `Install, upgrade or remove Switchboard (https://github.com/${DEFAULT_REPO}).

Usage: npx @marcingadomski94/switchboard [options]

  --dir <folder>     install folder (default: ~/Applications/Switchboard on macOS,
                     ~/.local/opt/switchboard on Linux, %LOCALAPPDATA%\\Programs\\Switchboard on Windows)
  --version <x.y.z>  install that release instead of the latest (or SWITCHBOARD_VERSION)
  --service          also start Switchboard at login (the login service)
  --no-service       do not register the login service (default without a terminal)
  --no-start         install only; do not start Switchboard
  --uninstall        stop it, remove the login service and the install folder; keeps your data
  --purge            with --uninstall: also remove the data folder
  --help             this text

Running it again upgrades to the latest release or repairs the installed one.
No sudo, no shell profile changes, no telemetry.`;

// ---------------------------------------------------------------------------
// Side effects

class InstallError extends Error {}

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new InstallError(message);
}

/** @param {string} file */
async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs a command (never through a shell), its output passed through.
 * @param {string} command
 * @param {readonly string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, quiet?: boolean }} options
 * @returns {Promise<{ code: number | null, stdout: string }>}
 */
function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, shell: false, stdio: ['ignore', options.quiet ? 'pipe' : 'inherit', options.quiet ? 'pipe' : 'inherit'], windowsHide: true });
    let stdout = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr?.resume();
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout }));
  });
}

/** @param {string} file */
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(/** @type {Buffer} */ (chunk));
  return hash.digest('hex');
}

/**
 * @param {string} url
 * @param {string} file
 */
async function download(url, file) {
  if (url.startsWith('file://')) {
    await copyFile(fileURLToPath(url), file).catch(() => fail(`cannot read ${fileURLToPath(url)}`));
    return;
  }
  const response = await fetch(url, { headers: { 'user-agent': 'switchboard-installer' }, signal: AbortSignal.timeout(10 * 60_000) }).catch((error) => fail(`download failed: ${url} (${error instanceof Error ? error.message : String(error)})`));
  if (!response.ok) fail(`download failed: ${url} answered HTTP ${response.status}`);
  if (url.startsWith('https:') && !response.url.startsWith('https:')) fail(`download of ${url} was redirected off HTTPS`);
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
}

/**
 * @param {string | null} source
 * @param {string} repo
 * @param {(line: string) => void} log
 * @returns {Promise<string>}
 */
async function latestVersion(source, repo, log) {
  if (source) {
    if (!source.startsWith('file://')) fail('SWITCHBOARD_INSTALL_SOURCE needs --version unless it is a file:// folder');
    const folder = fileURLToPath(source);
    const version = newestTarball(await readdir(folder).catch(() => []));
    return version ?? fail(`no switchboard-<version>.tar.gz in ${folder}`);
  }
  log(`Looking up the latest release of ${repo}...`);
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'switchboard-installer' }, signal: AbortSignal.timeout(15_000) });
    if (response.ok) {
      const version = versionFromLatestRelease(await response.json());
      if (version) return version;
    }
  } catch {
    // fall through to the redirect
  }
  try {
    const response = await fetch(`https://github.com/${repo}/releases/latest`, { method: 'HEAD', redirect: 'manual', headers: { 'user-agent': 'switchboard-installer' }, signal: AbortSignal.timeout(15_000) });
    const version = versionFromTagUrl(response.headers.get('location') ?? '');
    if (version) return version;
  } catch {
    // reported below
  }
  return fail(`could not find the latest release of ${repo} (GitHub rate limit?); pass --version x.y.z`);
}

/**
 * The HTTP status of `url`, 0 when nothing answers.
 * @param {string} url
 */
async function httpStatus(url) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
    return response.status;
  } catch {
    return 0;
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/**
 * The command line of `pid` (empty when unknown).
 * @param {number} pid
 */
async function commandOf(pid) {
  try {
    if (process.platform === 'win32') {
      const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { cwd: os.tmpdir(), quiet: true });
      return result.stdout.trim();
    }
    const result = await run('ps', ['-p', String(pid), '-o', 'command='], { cwd: os.tmpdir(), quiet: true });
    return result.stdout.trim();
  } catch {
    return '';
  }
}

/** Everything one run needs. */
class Installer {
  /**
   * @param {Options} options
   * @param {{ env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string, log: (line: string) => void, interactive: boolean }} context
   */
  constructor(options, context) {
    this.options = options;
    this.env = context.env;
    this.platform = context.platform;
    this.home = context.home;
    this.log = context.log;
    this.interactive = context.interactive;
    this.lib = this.platform === 'win32' ? path.win32 : path.posix;
    this.dir = this.lib.resolve(options.dir ?? defaultInstallDir(this.platform, this.env, this.home));
    this.dataDir = dataDir(this.platform, this.env, this.home);
    this.repo = this.env['SWITCHBOARD_UPDATE_REPO'] || DEFAULT_REPO;
    this.source = this.env['SWITCHBOARD_INSTALL_SOURCE'] || null;
    const port = this.env['SWITCHBOARD_PORT'] || String(DEFAULT_PORT);
    if (!/^\d+$/.test(port)) fail(`SWITCHBOARD_PORT must be a number, got ${port}`);
    this.url = `http://127.0.0.1:${port}`;
    this.definition = serviceDefinition(this.platform, this.env, this.home);
    if (this.dir === this.lib.resolve(this.home) || this.dir === this.lib.parse(this.dir).root) fail(`refusing to use ${this.dir} as the install folder`);
  }

  /** The service definition's text (UTF-16 for the Windows task XML), or null. */
  async serviceText() {
    if (!this.definition) return null;
    try {
      const bytes = await readFile(this.definition);
      return bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8');
    } catch {
      return null;
    }
  }

  /** True when the login service starts a Switchboard from this install (or a version the updater put in the data folder). */
  async servicePointsHere() {
    const text = await this.serviceText();
    if (text === null) return false;
    return text.includes(this.dir + this.lib.sep) || text.includes(this.lib.join(this.dataDir, 'versions') + this.lib.sep);
  }

  get pidFile() {
    return this.lib.join(this.dir, 'switchboard.pid');
  }

  /** The pid of a Switchboard this installer started from this folder, or null. */
  async startedPid() {
    const text = await readFile(this.pidFile, 'utf8').catch(() => '');
    const pid = Number(text.trim());
    if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return null;
    const command = await commandOf(pid);
    return command.includes(this.dir) && command.includes('main.ts') ? pid : null;
  }

  async stopStarted() {
    const pid = await this.startedPid();
    if (pid !== null) {
      this.log(`Stopping the Switchboard this installer started (pid ${pid})...`);
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // gone already
      }
      for (let waited = 0; waited < 60 && alive(pid); waited++) await sleep(500);
      if (alive(pid)) {
        this.log(`pid ${pid} did not stop within 30 s; stopping it hard`);
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // gone already
        }
      }
    }
    await rm(this.pidFile, { force: true });
  }

  /** @param {string} app */
  async npmCi(app) {
    let command = /** @type {string[] | null} */ (null);
    for (const candidate of npmCandidates(process.execPath, this.env, this.platform)) {
      if (await exists(candidate)) {
        command = [process.execPath, candidate];
        break;
      }
    }
    if (!command) command = this.platform === 'win32' ? fail('npm was not found next to node') : ['npm'];
    /** @type {NodeJS.ProcessEnv} */
    const env = {};
    for (const [key, value] of Object.entries(this.env)) if (!/^npm_/i.test(key)) env[key] = value;
    const result = await run(/** @type {string} */ (command[0]), [...command.slice(1), 'ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: app, env: { ...env, npm_config_update_notifier: 'false' } });
    if (result.code !== 0) fail('npm ci failed; nothing was installed');
  }

  async wantService() {
    if (this.options.service !== 'ask') return this.options.service === 'yes';
    if (await this.servicePointsHere()) {
      this.log('The login service already starts this install: keeping it, pointed at the new version.');
      return true;
    }
    if (!this.interactive) return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question('Start Switchboard at login (a per-user login service)? [y/N] ');
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  }

  /** @param {string} app */
  async startDetached(app) {
    const log = openSync(this.lib.join(this.dir, 'switchboard.log'), 'a');
    try {
      const child = spawn(process.execPath, [this.lib.join(app, 'src', 'server', 'main.ts')], { cwd: app, env: this.env, detached: true, stdio: ['ignore', log, log], shell: false, windowsHide: true });
      if (child.pid === undefined) fail('could not start Switchboard');
      await writeFile(this.pidFile, `${child.pid}\n`);
      child.unref();
    } finally {
      closeSync(log);
    }
  }

  async waitForAnswer() {
    for (let waited = 0; waited < 120; waited++) {
      if ((await httpStatus(`${this.url}/`)) !== 0) return true;
      await sleep(500);
    }
    return false;
  }

  /** Uses the real paths (no symlinks) of existing folders, as the login service and the process list name them. */
  async canonical() {
    this.dir = await realpath(this.dir).catch(() => this.dir);
    this.dataDir = await realpath(this.dataDir).catch(() => this.dataDir);
  }

  async install() {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 24) fail(`Node.js ${process.version} is too old: Switchboard needs Node.js 24 or newer (nvm install 24, or brew install node). Nothing was installed.`);
    const version = (this.options.version ?? this.env['SWITCHBOARD_VERSION'] ?? null) !== null ? releaseVersion(this.options.version ?? this.env['SWITCHBOARD_VERSION']) ?? fail(`"${this.options.version ?? this.env['SWITCHBOARD_VERSION']}" is not a release version (x.y.z)`) : await latestVersion(this.source, this.repo, this.log);
    const urls = releaseUrls(this.source, this.repo, version);
    await mkdir(this.dir, { recursive: true });
    await this.canonical();
    const app = this.lib.join(this.dir, `switchboard-${version}`);
    const marker = this.lib.join(this.dir, MARKER_NAME);
    const previous = (await readFile(marker, 'utf8').catch(() => '')).match(/^version=(.+)$/m)?.[1]?.trim() ?? null;
    this.log((await exists(app)) ? `Repairing Switchboard ${version} in ${app}` : `Installing Switchboard ${version} into ${app}`);
    await mkdir(this.dir, { recursive: true });
    const work = this.lib.join(this.dir, `.staging-${process.pid}`);
    await rm(work, { recursive: true, force: true });
    await mkdir(this.lib.join(work, 'unpacked'), { recursive: true });
    try {
      this.log(`Downloading ${urls.name}...`);
      const checksumFile = this.lib.join(work, `${urls.name}.sha256`);
      const tarball = this.lib.join(work, urls.name);
      await download(urls.checksum, checksumFile);
      await download(urls.tarball, tarball);
      const expected = parseChecksum(await readFile(checksumFile, 'utf8'), urls.name) ?? fail(`${urls.name}.sha256 is not a sha256 line for ${urls.name}; nothing was installed`);
      const actual = await sha256(tarball);
      if (actual !== expected) fail(`checksum mismatch for ${urls.name} (expected ${expected}, got ${actual}); nothing was installed`);
      this.log(`Checksum OK (${actual})`);
      const listing = await run('tar', ['-tzf', tarball], { cwd: work, quiet: true });
      if (listing.code !== 0) fail(`${urls.name} is not a readable tar.gz`);
      const prefix = `switchboard-${version}/`;
      for (const entry of listing.stdout.split(/\r?\n/).filter(Boolean)) {
        if (!entry.startsWith(prefix) || /(^|[/\\])\.\.([/\\]|$)/.test(entry)) fail(`${urls.name} has entries outside ${prefix}; nothing was installed`);
      }
      const unpack = await run('tar', ['-xzf', urls.name, '-C', 'unpacked'], { cwd: work });
      if (unpack.code !== 0) fail(`unpacking ${urls.name} failed`);
      const staged = this.lib.join(work, 'unpacked', `switchboard-${version}`);
      const packaged = JSON.parse(await readFile(this.lib.join(staged, 'package.json'), 'utf8').catch(() => '{}')).version;
      if (packaged !== version) fail(`the package says version "${packaged}", not ${version}`);
      if (!(await exists(this.lib.join(staged, 'src', 'server', 'main.ts'))) || !(await exists(this.lib.join(staged, 'dist', 'web', 'index.html')))) fail('the package misses src/server/main.ts or dist/web; nothing was installed');
      this.log('Installing dependencies (npm ci --omit=dev)...');
      await this.npmCi(staged);
      if (this.options.start || (await exists(app))) await this.stopStarted();
      if (await exists(app)) await rename(app, this.lib.join(work, 'replaced'));
      await rename(staged, app);
      await writeFile(marker, `version=${version}\n`);
      this.log(`Installed Switchboard ${version} in ${app}`);
    } finally {
      await rm(work, { recursive: true, force: true });
    }

    let startedByService = false;
    if (await this.wantService()) {
      this.log('Registering the login service...');
      const result = await run(process.execPath, [this.lib.join('tools', 'service', 'install.ts'), ...(this.options.start ? ['--start'] : [])], { cwd: app, env: this.env });
      if (result.code !== 0) fail('registering the login service failed (see above)');
      startedByService = this.options.start;
    }

    const serviceText = (await this.serviceText()) ?? '';
    for (const name of await readdir(this.dir)) {
      const folder = this.lib.join(this.dir, name);
      if (!name.startsWith('switchboard-') || folder === app || (previous && name === `switchboard-${previous}`)) continue;
      if (!(await stat(folder)).isDirectory() || serviceText.includes(folder + this.lib.sep)) continue;
      await rm(folder, { recursive: true, force: true });
      this.log(`Removed the older ${folder}`);
    }

    if (!this.options.start) {
      this.log(`\nDone. Start it with "npm start" in ${app}, then open ${this.url}`);
      return 0;
    }
    if (!startedByService) {
      if ((await httpStatus(`${this.url}/`)) !== 0) {
        this.log(`Something already answers on ${this.url} (another Switchboard?); not starting a second one. Stop it first, or set SWITCHBOARD_PORT, then run "npm start" in ${app}.`);
        return 0;
      }
      this.log('Starting Switchboard...');
      await this.startDetached(app);
    }
    if (!(await this.waitForAnswer())) fail(`Switchboard did not answer on ${this.url} within 60 s; see ${this.lib.join(this.dir, 'switchboard.log')}`);
    this.log(`\nSwitchboard ${version} is running: open ${this.url}`);
    if (!startedByService) this.log(`It runs in the background (log: ${this.lib.join(this.dir, 'switchboard.log')}). Run this again with --service to start it at login.`);
    return 0;
  }

  /** A folder this installer may delete: it made it, or it holds only release folders and the installer's files. */
  async removable() {
    if (await exists(this.lib.join(this.dir, MARKER_NAME))) return true;
    const names = await readdir(this.dir);
    return names.every((name) => /^(switchboard-|\.staging-)/.test(name) || name === 'switchboard.log' || name === 'switchboard.pid');
  }

  async uninstall() {
    await this.canonical();
    this.log(`Uninstalling Switchboard from ${this.dir}`);
    const installed = await exists(this.dir);
    if (installed) await this.stopStarted();
    if (await this.servicePointsHere()) {
      const candidates = [
        ...(installed ? (await readdir(this.dir)).filter((name) => name.startsWith('switchboard-')).map((name) => this.lib.join(this.dir, name)) : []),
        ...(await readdir(this.lib.join(this.dataDir, 'versions')).catch(() => [])).map((name) => this.lib.join(this.dataDir, 'versions', name)),
      ];
      let app = null;
      for (const candidate of candidates) {
        if (await exists(this.lib.join(candidate, 'tools', 'service', 'uninstall.ts'))) {
          app = candidate;
          break;
        }
      }
      if (app) {
        this.log('Removing the login service...');
        const result = await run(process.execPath, [this.lib.join('tools', 'service', 'uninstall.ts')], { cwd: app, env: this.env });
        if (result.code !== 0) this.log(`Removing the login service failed; run "npm run service:uninstall" in ${app}`);
      } else {
        this.log(`The login service ${this.definition} points here but no install is left to remove it; delete it by hand.`);
      }
    } else if (this.definition && (await exists(this.definition))) {
      this.log(`Leaving the login service alone: it starts a Switchboard from another folder (${this.definition}).`);
    }
    if (installed) {
      if (!(await this.removable())) fail(`${this.dir} holds files this installer did not make; remove it by hand`);
      await rm(this.dir, { recursive: true, force: true });
      this.log(`Removed ${this.dir}`);
    } else {
      this.log(`Nothing installed in ${this.dir}`);
    }
    for (const folder of [this.lib.join(this.dataDir, 'versions'), this.lib.join(this.dataDir, 'updates')]) {
      if (await exists(folder)) {
        await rm(folder, { recursive: true, force: true });
        this.log(`Removed ${folder} (versions the in-app updater installed)`);
      }
    }
    if (this.options.purge) {
      const resolved = this.lib.resolve(this.dataDir);
      if (resolved === this.lib.resolve(this.home) || resolved === this.lib.parse(resolved).root) fail(`refusing to purge ${resolved}`);
      if (await exists(resolved)) {
        await rm(resolved, { recursive: true, force: true });
        this.log(`Removed your data in ${resolved}`);
      }
    } else if (await exists(this.dataDir)) {
      this.log(`Kept your data in ${this.dataDir} (run with --uninstall --purge to remove it too)`);
    }
    return 0;
  }
}

/**
 * Runs the installer.
 * @param {readonly string[]} argv the arguments after the command
 * @param {{ env?: NodeJS.ProcessEnv, log?: (line: string) => void }} [io]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, io = {}) {
  const log = io.log ?? ((line) => console.log(line));
  const options = parseArgs(argv);
  if (typeof options === 'string') {
    console.error(`switchboard install: ${options}`);
    return 2;
  }
  if (options.help) {
    log(HELP);
    return 0;
  }
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
    console.error(`switchboard install: ${process.platform} is not supported (macOS, Linux and Windows are)`);
    return 1;
  }
  const env = io.env ?? process.env;
  try {
    const installer = new Installer(options, { env, platform: process.platform, home: env['HOME'] && process.platform !== 'win32' ? env['HOME'] : os.homedir(), log, interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
    return options.uninstall ? await installer.uninstall() : await installer.install();
  } catch (error) {
    if (error instanceof InstallError) {
      console.error(`switchboard install: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
