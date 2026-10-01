import { describe, expect, it } from 'vitest';
import { HUB_EVENT_NAMES } from '../../src/core/api.ts';
import { PEER_HUB_EVENTS } from '../../src/core/peer-wire.ts';
import { type MachineState, type PeerFailureKind, connectionHint, machineTagSuffix, offlineReason, peerFailureText, reconnectingNote } from '../../src/core/peers.ts';

/** Fix · peer reconnects: the shared words of a paired machine's connection states. */

const machine = (state: MachineState) => ({ id: 'abcdefghijkl', name: 'studio-pc', state });

describe('offlineReason / reconnectingNote', () => {
  it('blocks nothing while online or reconnecting; says why otherwise', () => {
    expect(offlineReason(null)).toBeNull();
    expect(offlineReason(machine('online'))).toBeNull();
    expect(offlineReason(machine('reconnecting'))).toBeNull();
    expect(offlineReason(machine('offline'))).toBe('studio-pc is unreachable');
    expect(offlineReason(machine('auth-failed'))).toBe('studio-pc refused this pairing — pair again in Settings → Machines');
    expect(offlineReason(machine('no-address'))).toBe('studio-pc has not told its address (its peer listener is off)');
  });

  it('the reconnecting note', () => {
    expect(reconnectingNote(machine('reconnecting'))).toBe('Reconnecting to studio-pc…');
    expect(reconnectingNote(machine('offline'))).toBeNull();
    expect(reconnectingNote(undefined)).toBeNull();
  });
});

describe('machineTagSuffix', () => {
  it('names every state but online', () => {
    expect((['online', 'reconnecting', 'offline', 'auth-failed', 'no-address'] as const).map(machineTagSuffix)).toEqual([null, 'reconnecting…', 'unreachable', 'auth failed', 'no address']);
  });
});

describe('connectionHint', () => {
  it('hints at sleep / Tailscale only when the last (at least 3) failures were all timeouts', () => {
    expect(connectionHint('studio-pc', ['timeout', 'timeout', 'timeout'])).toBe('Check that studio-pc is awake and on Tailscale.');
    expect(connectionHint('studio-pc', ['timeout', 'timeout'])).toBeNull();
    expect(connectionHint('studio-pc', ['refused', 'timeout', 'timeout'])).toBeNull();
    expect(connectionHint('studio-pc', [])).toBeNull();
  });
});

describe('peerFailureText', () => {
  it('has plain words for every kind', () => {
    const kinds: PeerFailureKind[] = ['refused', 'timeout', 'route', 'auth', 'http', 'reset', 'ended', 'stalled', 'restart', 'other'];
    for (const kind of kinds) expect(peerFailureText(kind), kind).toMatch(/^[a-z]/);
    expect(peerFailureText('refused')).toMatch(/connection refused/);
  });
});

describe('the machineState hub event', () => {
  it('is a /hub event of this machine only (never on the peer event stream)', () => {
    expect(HUB_EVENT_NAMES).toContain('machineState');
    expect(PEER_HUB_EVENTS.has('machineState')).toBe(false);
  });
});
