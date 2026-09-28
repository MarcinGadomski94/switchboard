import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_PORT, LOOPBACK_HOST, defaultDataDir, loadConfig } from '../../src/server/config.ts';

const HOME = '/Users/dev';
const CWD = '/tmp/switchboard-cwd';

describe('loadConfig', () => {
  it('uses the documented defaults (D14: no workspace setting; sessions pick saved folders)', () => {
    const config = loadConfig({ env: {}, platform: 'darwin', home: HOME, cwd: CWD });
    expect(config).toEqual({
      host: '127.0.0.1',
      port: 4870,
      dataDir: '/Users/dev/Library/Application Support/Switchboard',
      claudeCommand: ['claude'],
      claudeExtraArgs: [],
      ghCommand: ['gh'],
      demo: false,
      openCommand: null,
    });
    expect(DEFAULT_PORT).toBe(4870);
    expect(LOOPBACK_HOST).toBe('127.0.0.1');
  });

  it('reads every SWITCHBOARD_* variable', () => {
    const config = loadConfig({
      env: {
        SWITCHBOARD_PORT: '4875',
        SWITCHBOARD_DATA_DIR: 'data',
        SWITCHBOARD_CLAUDE_BIN: '["/usr/bin/node","/repo/tools/fake-claude/main.ts"]',
        SWITCHBOARD_CLAUDE_EXTRA_ARGS: '["--model","haiku","--max-turns","3"]',
        SWITCHBOARD_GH_BIN: '/opt/bin/gh',
        SWITCHBOARD_DEMO: '1',
      },
      platform: 'linux',
      home: HOME,
      cwd: CWD,
    });
    expect(config.port).toBe(4875);
    expect(config.dataDir).toBe('/tmp/switchboard-cwd/data');
    expect(config.claudeCommand).toEqual(['/usr/bin/node', '/repo/tools/fake-claude/main.ts']);
    expect(config.claudeExtraArgs).toEqual(['--model', 'haiku', '--max-turns', '3']);
    expect(config.ghCommand).toEqual(['/opt/bin/gh']);
    expect(config.demo).toBe(true);
  });

  it('has no bind-address setting: the host stays 127.0.0.1', () => {
    const config = loadConfig({ env: { SWITCHBOARD_HOST: '0.0.0.0', HOST: '0.0.0.0' }, platform: 'linux', home: HOME, cwd: CWD });
    expect(config.host).toBe('127.0.0.1');
  });

  it('treats a value that does not start with "[" as one executable path', () => {
    const config = loadConfig({ env: { SWITCHBOARD_GH_BIN: '  /opt/my tools/gh  ' }, platform: 'linux', home: HOME, cwd: CWD });
    expect(config.ghCommand).toEqual(['/opt/my tools/gh']);
  });

  it('turns demo on only for SWITCHBOARD_DEMO=1', () => {
    for (const value of ['0', 'true', 'yes', '', ' 1']) {
      expect(loadConfig({ env: { SWITCHBOARD_DEMO: value }, platform: 'linux', home: HOME, cwd: CWD }).demo).toBe(false);
    }
  });

  it.each(['abc', '0', '65536', '48.7', '-1', '4870x'])('rejects SWITCHBOARD_PORT=%s', (value) => {
    expect(() => loadConfig({ env: { SWITCHBOARD_PORT: value }, platform: 'linux', home: HOME, cwd: CWD })).toThrow(ConfigError);
  });

  it.each(['[', '[]', '["node", 3]', '[""]', '["node",'])('rejects SWITCHBOARD_CLAUDE_BIN=%s', (value) => {
    expect(() => loadConfig({ env: { SWITCHBOARD_CLAUDE_BIN: value }, platform: 'linux', home: HOME, cwd: CWD })).toThrow(ConfigError);
  });
});

describe('SWITCHBOARD_CLAUDE_EXTRA_ARGS (M2.1, dev-only)', () => {
  it('blank means none', () => {
    expect(loadConfig({ env: { SWITCHBOARD_CLAUDE_EXTRA_ARGS: '  ' }, platform: 'linux', home: HOME, cwd: CWD }).claudeExtraArgs).toEqual([]);
  });

  it.each(['--model haiku', '[', '["--model", 3]', '[""]', '{"a":1}'])('rejects %s', (value) => {
    expect(() => loadConfig({ env: { SWITCHBOARD_CLAUDE_EXTRA_ARGS: value }, platform: 'linux', home: HOME, cwd: CWD })).toThrow(
      ConfigError,
    );
  });
});

describe('SWITCHBOARD_OPEN_COMMAND (D35, tests / development)', () => {
  it('unset or blank: the openers run themselves (null)', () => {
    expect(loadConfig({ env: {}, platform: 'linux', home: HOME, cwd: CWD }).openCommand).toBeNull();
    expect(loadConfig({ env: { SWITCHBOARD_OPEN_COMMAND: '  ' }, platform: 'linux', home: HOME, cwd: CWD }).openCommand).toBeNull();
  });

  it('an argv prefix: one executable, or a JSON array', () => {
    expect(loadConfig({ env: { SWITCHBOARD_OPEN_COMMAND: ' /opt/my tools/opener ' }, platform: 'linux', home: HOME, cwd: CWD }).openCommand).toEqual([
      '/opt/my tools/opener',
    ]);
    expect(
      loadConfig({ env: { SWITCHBOARD_OPEN_COMMAND: '["/usr/bin/node","/repo/tools/fake-opener/main.ts"]' }, platform: 'linux', home: HOME, cwd: CWD }).openCommand,
    ).toEqual(['/usr/bin/node', '/repo/tools/fake-opener/main.ts']);
  });

  it.each(['[', '[]', '["node", 3]', '[""]'])('rejects %s', (value) => {
    expect(() => loadConfig({ env: { SWITCHBOARD_OPEN_COMMAND: value }, platform: 'linux', home: HOME, cwd: CWD })).toThrow(ConfigError);
  });
});

describe('defaultDataDir (gap #18)', () => {
  it('macOS: ~/Library/Application Support/Switchboard', () => {
    expect(defaultDataDir('darwin', {}, HOME)).toBe('/Users/dev/Library/Application Support/Switchboard');
  });

  it('Windows: %LOCALAPPDATA%\\Switchboard, else ~\\AppData\\Local\\Switchboard', () => {
    expect(defaultDataDir('win32', { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' }, 'C:\\Users\\dev')).toBe(
      'C:\\Users\\dev\\AppData\\Local\\Switchboard',
    );
    expect(defaultDataDir('win32', {}, 'C:\\Users\\dev')).toBe('C:\\Users\\dev\\AppData\\Local\\Switchboard');
  });

  it('Linux: $XDG_DATA_HOME/switchboard, else ~/.local/share/switchboard', () => {
    expect(defaultDataDir('linux', {}, '/home/dev')).toBe('/home/dev/.local/share/switchboard');
    expect(defaultDataDir('linux', { XDG_DATA_HOME: '/data/xdg' }, '/home/dev')).toBe('/data/xdg/switchboard');
    expect(defaultDataDir('linux', { XDG_DATA_HOME: 'relative' }, '/home/dev')).toBe('/home/dev/.local/share/switchboard');
  });
});
