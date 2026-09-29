/**
 * D48 "Switchboard peers" (`docs/peers.md`): the pure part. Any Switchboard can
 * pair with any other over Tailscale; each side then shows the other's sessions
 * and Inbox items next to its own. This module holds what the server and the UI
 * share: the machine wire types, remote ids (a peer's ids namespaced so they never
 * collide with local ones), the address rules of the peer listener and the
 * pairing-code format. Everything here is side-effect free.
 */

/** How the local service sees a paired machine right now. */
export type MachineState =
  /** Connected: the peer's live event stream is open. */
  | 'online'
  /** Not connected yet, or reconnecting after a drop (backoff). */
  | 'offline'
  /** The peer refused our token (401): revoked there, or the pairing is gone. */
  | 'auth-failed'
  /** The peer never told us an address it listens on (its peer listener is off); it can still call us. */
  | 'no-address';

/** A paired machine (`GET /api/machines`, D48). */
export interface Machine {
  /** The peer's own id (random, stable per install): the namespace of its remote ids. */
  readonly id: string;
  /** The name shown in tags (the peer's host name at pairing; renamable here). */
  readonly name: string;
  /** Where its peer listener is (`100.x.y.z:13002`), `null` when unknown. */
  readonly address: string | null;
  readonly state: MachineState;
  /** Why the last connection attempt failed; `null` while online or before the first. */
  readonly lastError: string | null;
  /** Last successful contact (ISO), `null` before the first. */
  readonly lastSeenAt: string | null;
  readonly pairedAt: string;
}

/** The local peer listener (`GET /api/machines`, `PUT /api/machines/listener`). */
export interface PeerListenerState {
  /** The developer's switch (Settings → Machines); off by default. */
  readonly enabled: boolean;
  /** The configured address; `null` = the Tailscale IPv4 (`tailscale ip -4`). */
  readonly configuredAddress: string | null;
  readonly port: number;
  /** The address it listens on right now; `null` while it does not listen. */
  readonly listening: string | null;
  /** Why it does not listen although enabled; `null` otherwise. */
  readonly error: string | null;
}

/** `GET /api/machines` (D48). */
export interface MachinesView {
  /** This install: its id (the namespace other machines use for its ids) and name. */
  readonly self: { readonly id: string; readonly name: string };
  readonly listener: PeerListenerState;
  readonly machines: readonly Machine[];
}

/** `PUT /api/machines/listener` body: every field optional (a field left out keeps its value). */
export interface PeerListenerInput {
  readonly enabled?: boolean;
  /** `null` or blank = the Tailscale IPv4. */
  readonly address?: string | null;
  readonly port?: number;
}

/** `POST /api/machines/pairing-code` answer: the one-time code to type on the other machine. */
export interface PairingCode {
  readonly code: string;
  readonly expiresAt: string;
}

/** `POST /api/machines` body: pair with the machine at `address` using its code. */
export interface AddMachineInput {
  /** `100.x.y.z` or `100.x.y.z:<port>` (default port {@link DEFAULT_PEER_PORT}). */
  readonly address: string;
  readonly code: string;
}

/** Which machine a session runs on (additive `Session.machine`, D48): only on a peer's sessions. */
export interface SessionMachine {
  readonly id: string;
  readonly name: string;
  readonly state: MachineState;
}

/** The peer listener's default port (the UI keeps 13001 on 127.0.0.1). */
export const DEFAULT_PEER_PORT = 13002;

/** How long a pairing code lives. */
export const PAIRING_CODE_TTL_MS = 10 * 60_000;

/** A pairing code stops working after this many wrong tries (it must be made again). */
export const PAIRING_MAX_FAILURES = 5;

/** Pairing code alphabet: Crockford base32 without the look-alikes (no I, L, O, U). */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A pairing code: 8 characters shown as `XXXX-XXXX`. */
export const PAIRING_CODE_LENGTH = 8;

/**
 * A code from random bytes (at least {@link PAIRING_CODE_LENGTH}), shown as
 * `XXXX-XXXX`. 8 characters of 32 = 40 bits; with single use, a 10-minute life and
 * {@link PAIRING_MAX_FAILURES} tries it cannot be guessed.
 */
export function pairingCodeFrom(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) text += CODE_ALPHABET[(bytes[i] ?? 0) % CODE_ALPHABET.length];
  return `${text.slice(0, 4)}-${text.slice(4)}`;
}

/**
 * The typed code in its canonical form (`XXXX-XXXX`): case and separators do not
 * matter, look-alikes are read as the digits they resemble (O → 0, I / L → 1);
 * `null` when it cannot be a code.
 */
export function normalizePairingCode(typed: unknown): string | null {
  if (typeof typed !== 'string') return null;
  const plain = typed.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (plain.length !== PAIRING_CODE_LENGTH || [...plain].some((ch) => !CODE_ALPHABET.includes(ch))) return null;
  return `${plain.slice(0, 4)}-${plain.slice(4)}`;
}

/** Machine ids: 12 characters of lower-case base32 (`a-z2-7`). */
const MACHINE_ID = /^[a-z2-7]{12}$/;

/** `true` for a well-formed machine id. */
export function isMachineId(value: unknown): value is string {
  return typeof value === 'string' && MACHINE_ID.test(value);
}

/** A machine id from random bytes (at least 12). */
export function machineIdFrom(bytes: Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let text = '';
  for (let i = 0; i < 12; i++) text += alphabet[(bytes[i] ?? 0) % 32];
  return text;
}

/** Longest machine name. */
export const MACHINE_NAME_MAX = 40;

/** A machine name as stored: trimmed, control characters dropped, at most {@link MACHINE_NAME_MAX}; `null` when nothing is left. */
export function cleanMachineName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MACHINE_NAME_MAX).trim();
  return text === '' ? null : text;
}

// ── remote ids ───────────────────────────────────────────────────────────

/** Prefix of a remote id: `r~<machineId>~<the peer's own id>`. Local ids are UUIDs and never start with it. */
export const REMOTE_ID_PREFIX = 'r~';

/** The local id of `id` on machine `machineId`. */
export function remoteId(machineId: string, id: string): string {
  return `${REMOTE_ID_PREFIX}${machineId}~${id}`;
}

/** A remote id taken apart; `null` for a local id (or anything malformed). */
export function parseRemoteId(value: unknown): { readonly machineId: string; readonly id: string } | null {
  if (typeof value !== 'string' || !value.startsWith(REMOTE_ID_PREFIX)) return null;
  const rest = value.slice(REMOTE_ID_PREFIX.length);
  const cut = rest.indexOf('~');
  if (cut < 0) return null;
  const machineId = rest.slice(0, cut);
  const id = rest.slice(cut + 1);
  if (!isMachineId(machineId) || id === '') return null;
  return { machineId, id };
}

/** `true` for a remote id. */
export function isRemoteId(value: unknown): boolean {
  return parseRemoteId(value) !== null;
}

// ── addresses ────────────────────────────────────────────────────────────

/** `true` for an IPv4 address in Tailscale's range, 100.64.0.0/10 (CGNAT: 100.64.0.0 – 100.127.255.255). */
export function isTailscaleIPv4(value: string): boolean {
  const parts = parseIPv4(value);
  return parts !== null && parts[0] === 100 && (parts[1] as number) >= 64 && (parts[1] as number) <= 127;
}

/** The four octets of a dotted IPv4 address, `null` for anything else. */
export function parseIPv4(value: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value.trim());
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part <= 255) ? parts : null;
}

/**
 * A typed peer address (`100.x.y.z` or `100.x.y.z:<port>`) as `host:port`;
 * `null` when it is not an IPv4 address with an optional port 1–65535. Only IPv4
 * literals: no names (a name could resolve anywhere), no IPv6.
 */
export function parsePeerAddress(value: unknown, defaultPort: number = DEFAULT_PEER_PORT): { readonly host: string; readonly port: number } | null {
  if (typeof value !== 'string') return null;
  const match = /^\s*([0-9.]+)(?::(\d{1,5}))?\s*$/.exec(value);
  if (!match || parseIPv4(match[1] as string) === null) return null;
  const port = match[2] === undefined ? defaultPort : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1] as string, port };
}

/** `host:port`. */
export function formatPeerAddress(address: { readonly host: string; readonly port: number }): string {
  return `${address.host}:${address.port}`;
}

/** `true` for a valid TCP port. */
export function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}
