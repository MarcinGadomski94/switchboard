import type { Machine, MachineState, PeerListenerState } from '../../../core/peers.ts';

/**
 * Pure helpers of Settings → Machines (D48, `docs/peers.md`): the copy of a
 * machine's state and of the peer listener row.
 */

/** A machine's state as the list shows it. */
export function machineStateLabel(state: MachineState): string {
  switch (state) {
    case 'online':
      return 'online';
    case 'offline':
      return 'offline';
    case 'auth-failed':
      return 'auth failed';
    case 'no-address':
      return 'no address';
  }
}

/** The state dot's color: green online, amber no address, red auth failed, grey offline. */
export function machineStateColor(state: MachineState): string {
  switch (state) {
    case 'online':
      return '#34c38f';
    case 'no-address':
      return '#e0a44a';
    case 'auth-failed':
      return '#e5534b';
    case 'offline':
      return '#6c6b67';
  }
}

/** The machine's second line: its address and why it is not online. */
export function machineDetail(machine: Machine): string {
  const parts = [machine.address ?? 'address unknown (its peer listener is off)'];
  if (machine.state !== 'online' && machine.lastError) parts.push(machine.lastError);
  return parts.join(' · ');
}

/** The listener row's description. */
export function listenerDescription(listener: PeerListenerState): string {
  if (listener.listening) return `Paired machines reach this one at ${listener.listening} (Tailscale only). The UI stays on 127.0.0.1.`;
  if (listener.enabled && listener.error) return listener.error;
  return `Off: other machines cannot reach this one. On: the peer API listens on this machine's Tailscale address, port ${listener.port}.`;
}

/** Seconds left of a pairing code, as `m:ss`; `null` once it expired. */
export function codeTimeLeft(expiresAt: string, now: number): string | null {
  const left = Math.floor((Date.parse(expiresAt) - now) / 1000);
  if (!(left > 0)) return null;
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

/** A refused action's text from the API's `{ message }` body. */
export function refusalText(body: unknown, fallback: string): string {
  const message = typeof body === 'object' && body !== null ? (body as { message?: unknown }).message : null;
  return typeof message === 'string' && message !== '' ? message : fallback;
}
