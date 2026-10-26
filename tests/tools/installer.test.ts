import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checksumLine } from '../../src/core/release.ts';
import { type TarInput, writeTarGz } from '../../src/server/updates/tar.ts';
import {
  compareVersions,
  dataDir,
  defaultInstallDir,
  newestTarball,
  npmCandidates,
  parseArgs,
  parseChecksum,
  releaseUrls,
  releaseVersion,
  serviceDefinition,
  versionFromLatestRelease,
  versionFromTagUrl,
} from '../../packages/npx/lib/installer.mjs';
import { REPO_ROOT, isPortFree, makeTempDir, removeTempDir } from '../helpers/net.ts';

/**
 * The one-line installers (`install.sh`, the npx launcher `packages/npx`;
 * `docs/setup.md` → *One-line install*): the launcher's pure helpers, then both
 * installers end to end against a local "release" (`SWITCHBOARD_INSTALL_SOURCE=file://…`)
 * in a temp HOME, with a fake Switchboard whose server answers on a test port
 * (4700-4799) and whose service scripts only write a definition file under the
 * test redirect `SWITCHBOARD_SERVICE_HOME`. Nothing touches the real install
 * folder, data folder, login service or ports 13001-13003.
 */

const HEX = 'ab'.repeat(32);

describe('installer helpers', () => {
  it('reads the options', () => {
    expect(parseArgs([])).toEqual({ dir: null, version: null, service: 'ask', start: true, uninstall: false, purge: false, help: false });
    expect(parseArgs(['--dir', '/x', '--version=2.0.2', '--service', '--no-start'])).toMatchObject({ dir: '/x', version: '2.0.2', service: 'yes', start: false });
    expect(parseArgs(['--no-service', '--uninstall', '--purge'])).toMatchObject({ service: 'no', uninstall: true, purge: true });
    expect(parseArgs(['--dir'])).toBe('--dir needs a value');
    expect(parseArgs(['--purge'])).toBe('--purge only goes with --uninstall');
    expect(parseArgs(['--what'])).toMatch(/unknown option --what/);
  });

  it('resolves versions from a tag, the API, the latest redirect and a folder', () => {
    expect(releaseVersion('v2.0.2')).toBe('2.0.2');
    expect(releaseVersion('2.10.0')).toBe('2.10.0');
    for (const bad of ['2.0', 'v2.0.2-beta.1', 'latest', '', null, '../2.0.2']) expect(releaseVersion(bad)).toBeNull();
    expect(versionFromLatestRelease({ tag_name: 'v2.1.0', draft: false, prerelease: false })).toBe('2.1.0');
    expect(versionFromLatestRelease({ tag_name: 'v2.1.0', prerelease: true })).toBeNull();
    expect(versionFromLatestRelease({ message: 'API rate limit exceeded' })).toBeNull();
    expect(versionFromLatestRelease(null)).toBeNull();
    expect(versionFromTagUrl('https://github.com/MarcinGadomski94/switchboard/releases/tag/v2.0.2')).toBe('2.0.2');
    expect(versionFromTagUrl('https://github.com/MarcinGadomski94/switchboard/releases')).toBeNull();
    expect(newestTarball(['switchboard-2.0.2.tar.gz', 'switchboard-2.10.0.tar.gz', 'switchboard-2.9.9.tar.gz', 'switchboard-3.0.0.tar.gz.sha256', 'notes.md'])).toBe('2.10.0');
    expect(newestTarball(['switchboard-x.tar.gz'])).toBeNull();
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.2', '2.0.2')).toBe(0);
  });

  it('parses checksum files as the updater does', () => {
    const name = 'switchboard-2.0.2.tar.gz';
    expect(parseChecksum(checksumLine(HEX, name), name)).toBe(HEX);
    expect(parseChecksum(`${HEX.toUpperCase()} *${name}\r\n`, name)).toBe(HEX);
    expect(parseChecksum(checksumLine(HEX, 'switchboard-2.0.1.tar.gz'), name)).toBeNull();
    expect(parseChecksum(`${HEX.slice(1)}  ${name}\n`, name)).toBeNull();
    expect(parseChecksum(`${checksumLine(HEX, name)}${checksumLine(HEX, name)}`, name)).toBeNull();
    expect(parseChecksum('', name)).toBeNull();
  });

  it('knows the folders per OS', () => {
    expect(defaultInstallDir('darwin', {}, '/Users/a')).toBe('/Users/a/Applications/Switchboard');
    expect(defaultInstallDir('linux', {}, '/home/a')).toBe('/home/a/.local/opt/switchboard');
    expect(defaultInstallDir('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a')).toBe('C:\\Users\\a\\AppData\\Local\\Programs\\Switchboard');
    expect(dataDir('darwin', {}, '/Users/a')).toBe('/Users/a/Library/Application Support/Switchboard');
    expect(dataDir('linux', { XDG_DATA_HOME: '/x' }, '/home/a')).toBe('/x/switchboard');
    expect(dataDir('linux', {}, '/home/a')).toBe('/home/a/.local/share/switchboard');
    expect(dataDir('darwin', { SWITCHBOARD_DATA_DIR: '/d' }, '/Users/a')).toBe('/d');
    expect(serviceDefinition('darwin', {}, '/Users/a')).toBe('/Users/a/Library/LaunchAgents/local.switchboard.plist');
    expect(serviceDefinition('darwin', { SWITCHBOARD_SERVICE_HOME: '/t' }, '/Users/a')).toBe('/t/Library/LaunchAgents/local.switchboard.plist');
    expect(serviceDefinition('linux', { XDG_CONFIG_HOME: '/c' }, '/home/a')).toBe('/c/systemd/user/switchboard.service');
    expect(serviceDefinition('linux', { XDG_CONFIG_HOME: '/c', SWITCHBOARD_SERVICE_HOME: '/t' }, '/home/a')).toBe('/t/.config/systemd/user/switchboard.service');
    expect(serviceDefinition('win32', { LOCALAPPDATA: 'C:\\L' }, 'C:\\Users\\a')).toBe('C:\\L\\Switchboard\\service\\switchboard-task.xml');
  });

  it('builds the release URLs and finds npm', () => {
    expect(releaseUrls(null, 'o/r', '2.0.2')).toEqual({ name: 'switchboard-2.0.2.tar.gz', tarball: 'https://github.com/o/r/releases/download/v2.0.2/switchboard-2.0.2.tar.gz', checksum: 'https://github.com/o/r/releases/download/v2.0.2/switchboard-2.0.2.tar.gz.sha256' });
    expect(releaseUrls('file:///tmp/rel/', 'o/r', '1.0.0').tarball).toBe('file:///tmp/rel/switchboard-1.0.0.tar.gz');
    expect(npmCandidates('/usr/local/bin/node', { npm_execpath: '/n/npm-cli.js' }, 'darwin')).toEqual(['/n/npm-cli.js', '/usr/local/lib/node_modules/npm/bin/npm-cli.js']);
    expect(npmCandidates('C:\\node\\node.exe', {}, 'win32')).toEqual(['C:\\node\\node_modules\\npm\\bin\\npm-cli.js']);
  });
});

// ---------------------------------------------------------------------------
// End to end (macOS / Linux): install.sh and the npx launcher.

/** A fake Switchboard server: answers 200 "switchboard <version>" on SWITCHBOARD_PORT. */
const FAKE_MAIN = `import http from 'node:http';
const version = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../../package.json', import.meta.url), 'utf8')).version;
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('switchboard ' + version); });
server.listen(Number(process.env.SWITCHBOARD_PORT), '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
`;

/** The fake service scripts write / remove a definition file where tools/service would (under the test redirect only). */
const FAKE_SERVICE = (action: 'install' | 'uninstall') => `import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
const home = process.env.SWITCHBOARD_SERVICE_HOME;
if (!home || !process.env.SWITCHBOARD_SERVICE_CTL) { console.error('refusing: no test redirect'); process.exit(1); }
const file = process.platform === 'darwin' ? path.join(home, 'Library', 'LaunchAgents', 'local.switchboard.plist') : path.join(home, '.config', 'systemd', 'user', 'switchboard.service');
await appendFile(path.join(home, 'calls.log'), JSON.stringify({ action: '${action}', cwd: process.cwd(), argv: process.argv.slice(2) }) + '\\n');
${action === 'install' ? "await mkdir(path.dirname(file), { recursive: true });\nawait writeFile(file, 'ExecStart=node ' + path.join(process.cwd(), 'src', 'server', 'main.ts') + '\\n');" : 'await rm(file, { force: true });'}
`;

async function fakeRelease(dir: string, version: string): Promise<void> {
  const prefix = `switchboard-${version}/`;
  const file = (name: string, text: string): TarInput => ({ path: `${prefix}${name}`, type: 'file', mode: 0o644, mtime: 1_700_000_000, data: Buffer.from(text) });
  const folder = (name: string): TarInput => ({ path: `${prefix}${name}/`, type: 'dir', mode: 0o755, mtime: 1_700_000_000 });
  const entries: TarInput[] = [
    { path: prefix, type: 'dir', mode: 0o755, mtime: 1_700_000_000 },
    file('package.json', JSON.stringify({ name: 'switchboard', version, private: true, type: 'module' })),
    file('package-lock.json', JSON.stringify({ name: 'switchboard', version, lockfileVersion: 3, requires: true, packages: { '': { name: 'switchboard', version } } })),
    folder('src'),
    folder('src/server'),
    file('src/server/main.ts', FAKE_MAIN),
    folder('dist'),
    folder('dist/web'),
    file('dist/web/index.html', '<!doctype html>'),
    folder('tools'),
    folder('tools/service'),
    file('tools/service/install.ts', FAKE_SERVICE('install')),
    file('tools/service/uninstall.ts', FAKE_SERVICE('uninstall')),
  ];
  const tarball = path.join(dir, `switchboard-${version}.tar.gz`);
  await writeTarGz(entries, tarball);
  const hex = createHash('sha256').update(await readFile(tarball)).digest('hex');
  await writeFile(`${tarball}.sha256`, checksumLine(hex, `switchboard-${version}.tar.gz`));
}

interface Run {
  code: number | null;
  out: string;
}

function runInstaller(command: readonly string[], args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0] as string, [...command.slice(1), ...args], { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, out }));
  });
}

async function get(port: number): Promise<{ status: number; body: string } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    return { status: response.status, body: await response.text() };
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  for (let port = 4700 + Math.floor(Math.random() * 50); port < 4800; port++) if (await isPortFree(port)) return port;
  throw new Error('no free port in 4700-4799');
}

const DRIVERS: readonly { name: string; command: readonly string[] }[] = [
  { name: 'install.sh', command: ['sh', path.join(REPO_ROOT, 'install.sh')] },
  ...(existsSync('/bin/dash') ? [{ name: 'install.sh under dash (strict POSIX)', command: ['/bin/dash', path.join(REPO_ROOT, 'install.sh')] }] : []),
  { name: 'npx launcher', command: [process.execPath, path.join(REPO_ROOT, 'packages', 'npx', 'bin', 'switchboard.mjs')] },
];

describe.skipIf(process.platform === 'win32').each(DRIVERS)('$name end to end', ({ command }) => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;
  let dir: string;
  let data: string;
  let port: number;
  let release: string;

  beforeAll(async () => {
    tmp = await realpath(await makeTempDir('installer'));
    release = path.join(tmp, 'release');
    dir = path.join(tmp, 'apps', 'Switchboard');
    data = path.join(tmp, 'data');
    await mkdir(release, { recursive: true });
    await mkdir(path.join(tmp, 'home'), { recursive: true });
    await fakeRelease(release, '9.9.0');
    await fakeRelease(release, '9.9.1');
    port = await freePort();
    const clean: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!/^(npm_|SWITCHBOARD_|XDG_)/i.test(key)) clean[key] = value;
    env = {
      ...clean,
      HOME: path.join(tmp, 'home'),
      SWITCHBOARD_DATA_DIR: data,
      SWITCHBOARD_PORT: String(port),
      SWITCHBOARD_INSTALL_SOURCE: `file://${release}`,
      SWITCHBOARD_SERVICE_HOME: path.join(tmp, 'service-home'),
      SWITCHBOARD_SERVICE_CTL: JSON.stringify([process.execPath, path.join(REPO_ROOT, 'tools', 'fake-servicectl', 'main.ts')]),
      npm_config_cache: path.join(tmp, 'npm-cache'),
    };
    await mkdir(path.join(tmp, 'service-home'), { recursive: true });
    await mkdir(data, { recursive: true });
    await writeFile(path.join(data, 'switchboard.db'), 'data');
  });

  afterAll(async () => {
    const pid = Number((await readFile(path.join(dir, 'switchboard.pid'), 'utf8').catch(() => '')).trim());
    if (pid > 0 && alive(pid)) process.kill(pid, 'SIGTERM');
    await removeTempDir(tmp);
  });

  it('installs the newest local release, starts it and answers 200', async () => {
    const result = await runInstaller(command, ['--dir', dir, '--no-service'], env, tmp);
    expect(result.out).toContain('Checksum OK');
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`http://127.0.0.1:${port}`);
    expect(await get(port)).toEqual({ status: 200, body: 'switchboard 9.9.1' });
    expect((await readdir(dir)).sort()).toEqual(['.switchboard-install', 'switchboard-9.9.1', 'switchboard.log', 'switchboard.pid']);
    expect(await readFile(path.join(dir, '.switchboard-install'), 'utf8')).toBe('version=9.9.1\n');
    expect(await exists(path.join(tmp, 'service-home', 'calls.log'))).toBe(false);
  }, 120_000);

  it('repairs on a second run: replaces the folder and restarts it', async () => {
    const before = Number(await readFile(path.join(dir, 'switchboard.pid'), 'utf8'));
    const result = await runInstaller(command, ['--dir', dir, '--no-service'], env, tmp);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('Repairing Switchboard 9.9.1');
    const after = Number(await readFile(path.join(dir, 'switchboard.pid'), 'utf8'));
    expect(after).not.toBe(before);
    expect(alive(before)).toBe(false);
    expect(await get(port)).toEqual({ status: 200, body: 'switchboard 9.9.1' });
  }, 120_000);

  it('refuses a checksum mismatch and changes nothing', async () => {
    const bad = path.join(tmp, 'bad-release');
    await mkdir(bad, { recursive: true });
    await fakeRelease(bad, '9.9.2');
    await writeFile(path.join(bad, 'switchboard-9.9.2.tar.gz.sha256'), checksumLine(HEX, 'switchboard-9.9.2.tar.gz'));
    const pid = Number(await readFile(path.join(dir, 'switchboard.pid'), 'utf8'));
    const result = await runInstaller(command, ['--dir', dir, '--no-service'], { ...env, SWITCHBOARD_INSTALL_SOURCE: `file://${bad}` }, tmp);
    expect(result.code).toBe(1);
    expect(result.out).toContain('checksum mismatch');
    expect(result.out).toContain('nothing was installed');
    expect((await readdir(dir)).sort()).toEqual(['.switchboard-install', 'switchboard-9.9.1', 'switchboard.log', 'switchboard.pid']);
    expect(alive(pid)).toBe(true);
  }, 120_000);

  it('registers the login service through the service scripts (test redirect only)', async () => {
    const result = await runInstaller(command, ['--dir', dir, '--version', '9.9.0', '--service', '--no-start'], env, tmp);
    expect(result.code, result.out).toBe(0);
    const calls = (await readFile(path.join(tmp, 'service-home', 'calls.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { action: string; cwd: string; argv: string[] });
    expect(calls).toEqual([{ action: 'install', cwd: path.join(dir, 'switchboard-9.9.0'), argv: [] }]);
    const definition = process.platform === 'darwin' ? path.join(tmp, 'service-home', 'Library', 'LaunchAgents', 'local.switchboard.plist') : path.join(tmp, 'service-home', '.config', 'systemd', 'user', 'switchboard.service');
    expect(await readFile(definition, 'utf8')).toContain(path.join(dir, 'switchboard-9.9.0', 'src', 'server', 'main.ts'));
    expect((await readdir(dir)).filter((name) => name.startsWith('switchboard-')).sort()).toEqual(['switchboard-9.9.0', 'switchboard-9.9.1']);
    expect(await get(port)).toEqual({ status: 200, body: 'switchboard 9.9.1' });
  }, 120_000);

  it('upgrades back to the newest and keeps the folder the service points at', async () => {
    const result = await runInstaller(command, ['--dir', dir, '--no-service'], env, tmp);
    expect(result.code, result.out).toBe(0);
    expect(await get(port)).toEqual({ status: 200, body: 'switchboard 9.9.1' });
    expect((await readdir(dir)).filter((name) => name.startsWith('switchboard-')).sort()).toEqual(['switchboard-9.9.0', 'switchboard-9.9.1']);
  }, 120_000);

  it('uninstalls: stops it, removes the service and the folder, keeps the data', async () => {
    await mkdir(path.join(data, 'versions', '9.9.5'), { recursive: true });
    const pid = Number(await readFile(path.join(dir, 'switchboard.pid'), 'utf8'));
    const result = await runInstaller(command, ['--dir', dir, '--uninstall'], env, tmp);
    expect(result.code, result.out).toBe(0);
    expect(alive(pid)).toBe(false);
    expect(await get(port)).toBeNull();
    expect(await exists(dir)).toBe(false);
    expect(await exists(path.join(data, 'versions'))).toBe(false);
    expect(await readFile(path.join(data, 'switchboard.db'), 'utf8')).toBe('data');
    const calls = (await readFile(path.join(tmp, 'service-home', 'calls.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { action: string });
    expect(calls.map((call) => call.action)).toEqual(['install', 'uninstall']);
    expect(result.out).toContain('Kept your data');
  }, 120_000);

  it('purges the data with --uninstall --purge', async () => {
    const result = await runInstaller(command, ['--dir', dir, '--uninstall', '--purge'], env, tmp);
    expect(result.code, result.out).toBe(0);
    expect(await exists(data)).toBe(false);
  }, 60_000);

  it('refuses to delete a folder it did not make', async () => {
    const other = path.join(tmp, 'other');
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, 'notes.txt'), 'mine');
    const result = await runInstaller(command, ['--dir', other, '--uninstall'], env, tmp);
    expect(result.code).toBe(1);
    expect(await readFile(path.join(other, 'notes.txt'), 'utf8')).toBe('mine');
  }, 60_000);
});
