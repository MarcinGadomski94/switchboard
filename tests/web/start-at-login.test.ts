import { describe, expect, it } from 'vitest';
import {
  START_AT_LOGIN_DESCRIPTION,
  START_AT_LOGIN_LABEL,
  changeErrorText,
  toggleView,
} from '../../src/web/views/settings/start-at-login.ts';

/** M9.1: the "Start at login" value in Settings (`docs/service.md` → *The toggle*). */

const ON = { manager: 'launchd' as const, startAtLogin: true, file: '/Users/dev/Library/LaunchAgents/local.switchboard.plist' };
const OFF = { ...ON, startAtLogin: false };

describe('toggleView', () => {
  it('shows on / off from the service, clickable unless a change is running', () => {
    expect(toggleView({ status: ON, loadError: null, busy: false })).toEqual({
      text: 'on',
      checked: true,
      disabled: false,
      title: `Registered: ${ON.file} · click to turn off`,
    });
    expect(toggleView({ status: OFF, loadError: null, busy: false })).toEqual({ text: 'off', checked: false, disabled: false, title: 'Click to turn on' });
    expect(toggleView({ status: OFF, loadError: null, busy: true }).disabled).toBe(true);
  });

  it('never guesses: loading, not available, unknown, not supported cannot be clicked', () => {
    expect(toggleView({ status: null, loadError: null, busy: false })).toMatchObject({ text: '…', disabled: true });
    expect(toggleView({ status: null, loadError: 501, busy: false })).toMatchObject({ text: 'unavailable', disabled: true });
    expect(toggleView({ status: null, loadError: 500, busy: false })).toMatchObject({ text: 'unknown', disabled: true });
    expect(toggleView({ status: { manager: null, startAtLogin: false, file: null }, loadError: null, busy: false })).toMatchObject({
      text: 'not supported',
      disabled: true,
    });
  });
});

describe('copy', () => {
  it('uses the prototype row verbatim', () => {
    expect(START_AT_LOGIN_LABEL).toBe('Start at login');
    expect(START_AT_LOGIN_DESCRIPTION).toBe('Launch the service when you sign in (Windows / macOS)');
  });

  it('shows the service message after a failed change, else a fixed line', () => {
    expect(changeErrorText({ error: 'node-missing', message: 'Node.js ≥ 24 must be on PATH: no node was found there.' })).toBe(
      'Node.js ≥ 24 must be on PATH: no node was found there.',
    );
    expect(changeErrorText(null)).toBe('Start at login could not be changed.');
    expect(changeErrorText({ message: '  ' })).toBe('Start at login could not be changed.');
  });
});
