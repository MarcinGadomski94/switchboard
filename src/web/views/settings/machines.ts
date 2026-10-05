import type { HooksStatus, TerminalSession } from '../../../core/api.ts';
import type { Machine, MachineSidebarSync, MachineState, PeerListenerState } from '../../../core/peers.ts';

/**
 * Pure helpers of Settings → Machines (D48, `docs/peers.md`): the copy of a
 * machine's state and of the peer listener row.
 */

/** A machine's state as the list shows it. */
export function machineStateLabel(state: MachineState): string {
  switch (state) {
    case 'online':
      return 'online';
    case 'reconnecting':
      return 'reconnecting…';
    case 'offline':
      return 'unreachable';
    case 'auth-failed':
      return 'auth failed';
    case 'no-address':
      return 'no address';
  }
}

/** The state dot's color: green online, blue reconnecting, amber no address, red auth failed, grey offline. */
export function machineStateColor(state: MachineState): string {
  switch (state) {
    case 'online':
      return '#34c38f';
    case 'reconnecting':
      return '#8ab4e8';
    case 'no-address':
      return '#e0a44a';
    case 'auth-failed':
      return '#e5534b';
    case 'offline':
      return '#6c6b67';
  }
}

/**
 * The machine's second line: its address, and (fix · peer reconnects) why it is
 * not online when no status line says so (an older service without `connection`).
 */
export function machineDetail(machine: Machine): string {
  const parts = [machine.address ?? 'address unknown (its peer listener is off)'];
  if (machine.state !== 'online' && machine.lastError && !machine.connection) parts.push(machine.lastError);
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

/** D48 P4: the hooks' state line. */
export function hooksStateLabel(status: HooksStatus): string {
  switch (status.state) {
    case 'installed':
      return status.rewake === 'internal' ? 'Terminal hooks: installed' : 'Terminal hooks: installed (plain wake-up wording)';
    case 'outdated':
      return 'Terminal hooks: outdated (update them so idle sessions stay reachable)';
    case 'none':
      return 'Terminal hooks: not installed';
    case 'unreadable':
      return `Terminal hooks: ${status.error ?? 'the settings file cannot be read'}`;
  }
}

/** D48 P4: a terminal session's line in the picker: its name, folder and status. */
export function terminalLine(terminal: TerminalSession): string {
  const parts = [terminal.name ?? terminal.id.slice(0, 8), terminal.cwd ?? 'folder unknown'];
  const status = terminal.waitingFor ? `waiting (${terminal.waitingFor})` : terminal.status;
  if (status) parts.push(status);
  if (!terminal.hookSeen) parts.push('hooks not seen yet: messages wake it after its next turn');
  return parts.join(' · ');
}

/**
 * D71: the text after a machine's "Share sidebar layout" switch (`docs/peers.md`
 * → *Shared sidebar layout (D71)*); `null` when the machine's service does not
 * report it (an older Switchboard here never happens: the row comes from this
 * service).
 */
export function sidebarSyncText(name: string, sync: MachineSidebarSync | undefined): string {
  if (!sync || !sync.enabled) return `Off: this machine's pins, folders and order stay its own. On: the same sidebar layout on both machines (merged the first time; ${name} must switch it on too).`;
  switch (sync.state) {
    case 'connecting':
      return 'On: connecting…';
    case 'waiting':
      return `On here; waiting for ${name} to switch it on too (Settings → Machines there).`;
    case 'unsupported':
      return `Update ${name} to sync folders: its Switchboard does not share the sidebar layout yet.`;
    case 'synced':
      return `On: the same pins, folders and order on both machines${sync.mergedAt ? '' : ' (merging…)'}. Folders collapse on each machine on its own.`;
    case 'unreachable':
      return `On: ${name} cannot be reached now; it catches up when it is back.`;
    case 'error':
      return `On: the last exchange failed${sync.error ? ` (${sync.error})` : ''}; it is tried again at the next change.`;
    default:
      return 'On.';
  }
}
