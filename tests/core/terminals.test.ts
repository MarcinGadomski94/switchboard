import { describe, expect, it } from 'vitest';
import { TERMINAL_INPUT_MAX, parseClientFrame, shellLabel, terminalEnv, terminalIdleHours, terminalSize } from '../../src/core/terminals.ts';

/** D170 (`docs/terminals.md`): the socket's client frames, the start size, the idle setting and a terminal's environment. */

describe('the terminal socket’s client frames', () => {
  it('reads input and resize; drops anything malformed, oversized or out of range', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'in', d: 'ls\r' }))).toEqual({ t: 'in', d: 'ls\r' });
    expect(parseClientFrame(JSON.stringify({ t: 'resize', cols: 120, rows: 40 }))).toEqual({ t: 'resize', cols: 120, rows: 40 });
    expect(parseClientFrame('not json')).toBeNull();
    expect(parseClientFrame('null')).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'in', d: 42 }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'in', d: 'x'.repeat(TERMINAL_INPUT_MAX + 1) }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'resize', cols: 1, rows: 40 }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'resize', cols: 80.5, rows: 40 }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'resize', cols: 80, rows: 5000 }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'exec', d: 'rm -rf /' }))).toBeNull();
  });

  it('a start size falls back to 80 × 24; the idle setting to 12 hours', () => {
    expect(terminalSize(100, 30)).toEqual({ cols: 100, rows: 30 });
    expect(terminalSize('100', undefined)).toEqual({ cols: 80, rows: 24 });
    expect(terminalIdleHours(0)).toBe(0);
    expect(terminalIdleHours(48)).toBe(48);
    expect(terminalIdleHours(-1)).toBe(12);
    expect(terminalIdleHours('3')).toBe(12);
    expect(terminalIdleHours(1000)).toBe(12);
  });
});

describe('a terminal’s environment', () => {
  it('keeps the user’s own variables, drops Switchboard’s and its launcher’s, and sets a colour terminal', () => {
    const env = terminalEnv({
      PATH: '/usr/bin',
      HOME: '/home/me',
      GITHUB_TOKEN: 'the-users-own',
      SWITCHBOARD_DATA_DIR: '/data',
      SWITCHBOARD_SESSION: 's1',
      switchboard_port: '13001',
      npm_lifecycle_event: 'start',
      VITEST_WORKER_ID: '1',
      EMPTY: undefined,
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/me', GITHUB_TOKEN: 'the-users-own', TERM: 'xterm-256color', COLORTERM: 'truecolor' });
  });

  it('labels the shells', () => {
    expect(shellLabel('default', 'win32')).toBe('PowerShell');
    expect(shellLabel('default', 'darwin')).toBe('Login shell');
    expect(shellLabel('pwsh', 'linux')).toBe('PowerShell 7');
    expect(shellLabel('cmd', 'win32')).toBe('Command Prompt');
  });
});
