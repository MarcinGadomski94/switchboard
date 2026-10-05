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
  /**
   * Fix · peer reconnects (2026-10-01): the stream dropped (or this service just
   * started) and the connection is retrying within its grace period
   * ({@link PEER_GRACE_MS}). Reads keep working from the cache and the snapshot;
   * actions are held until it is back (or the grace ends). Additive value.
   */
  | 'reconnecting'
  /** Not reached within the grace period: retrying on the backoff (actions are refused at once). */
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
  /** Additive (fix · peer reconnects): what the connection is doing now; absent from older services. */
  readonly connection?: MachineConnection;
  /** Additive (D71): the shared sidebar layout with this machine; absent from older services. */
  readonly sidebarSync?: MachineSidebarSync;
}

/**
 * D71 (`docs/peers.md` → *Shared sidebar layout (D71)*): what sharing the
 * sidebar layout with a paired machine is doing.
 *
 * - `off`: this machine's switch for it is off (the default for every pairing).
 * - `connecting`: on; not exchanged since the switch or the last connect yet.
 * - `waiting`: on here, off on the other machine (it shares nothing until it is on there too).
 * - `unsupported`: the other machine runs a Switchboard without D71 (update it to share).
 * - `synced`: on on both; the last exchange went through (changes go both ways live).
 * - `unreachable`: on; the machine cannot be reached now (it catches up when it is back).
 * - `error`: on; the last exchange failed (`error` says why); retried at the next change or connect.
 */
export type SidebarSyncState = 'off' | 'connecting' | 'waiting' | 'unsupported' | 'synced' | 'unreachable' | 'error';

/** D71: the shared sidebar layout with one paired machine. */
export interface MachineSidebarSync {
  /** This machine's switch for it (off until the developer switches it on). */
  readonly enabled: boolean;
  readonly state: SidebarSyncState;
  /** When the two layouts were first merged (ISO), `null` before. */
  readonly mergedAt: string | null;
  /** The last exchange (ISO), `null` before. */
  readonly lastSyncAt: string | null;
  readonly error: string | null;
}

/**
 * Additive (fix · peer reconnects, `docs/peers.md` → *Connection states*): the
 * connection's retry state, so the UI can say what is happening ("attempt 3 ·
 * next try in 8 s") and why the last attempt failed.
 */
export interface MachineConnection {
  /** Failed attempts since the machine was last online (0 while online). */
  readonly attempt: number;
  /** An attempt is running now. */
  readonly trying: boolean;
  /** When the next attempt starts (ISO); `null` while one runs, while online, or with no address. */
  readonly nextAttemptAt: string | null;
  /** While `reconnecting`: when it becomes `offline` unless reached first (ISO). */
  readonly graceUntil: string | null;
  /** The last failure: its kind, plain words and time; `null` before any (and after a success it stays as history). */
  readonly lastFailure: PeerFailure | null;
  /** A hint when the failures point somewhere (every recent one a timeout: is it awake and on Tailscale?). */
  readonly hint: string | null;
}

/** Why one connection attempt (or an open stream) failed. */
export type PeerFailureKind =
  /** Nothing listens at the address (Switchboard not running there, or its peer listener off). */
  | 'refused'
  /** No answer in time (asleep, off the tailnet, a relay that went quiet). */
  | 'timeout'
  /** No route / name to the address (Tailscale down here, or the address changed). */
  | 'route'
  /** The peer refused our token (401). */
  | 'auth'
  /** The peer answered, but not as expected (an HTTP status). */
  | 'http'
  /** The open connection was cut (reset, closed by the other side). */
  | 'reset'
  /** The open stream ended cleanly (the peer closed it, e.g. it restarted). */
  | 'ended'
  /** The open stream went quiet: no event and no keepalive for {@link PEER_STALL_MS}. */
  | 'stalled'
  /** This service closed the stream to reconnect (a new address, a refused token, Reconnect now). */
  | 'restart'
  | 'other';

/** One failure, as the UI shows it. */
export interface PeerFailure {
  readonly kind: PeerFailureKind;
  /** Plain words (`connection refused — is Switchboard running there?`), plus a detail where it helps. */
  readonly message: string;
  /** ISO time. */
  readonly at: string;
}

/** Grace period after a drop: `reconnecting` (non-blocking) for this long before `offline` (ASSUMED reconnect-grace). */
export const PEER_GRACE_MS = 20_000;

/** The open stream counts as stalled after this long without an event or a keepalive (the peer sends one every 10 s). */
export const PEER_STALL_MS = 25_000;

/**
 * The `/hub` event `machineState` (fix · peer reconnects): the machine as `GET
 * /api/machines` lists it; `removed: true` once it was removed (here or by the
 * other machine).
 */
export type MachineStateEvent = Machine & { readonly removed?: true };

/** `POST /api/machines/{id}/reconnect` answer (fix · peer reconnects). */
export interface ReconnectResult {
  /** `online` when the attempt reached it; otherwise the state it is left in. */
  readonly outcome: MachineState;
  readonly machine: Machine;
}

/** Plain words for a failure kind (the start of {@link PeerFailure.message}). */
export function peerFailureText(kind: PeerFailureKind): string {
  switch (kind) {
    case 'refused':
      return 'connection refused — is Switchboard running there with its peer listener on?';
    case 'timeout':
      return 'no answer in time';
    case 'route':
      return 'no route to the machine — is Tailscale up on both machines?';
    case 'auth':
      return 'it refused this pairing (revoked there?): pair again';
    case 'http':
      return 'it answered with an error';
    case 'reset':
      return 'the connection was cut';
    case 'ended':
      return 'the connection was closed by the other side';
    case 'stalled':
      return 'the connection went quiet (no keepalive)';
    case 'restart':
      return 'reconnecting on request';
    case 'other':
      return 'the connection failed';
  }
}

/**
 * The hint shown with a machine that cannot be reached: when the last few
 * failures (at least 3) were all timeouts, the machine is most likely asleep or
 * off the tailnet. `null` when nothing points anywhere.
 */
export function connectionHint(name: string, recent: readonly PeerFailureKind[]): string | null {
  if (recent.length >= 3 && recent.every((kind) => kind === 'timeout')) return `Check that ${name} is awake and on Tailscale.`;
  return null;
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

/**
 * D48 ruling D48-cache-persist: why a peer's session cannot be acted on now,
 * `null` for this machine's own sessions, a connected machine's and (fix · peer
 * reconnects) one that is `reconnecting` (non-blocking: actions are held until it
 * is back). Its last known state stays readable. The UI adds the retry countdown
 * and **Reconnect now** next to it.
 */
export function offlineReason(machine: SessionMachine | null | undefined): string | null {
  if (!machine || machine.state === 'online' || machine.state === 'reconnecting') return null;
  if (machine.state === 'auth-failed') return `${machine.name} refused this pairing — pair again in Settings → Machines`;
  if (machine.state === 'no-address') return `${machine.name} has not told its address (its peer listener is off)`;
  return `${machine.name} is unreachable`;
}

/** Fix · peer reconnects: the non-blocking note while a machine is `reconnecting`; `null` otherwise. */
export function reconnectingNote(machine: SessionMachine | null | undefined): string | null {
  return machine?.state === 'reconnecting' ? `Reconnecting to ${machine.name}…` : null;
}

/** What a machine tag says after the name (`studio-pc · unreachable`); `null` while online. */
export function machineTagSuffix(state: MachineState): string | null {
  switch (state) {
    case 'online':
      return null;
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
