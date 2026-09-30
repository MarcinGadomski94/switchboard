import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../../src/server/config.ts';
import { LoginService } from '../../../src/server/service/login-service.ts';
import { loadUpdateConfig } from '../../../src/server/updates/config.ts';
import { detectInstallKind, isInside, packageVersion, readLedger, updatePaths, writeLedger } from '../../../src/server/updates/install.ts';
import { NPM_CI_ARGS, npmCi, npmCliCandidates, npmEnvironment, resolveNpm } from '../../../src/server/updates/npm.ts';
import { fakeNpmCommand } from '../../../tools/fake-npm/command.ts';
import { fakeServiceCtlCommand } from '../../../tools/fake-servicectl/command.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';

/** D55 updater pieces: configuration, install kind, the ledger, npm, the login service's re-pointing. */

let tmp: string;
beforeEach(async () => {
  tmp = await makeTempDir('update-setup');
});
afterEach(async () => {
  await removeTempDir(tmp);
});

describe('loadUpdateConfig', () => {
  it('defaults: on, the Switchboard repository, no test redirects', () => {
    expect(loadUpdateConfig({})).toEqual({ enabled: true, repo: 'MarcinGadomski94/switchboard', testOrigin: null, npmCommand: null, testInstallKind: null, testUnderService: false });
  });

  it('reads off, a fork, the npm command and the test redirects', () => {
    const config = loadUpdateConfig(
      { SWITCHBOARD_UPDATES: 'off', SWITCHBOARD_UPDATE_REPO: 'someone/switchboard-fork', SWITCHBOARD_NPM_BIN: '["node","/x/npm-cli.js"]', SWITCHBOARD_UPDATE_API: 'http://127.0.0.1:4940/', SWITCHBOARD_UPDATE_TEST_INSTALL: 'release', SWITCHBOARD_UPDATE_TEST_UNDER_SERVICE: '1' },
      { serviceRedirect: true },
    );
    expect(config).toEqual({ enabled: false, repo: 'someone/switchboard-fork', testOrigin: 'http://127.0.0.1:4940', npmCommand: ['node', '/x/npm-cli.js'], testInstallKind: 'release', testUnderService: true });
  });

  it('refuses unusable values and test redirects without their guards', () => {
    for (const env of [
      { SWITCHBOARD_UPDATES: 'maybe' },
      { SWITCHBOARD_UPDATE_REPO: 'no-slash' },
      { SWITCHBOARD_UPDATE_REPO: 'a/../b' },
      { SWITCHBOARD_UPDATE_API: 'https://api.github.com' },
      { SWITCHBOARD_UPDATE_API: 'http://example.com' },
      { SWITCHBOARD_UPDATE_TEST_INSTALL: 'release' },
      { SWITCHBOARD_UPDATE_API: 'http://127.0.0.1:1', SWITCHBOARD_UPDATE_TEST_INSTALL: 'zip' },
      { SWITCHBOARD_UPDATE_API: 'http://127.0.0.1:1', SWITCHBOARD_UPDATE_TEST_UNDER_SERVICE: '1' },
    ]) {
      expect(() => loadUpdateConfig(env), JSON.stringify(env)).toThrow(ConfigError);
    }
  });
});

describe('install kind and ledger', () => {
  it('a folder with .git (folder or worktree file) is a git checkout, else a release install', async () => {
    const release = path.join(tmp, 'release');
    const checkout = path.join(tmp, 'checkout');
    const worktree = path.join(tmp, 'worktree');
    await mkdir(release);
    await mkdir(path.join(checkout, '.git'), { recursive: true });
    await mkdir(worktree);
    await writeFile(path.join(worktree, '.git'), 'gitdir: /x/.git/worktrees/w\n');
    expect(await detectInstallKind(release)).toBe('release');
    expect(await detectInstallKind(checkout)).toBe('git');
    expect(await detectInstallKind(worktree)).toBe('git');
  });

  it('reads a package version and writes / reads the ledger', async () => {
    await writeFile(path.join(tmp, 'package.json'), '{"version":"1.2.3"}');
    expect(await packageVersion(tmp)).toBe('1.2.3');
    expect(await packageVersion(path.join(tmp, 'none'))).toBeNull();
    const paths = updatePaths(path.join(tmp, 'data'));
    expect(await readLedger(paths)).toEqual({ current: null, previous: null });
    await writeLedger(paths, { current: { version: '1.1.0', dir: '/a' }, previous: { version: '1.0.0', dir: '/b' } });
    expect(await readLedger(paths)).toEqual({ current: { version: '1.1.0', dir: '/a' }, previous: { version: '1.0.0', dir: '/b' } });
    expect(isInside('/a/b/c', '/a/b')).toBe(true);
    expect(isInside('/a/bc', '/a/b')).toBe(false);
  });
});

describe('npm', () => {
  it('looks for npm-cli.js through npm_execpath, then next to node', () => {
    expect(npmCliCandidates('C:\\Program Files\\nodejs\\node.exe', {}, 'win32')).toEqual(['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js']);
    expect(npmCliCandidates('/opt/homebrew/bin/node', { npm_execpath: '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js' }, 'darwin')).toEqual([
      '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
      '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
    ]);
    expect(npmCliCandidates('/usr/bin/node', { npm_execpath: 'relative/npm-cli.js' }, 'linux')).toEqual(['/usr/lib/node_modules/npm/bin/npm-cli.js']);
  });

  it('resolves [node, npm-cli.js]; plain npm on macOS / Linux; nothing on Windows without it', async () => {
    const none = async () => false;
    const found = async (file: string) => file.endsWith('npm-cli.js');
    expect(await resolveNpm({ override: ['my-npm'] })).toEqual(['my-npm']);
    expect(await resolveNpm({ execPath: 'C:\\n\\node.exe', env: {}, platform: 'win32', exists: found })).toEqual(['C:\\n\\node.exe', 'C:\\n\\node_modules\\npm\\bin\\npm-cli.js']);
    expect(await resolveNpm({ execPath: 'C:\\n\\node.exe', env: {}, platform: 'win32', exists: none })).toBeNull();
    expect(await resolveNpm({ execPath: '/usr/bin/node', env: {}, platform: 'linux', exists: none })).toEqual(['npm']);
    // This machine's npm is found next to this node.
    expect((await resolveNpm({}))?.join(' ')).toMatch(/npm/);
  });

  it("runs npm ci --omit=dev without the parent npm run's variables", async () => {
    expect(NPM_CI_ARGS).toEqual(['ci', '--omit=dev', '--no-audit', '--no-fund']);
    const env = npmEnvironment({ PATH: '/bin', npm_lifecycle_event: 'start', npm_config_omit: 'optional', NPM_TOKEN: 'x' });
    expect(env).toEqual({ PATH: '/bin', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' });
    await writeFile(path.join(tmp, 'package-lock.json'), '{}');
    const log = path.join(tmp, 'npm.log');
    const result = await npmCi(fakeNpmCommand(), tmp, { ...process.env, FAKE_NPM_LOG: log });
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(log, 'utf8')).argv).toEqual([...NPM_CI_ARGS]);
    expect((await npmCi(fakeNpmCommand(), path.join(tmp), { ...process.env, FAKE_NPM_FAIL: 'boom' })).stderr).toContain('boom');
  });
});

describe('LoginService.pointTo', () => {
  it('registers the definition again for another install folder (systemd unit)', async () => {
    const log = path.join(tmp, 'ctl.log');
    const login = new LoginService({
      location: { platform: 'linux', home: path.join(tmp, 'home'), dataDir: path.join(tmp, 'data'), xdgConfigHome: null },
      manager: fakeServiceCtlCommand(),
      env: { ...process.env, FAKE_SERVICECTL_LOG: log },
      carried: {},
      address: '127.0.0.1:13001',
      hostPlatform: process.platform,
    });
    const target = path.join(tmp, 'data', 'versions', '1.1.0');
    // The updater points at the folder once it holds the new version.
    await mkdir(target, { recursive: true });
    const status = await login.pointTo(target);
    expect(status.startAtLogin).toBe(true);
    const unit = await readFile(status.file ?? '', 'utf8');
    expect(unit).toContain(`WorkingDirectory=${target}`);
    expect(unit).toContain(`${path.join(target, 'src', 'server', 'main.ts')}`);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => (JSON.parse(line) as { argv: string[] }).argv.join(' '));
    expect(calls).toEqual(['--user daemon-reload', '--user enable switchboard.service']);
  });
});
