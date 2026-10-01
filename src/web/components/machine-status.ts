import { type MachineConnection, type SessionMachine, offlineReason } from '../../core/peers.ts';

/**
 * Fix · peer reconnects (`docs/peers.md` → *Connection states*): the words of a
 * paired machine's connection everywhere it shows (the session header, the
 * composer, Settings → Machines): what it is doing, the countdown to the next
 * try, the last error in plain words and when it happened, and a hint.
 */
export interface MachineStatusView {
  /** The main line: `Reconnecting to studio-pc… · attempt 3 · next try in 8 s`, `studio-pc is unreachable · retrying in 8 s`. */
  readonly line: string;
  /** `Last error 14:05:09: connection refused — …`; `null` when none is known. */
  readonly detail: string | null;
  /** E.g. `Check that studio-pc is awake and on Tailscale.` */
  readonly hint: string | null;
  /** A spinner: reconnecting, or an attempt is running. */
  readonly busy: boolean;
  /** **Reconnect now** is offered (reconnecting or offline; not for a refused pairing or no address). */
  readonly canReconnect: boolean;
  /** Interaction is blocked (offline, auth failed, no address); `false` while reconnecting. */
  readonly blocking: boolean;
}

/** `HH:MM:SS` local time of an ISO stamp. */
export function clockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
}

/** Whole seconds until `iso` (at least 0); `null` without a time. */
export function secondsUntil(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** The countdown part: `next try in 8 s`, `trying now…`; `null` when nothing is scheduled. */
function nextTry(connection: MachineConnection | null | undefined, now: number, words: 'next try in' | 'retrying in'): string | null {
  if (!connection) return null;
  if (connection.trying) return 'trying now…';
  const left = secondsUntil(connection.nextAttemptAt, now);
  if (left === null) return null;
  return left === 0 ? 'trying now…' : `${words} ${left} s`;
}

/** The status of `machine` (its live state) with its connection details; `null` while it is online (or for this machine). */
export function machineStatusView(machine: SessionMachine | null | undefined, connection: MachineConnection | null | undefined, now: number): MachineStatusView | null {
  if (!machine || machine.state === 'online') return null;
  const detail = connection?.lastFailure ? `Last error ${clockTime(connection.lastFailure.at)}: ${connection.lastFailure.message}` : null;
  const hint = connection?.hint ?? null;
  if (machine.state === 'reconnecting') {
    const parts = [`Reconnecting to ${machine.name}…`];
    const attempt = connection?.attempt ?? 0;
    if (attempt > 0) parts.push(`attempt ${attempt + 1}`);
    const next = nextTry(connection, now, 'next try in');
    if (next && !(attempt === 0 && next === 'trying now…')) parts.push(next);
    return { line: parts.join(' · '), detail, hint, busy: true, canReconnect: true, blocking: false };
  }
  if (machine.state === 'offline') {
    const parts = [offlineReason(machine) ?? `${machine.name} is unreachable`];
    const next = nextTry(connection, now, 'retrying in');
    if (next) parts.push(next);
    return { line: parts.join(' · '), detail, hint, busy: connection?.trying === true, canReconnect: true, blocking: true };
  }
  return { line: offlineReason(machine) ?? machine.name, detail, hint: null, busy: false, canReconnect: false, blocking: true };
}
