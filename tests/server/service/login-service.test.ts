import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ServiceLocation, launchdPlist, servicePaths, systemdUnit } from '../../../src/core/service-files.ts';
import { ConfigError, loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { createDemoLoginService } from '../../../src/server/demo/login-service.ts';
import { ServiceError } from '../../../src/server/service/errors.ts';
import { executePlan } from '../../../src/server/service/executor.ts';
import { LoginService, START_AT_LOGIN_SETTING, createLoginService } from '../../../src/server/service/login-service.ts';
import {
  APP_DIR,
  SERVICE_ENTRY,
  carriedEnvironment,
  cleanSearchPath,
  loadServiceRedirect,
  serviceLocation,
  serviceTarget,
  windowsUser,
  withCleanSearchPath,
} from '../../../src/server/service/target.ts';
import { fakeServiceCtlCommand, fakeServiceCtlEnv } from '../../../tools/fake-servicectl/command.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * M9.1 oracle, part 2: "Start at login" on the real code path (`LoginService` →
 * `executePlan` → real spawns) against a temp home and data folder, with
 * tools/fake-servicectl as launchctl / systemctl / schtasks. Nothing is
 * registered with a real service manager (D12).
 */

let tmp: string;
let home: string;
let dataDir: string;
let log: string;
let store: Store;

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function ctlCalls(): Promise<string[][]> {
  try {
    return (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { argv: string[] }).argv);
  } catch {
    return [];
  }
}

function location(platform: ServiceLocation['platform']): ServiceLocation {
  return { platform, home, dataDir, xdgConfigHome: null };
}

function service(platform: ServiceLocation['platform'], env: NodeJS.ProcessEnv = {}): LoginService {
  return new LoginService({
    location: location(platform),
    manager: fakeServiceCtlCommand(),
    env: { ...process.env, FAKE_SERVICECTL_LOG: log, USERDOMAIN: 'DEVBOX', USERNAME: 'dev', ...env },
    carried: { SWITCHBOARD_WORKSPACE_ROOT: path.join(tmp, 'work space') },
    address: '127.0.0.1:4870',
    settings: store.settings,
    uid: 501,
  });
}

beforeEach(async () => {
  tmp = await makeTempDir('login-service');
  home = path.join(tmp, 'home');
  dataDir = path.join(tmp, 'data');
  log = path.join(tmp, 'servicectl.log');
  store = await openTempStore(tmp);
});

afterEach(async () => {
  await store.close();
  await removeTempDir(tmp);
});

describe('LoginService on macOS (launchd)', () => {
  it('writes the plist for the next login and removes it again, without calling launchctl', async () => {
    const login = service('darwin');
    const plist = servicePaths(location('darwin')).definition;
    expect(await login.status()).toEqual({ manager: 'launchd', startAtLogin: false, file: plist });

    expect(await login.setStartAtLogin(true)).toEqual({ manager: 'launchd', startAtLogin: true, file: plist });
    const content = await readFile(plist, 'utf8');
    const nodePath = /<array>\n\t\t<string>([^<]+)<\/string>/.exec(content)?.[1] ?? '';
    expect(path.isAbsolute(nodePath)).toBe(true);
    expect(content).toBe(
      launchdPlist(
        serviceTarget({
          location: location('darwin'),
          nodePath,
          env: { ...process.env, FAKE_SERVICECTL_LOG: log },
          carried: { SWITCHBOARD_WORKSPACE_ROOT: path.join(tmp, 'work space') },
          address: '127.0.0.1:4870',
          uid: 501,
        }),
      ),
    );
    expect(content).toContain(`<string>${SERVICE_ENTRY}</string>`);
    expect(content).toContain(`<string>${APP_DIR}</string>`);
    // launchd creates the log file, not its folder.
    expect(await exists(path.join(dataDir, 'logs'))).toBe(true);
    expect(await store.settings.get(START_AT_LOGIN_SETTING)).toBe(true);

    expect(await login.setStartAtLogin(false)).toEqual({ manager: 'launchd', startAtLogin: false, file: plist });
    expect(await exists(plist)).toBe(false);
    expect(await store.settings.get(START_AT_LOGIN_SETTING)).toBe(false);
    // Registering for the next login and unregistering never start or stop anything now.
    expect(await ctlCalls()).toEqual([]);
  });
});

describe('LoginService on Linux (systemd --user)', () => {
  it('writes the unit, reloads + enables it; off disables, removes, reloads', async () => {
    const login = service('linux');
    const unit = path.join(home, '.config', 'systemd', 'user', 'switchboard.service');
    expect((await login.setStartAtLogin(true)).startAtLogin).toBe(true);
    const content = await readFile(unit, 'utf8');
    expect(content).toContain('WantedBy=default.target');
    expect(content).toContain(`Environment="SWITCHBOARD_WORKSPACE_ROOT=${path.join(tmp, 'work space')}"`);
    const nodePath = /^ExecStart=(\S+) /m.exec(content)?.[1] ?? '';
    expect(content).toBe(
      systemdUnit(
        serviceTarget({
          location: location('linux'),
          nodePath,
          env: process.env,
          carried: { SWITCHBOARD_WORKSPACE_ROOT: path.join(tmp, 'work space') },
          address: '127.0.0.1:4870',
        }),
      ),
    );
    expect(await login.setStartAtLogin(false)).toMatchObject({ startAtLogin: false });
    expect(await exists(unit)).toBe(false);
    expect(await ctlCalls()).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'enable', 'switchboard.service'],
      ['--user', 'disable', 'switchboard.service'],
      ['--user', 'daemon-reload'],
    ]);
  });
});

describe('LoginService on Windows (Task Scheduler)', () => {
  it('writes the task XML (UTF-16) + env file and registers the task; off deletes it when it exists', async () => {
    const login = service('win32');
    const { definition, envFile } = servicePaths(location('win32'));
    expect(await login.setStartAtLogin(true)).toEqual({ manager: 'task-scheduler', startAtLogin: true, file: definition });
    const bytes = await readFile(definition);
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    const xml = bytes.subarray(2).toString('utf16le');
    expect(xml).toContain('<UserId>DEVBOX\\dev</UserId>');
    expect(await readFile(envFile ?? '', 'utf8')).toContain(`SWITCHBOARD_WORKSPACE_ROOT='${path.join(tmp, 'work space')}'`);
    await login.setStartAtLogin(false);
    expect(await exists(definition)).toBe(false);
    expect(await exists(envFile ?? '')).toBe(false);
    expect(await ctlCalls()).toEqual([
      ['/Create', '/TN', 'Switchboard', '/XML', definition, '/F'],
      ['/Query', '/TN', 'Switchboard'],
      ['/Delete', '/TN', 'Switchboard', '/F'],
    ]);
  });

  it('puts back what it wrote when schtasks /Create fails, and keeps the setting off', async () => {
    const login = service('win32', { FAKE_SERVICECTL_FAIL: '/Create' });
    const { definition, envFile } = servicePaths(location('win32'));
    const error = await login.setStartAtLogin(true).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ code: 'command-failed' });
    expect((error as Error).message).toMatch(/\/Create \/TN Switchboard .* failed: fake-servicectl: \/Create/);
    expect(await exists(definition)).toBe(false);
    expect(await exists(envFile ?? '')).toBe(false);
    expect((await login.status()).startAtLogin).toBe(false);
    expect(await store.settings.get(START_AT_LOGIN_SETTING)).toBeUndefined();
  });

  it('skips /Delete when the task is already gone, and still removes the files', async () => {
    const login = service('win32');
    await login.setStartAtLogin(true);
    const gone = service('win32', { FAKE_SERVICECTL_FAIL: '/Query' });
    expect((await gone.setStartAtLogin(false)).startAtLogin).toBe(false);
    expect((await ctlCalls()).map((argv) => argv[0])).toEqual(['/Create', '/Query']);
  });
});

describe('LoginService refusals', () => {
  it('needs Node ≥ 24 on PATH and writes nothing without it', async () => {
    const login = service('darwin', { PATH: path.join(tmp, 'empty-bin') });
    await expect(login.setStartAtLogin(true)).rejects.toMatchObject({ code: 'node-missing' });
    expect(await exists(home)).toBe(false);
  });

  it('refuses on an unsupported OS', async () => {
    const login = new LoginService({ location: null, env: {}, carried: {}, address: '127.0.0.1:4870' });
    expect(await login.status()).toEqual({ manager: null, startAtLogin: false, file: null });
    await expect(login.setStartAtLogin(true)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('turning off when nothing is registered runs nothing', async () => {
    const login = service('linux');
    expect((await login.setStartAtLogin(false)).startAtLogin).toBe(false);
    expect(await ctlCalls()).toEqual([]);
  });

  it('runs changes one at a time', async () => {
    const login = service('darwin');
    const results = await Promise.all([login.setStartAtLogin(true), login.setStartAtLogin(false), login.setStartAtLogin(true)]);
    expect(results.map((r) => r.startAtLogin)).toEqual([true, false, true]);
    expect((await login.status()).startAtLogin).toBe(true);
  });
});

describe('executePlan', () => {
  it('restores a file it overwrote when a later command fails', async () => {
    const file = path.join(tmp, 'kept.txt');
    await writeFile(file, 'before');
    await expect(
      executePlan(
        {
          platform: 'linux',
          manager: 'systemd',
          action: 'install',
          definition: file,
          steps: [
            { kind: 'write', file: { path: file, content: 'after', encoding: 'utf8' } },
            { kind: 'run', args: ['--user', 'enable', 'x'] },
          ],
        },
        { manager: fakeServiceCtlCommand(), cwd: tmp, env: { ...process.env, FAKE_SERVICECTL_FAIL: 'enable' } },
      ),
    ).rejects.toMatchObject({ code: 'command-failed' });
    expect(await readFile(file, 'utf8')).toBe('before');
  });
});

describe('configuration of the service', () => {
  it('carries the workspace root, and the port / data folder / CLIs only when they differ from the defaults', () => {
    const real = '/Users/dev/Library/Application Support/Switchboard';
    const defaults = loadConfig({ env: {}, platform: 'darwin', home: '/Users/dev', cwd: '/' });
    expect(carriedEnvironment(defaults, real)).toEqual({});
    const custom = loadConfig({
      env: {
        SWITCHBOARD_PORT: '4880',
        SWITCHBOARD_DATA_DIR: '/data/sb',
        SWITCHBOARD_WORKSPACE_ROOT: '/work/space',
        SWITCHBOARD_CLAUDE_BIN: '/opt/claude',
        SWITCHBOARD_GH_BIN: '["/usr/bin/node","/fake/gh.ts"]',
        SWITCHBOARD_CLAUDE_EXTRA_ARGS: '["--model","haiku"]',
        SWITCHBOARD_DEMO: '1',
      },
      platform: 'darwin',
      home: '/Users/dev',
      cwd: '/',
    });
    expect(carriedEnvironment(custom, real)).toEqual({
      SWITCHBOARD_PORT: '4880',
      SWITCHBOARD_DATA_DIR: '/data/sb',
      SWITCHBOARD_WORKSPACE_ROOT: '/work/space',
      SWITCHBOARD_CLAUDE_BIN: '/opt/claude',
      SWITCHBOARD_GH_BIN: '["/usr/bin/node","/fake/gh.ts"]',
    });
  });

  it('writes a clean PATH: absolute folders once each, without what npm prepends while it runs a script', () => {
    const npmPath = [
      '/repo/node_modules/.bin',
      '/node_modules/.bin',
      '/Users/dev/.nvm/versions/node/v24.21.0/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin',
      '/Users/dev/.nvm/versions/node/v24.21.0/bin',
      '~/.dotnet/tools',
      '',
      '/opt/homebrew/bin',
      '/opt/homebrew/bin/',
      '/usr/bin',
    ].join(':');
    expect(cleanSearchPath(npmPath, 'darwin')).toBe('/Users/dev/.nvm/versions/node/v24.21.0/bin:/opt/homebrew/bin:/usr/bin');
    expect(cleanSearchPath('C:\\repo\\node_modules\\.bin;C:\\Program Files\\nodejs;c:\\program files\\nodejs\\;relative', 'win32')).toBe('C:\\Program Files\\nodejs');
    expect(withCleanSearchPath({ Path: 'C:\\a;C:\\a', X: '1' }, 'win32')).toEqual({ Path: 'C:\\a', X: '1' });
    const target = serviceTarget({ location: { platform: 'linux', home: '/h', dataDir: '/d', xdgConfigHome: null }, nodePath: '/usr/bin/node', env: { PATH: npmPath }, carried: {}, address: 'a' });
    expect(target.searchPath).toBe('/Users/dev/.nvm/versions/node/v24.21.0/bin:/opt/homebrew/bin:/usr/bin');
    expect(serviceTarget({ location: { platform: 'win32', home: 'C:\\h', dataDir: 'C:\\d', xdgConfigHome: null }, nodePath: 'n', env: { PATH: '/x' }, carried: {}, address: 'a' }).searchPath).toBeNull();
  });

  it('takes the test redirects only together, with an absolute home', () => {
    expect(loadServiceRedirect({})).toBeNull();
    expect(loadServiceRedirect({ SWITCHBOARD_SERVICE_HOME: '/tmp/h', SWITCHBOARD_SERVICE_CTL: fakeServiceCtlEnv() })).toEqual({
      home: '/tmp/h',
      manager: fakeServiceCtlCommand(),
    });
    expect(() => loadServiceRedirect({ SWITCHBOARD_SERVICE_HOME: '/tmp/h' })).toThrow(ConfigError);
    expect(() => loadServiceRedirect({ SWITCHBOARD_SERVICE_CTL: 'launchctl' })).toThrow(ConfigError);
    expect(() => loadServiceRedirect({ SWITCHBOARD_SERVICE_HOME: 'rel', SWITCHBOARD_SERVICE_CTL: 'x' })).toThrow(ConfigError);
  });

  it('locates the files per OS; a redirect ignores XDG_CONFIG_HOME', () => {
    expect(serviceLocation({ platform: 'freebsd', dataDir: '/d', env: {}, redirect: null })).toBeNull();
    expect(serviceLocation({ platform: 'linux', dataDir: '/d', env: { XDG_CONFIG_HOME: '/xdg' }, redirect: null, home: '/home/dev' })).toEqual({
      platform: 'linux',
      home: '/home/dev',
      dataDir: '/d',
      xdgConfigHome: '/xdg',
    });
    expect(serviceLocation({ platform: 'linux', dataDir: '/d', env: { XDG_CONFIG_HOME: '/xdg' }, redirect: { home: '/tmp/h', manager: ['x'] } })).toEqual({
      platform: 'linux',
      home: '/tmp/h',
      dataDir: '/d',
      xdgConfigHome: null,
    });
    expect(windowsUser({ USERDOMAIN: 'DEVBOX', USERNAME: 'dev' })).toBe('DEVBOX\\dev');
    expect(windowsUser({ USERNAME: 'dev' })).toBe('dev');
  });

  it('createLoginService follows the redirect: files under the temp home, the fake as the manager', async () => {
    const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: dataDir }, cwd: tmp }) };
    const login = createLoginService({
      config,
      settings: store.settings,
      redirect: { home, manager: fakeServiceCtlCommand() },
      env: { ...process.env, FAKE_SERVICECTL_LOG: log },
      platform: 'linux',
    });
    const status = await login.setStartAtLogin(true);
    expect(status.file).toBe(path.join(home, '.config', 'systemd', 'user', 'switchboard.service'));
    expect(await readFile(status.file ?? '', 'utf8')).toContain(`Environment="SWITCHBOARD_DATA_DIR=${dataDir}"`);
    expect(await readdir(home)).toEqual(['.config']);
    expect((await ctlCalls()).length).toBe(2);
  });
});

describe('demo "Start at login"', () => {
  it('is an in-memory flag that starts on and never touches the OS', async () => {
    const demo = createDemoLoginService();
    expect((await demo.status()).startAtLogin).toBe(true);
    expect((await demo.setStartAtLogin(false)).startAtLogin).toBe(false);
    expect((await demo.status()).startAtLogin).toBe(false);
  });
});
