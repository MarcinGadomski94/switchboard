import { describe, expect, it } from 'vitest';
import type { MachineConnection, MachineState } from '../../src/core/peers.ts';
import { clockTime, machineStatusView, secondsUntil } from '../../src/web/components/machine-status.ts';
import { machineDetail, machineStateColor, machineStateLabel } from '../../src/web/views/settings/machines.ts';

/** Fix · peer reconnects: the status words, countdown and Reconnect now offer of a paired machine. */

const NOW = Date.parse('2026-10-01T10:00:00.000Z');
const machine = (state: MachineState) => ({ id: 'abcdefghijkl', name: 'studio-pc', state });
const at = (ms: number) => new Date(NOW + ms).toISOString();
const connection = (patch: Partial<MachineConnection> = {}): MachineConnection => ({ attempt: 0, trying: false, nextAttemptAt: null, graceUntil: null, lastFailure: null, hint: null, ...patch });

describe('machineStatusView', () => {
  it('nothing while online (or for this machine)', () => {
    expect(machineStatusView(machine('online'), connection(), NOW)).toBeNull();
    expect(machineStatusView(null, null, NOW)).toBeNull();
  });

  it('reconnecting: a spinner, the attempt and the countdown; nothing blocked; Reconnect now offered', () => {
    expect(machineStatusView(machine('reconnecting'), connection({ trying: true }), NOW)).toEqual({
      line: 'Reconnecting to studio-pc…',
      detail: null,
      hint: null,
      busy: true,
      canReconnect: true,
      blocking: false,
    });
    const view = machineStatusView(machine('reconnecting'), connection({ attempt: 2, nextAttemptAt: at(7_200), lastFailure: { kind: 'refused', message: 'connection refused — is Switchboard running there with its peer listener on?', at: at(-1_000) } }), NOW);
    expect(view?.line).toBe('Reconnecting to studio-pc… · attempt 3 · next try in 8 s');
    expect(view?.blocking).toBe(false);
    expect(view?.detail).toBe(`Last error ${clockTime(at(-1_000))}: connection refused — is Switchboard running there with its peer listener on?`);
    expect(machineStatusView(machine('reconnecting'), connection({ attempt: 2, trying: true }), NOW)?.line).toBe('Reconnecting to studio-pc… · attempt 3 · trying now…');
  });

  it('offline: unreachable with the countdown, the last error, the hint; blocked; Reconnect now offered', () => {
    const view = machineStatusView(
      machine('offline'),
      connection({ attempt: 6, nextAttemptAt: at(8_000), lastFailure: { kind: 'timeout', message: 'no answer in time', at: at(-7_000) }, hint: 'Check that studio-pc is awake and on Tailscale.' }),
      NOW,
    );
    expect(view).toEqual({
      line: 'studio-pc is unreachable · retrying in 8 s',
      detail: `Last error ${clockTime(at(-7_000))}: no answer in time`,
      hint: 'Check that studio-pc is awake and on Tailscale.',
      busy: false,
      canReconnect: true,
      blocking: true,
    });
    expect(machineStatusView(machine('offline'), connection({ trying: true }), NOW)).toMatchObject({ line: 'studio-pc is unreachable · trying now…', busy: true });
    expect(machineStatusView(machine('offline'), connection({ nextAttemptAt: at(-50) }), NOW)?.line).toBe('studio-pc is unreachable · trying now…');
    // An older service without `connection`: the plain line.
    expect(machineStatusView(machine('offline'), undefined, NOW)?.line).toBe('studio-pc is unreachable');
  });

  it('auth failed and no address: blocked, no Reconnect now', () => {
    expect(machineStatusView(machine('auth-failed'), connection(), NOW)).toMatchObject({ line: 'studio-pc refused this pairing — pair again in Settings → Machines', canReconnect: false, blocking: true, busy: false });
    expect(machineStatusView(machine('no-address'), connection(), NOW)).toMatchObject({ canReconnect: false, blocking: true });
  });

  it('the countdown counts whole seconds up', () => {
    expect(secondsUntil(at(7_001), NOW)).toBe(8);
    expect(secondsUntil(at(8_000), NOW)).toBe(8);
    expect(secondsUntil(at(-1), NOW)).toBe(0);
    expect(secondsUntil(null, NOW)).toBeNull();
    expect(clockTime('2026-10-01T10:00:00')).toBe('10:00:00');
  });
});

describe('Settings → Machines words', () => {
  it('labels and colors every state', () => {
    expect((['online', 'reconnecting', 'offline', 'auth-failed', 'no-address'] as const).map(machineStateLabel)).toEqual(['online', 'reconnecting…', 'unreachable', 'auth failed', 'no address']);
    expect(new Set((['online', 'reconnecting', 'offline', 'auth-failed', 'no-address'] as const).map(machineStateColor)).size).toBe(5);
  });

  it('the detail line keeps the address only when the status line tells the error', () => {
    const base = { id: 'abcdefghijkl', name: 'studio-pc', address: '100.64.0.7:13002', state: 'offline' as const, lastError: 'connection refused', lastSeenAt: null, pairedAt: at(0) };
    expect(machineDetail({ ...base, connection: connection() })).toBe('100.64.0.7:13002');
    expect(machineDetail(base)).toBe('100.64.0.7:13002 · connection refused');
  });
});
