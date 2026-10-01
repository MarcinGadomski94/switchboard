import type { ServerResponse } from 'node:http';
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { HubEventName, HubEvents, InboxItem, Schedule, Session, TerminalLoop } from '../../core/api.ts';
import { PEER_HUB_EVENTS, type PeerMachineRef, mapPeerAnswer, peerAnswerKind, peerHubEvent, peerInboxItem, peerSchedule, peerSession, peerTerminalLoop } from '../../core/peer-wire.ts';
import {
  type AddMachineInput,
  DEFAULT_PEER_PORT,
  type Machine,
  type MachineState,
  type MachinesView,
  type PairingCode,
  type PeerListenerInput,
  type PeerListenerState,
  type ReconnectResult,
  cleanMachineName,
  connectionHint,
  formatPeerAddress,
  isMachineId,
  isPort,
  isRemoteId,
  normalizePairingCode,
  parseIPv4,
  parsePeerAddress,
} from '../../core/peers.ts';
import type { ServerConfig } from '../config.ts';
import type { MachineRecord } from '../db/repos/machines.ts';
import type { Store } from '../db/store.ts';
import type { HubBus, HubMessage } from '../hub/bus.ts';
import { KEEPALIVE_FRAME, SSE_CONTENT_TYPE, formatEvent } from '../hub/hub.ts';
import { inboxCount } from '../inbox/wire.ts';
import { TOKEN_COOKIE } from '../security.ts';
import { PEER_RAW_HEADERS, PeerConnection, type PeerConnectionStatus, PeerUnreachableError } from './client.ts';
import { type PeerApiAnswer, type PeerHandlers, buildPeerApp, listenPeer } from './listener.ts';
import { PairingCodes } from './pairing.ts';
import { tailscaleIPv4 } from './tailscale.ts';
import { hashPeerToken, hashesMatch, newMachineId, newPeerToken } from './tokens.ts';

/**
 * D48 "Switchboard peers" (`docs/peers.md`): this machine's identity, its optional
 * peer listener, the pairing of machines, one outbound {@link PeerConnection} per
 * paired machine, and the proxy between the local UI and the peers' APIs.
 *
 * - **Serving:** the peer listener (`listener.ts`) answers the peer API; its
 *   `/peer/v1/api/*` goes through an allow-list into this app's own routes
 *   (`app.inject`, as the local UI would call them), marked with
 *   {@link PEER_REQUEST_HEADER} so they answer local data only and never forward
 *   on to another peer. Its event stream forwards the bus's session and Inbox
 *   events about local sessions.
 * - **Connecting:** each connection keeps the peer's open sessions and Inbox items
 *   cached; `GET /api/sessions` and `GET /api/inbox` add them (namespaced, tagged);
 *   the peer's events are published on the local bus, namespaced.
 * - **Forwarding:** a local request that names a remote id goes to that peer
 *   ({@link forward}) and its answer is namespaced back.
 */

/** Header of a request the peer API injects into the local app (D48): answer local data only, never forward. */
export const PEER_REQUEST_HEADER = 'x-switchboard-peer';

/** Settings key of this install's identity. */
export const SELF_SETTING = 'peers.self';

/** Settings key of the peer listener switch. */
export const LISTENER_SETTING = 'peers.listener';

/** Time limit of the calls that fetch or create on the peer (a start with worktrees, the branching preflight). */
export const PEER_LONG_TIMEOUT_MS = 180_000;

/** Time limit of the other forwarded calls. */
export const PEER_FORWARD_TIMEOUT_MS = 30_000;

/**
 * Fix · peer reconnects: how long an action on a `reconnecting` machine is held
 * for the reconnection before it is refused (ASSUMED reconnect-hold).
 */
export const PEER_HOLD_MS = 10_000;

/** D52: a peer's schedules / terminal loops are fetched again when a list read finds them older than this. */
export const PEER_LIST_STALE_MS = 10_000;

/** D52: the lists of a peer that are kept as last known (and snapshotted), with the peer API route each comes from. */
const PEER_LISTS = { schedules: '/api/schedules', 'terminal-loops': '/api/terminal-loops' } as const;

/** D52: one of {@link PEER_LISTS}. */
export type PeerListKind = keyof typeof PEER_LISTS;

/**
 * The peer API's allow-list (`docs/peers.md` → *What a peer may call*): method +
 * path (no query). Everything else is 403 `peer-forbidden`: no settings, no folder
 * management, no tools, no terminal handoff (attach / detach), no teleport, no
 * history. D52 added the schedules and the terminal sessions' loops.
 */
export const PEER_API_ALLOW: ReadonlyArray<readonly [method: string, path: RegExp]> = [
  ['GET', /^\/api\/sessions$/],
  ['POST', /^\/api\/sessions$/],
  ['GET', /^\/api\/sessions\/[^/]+$/],
  ['GET', /^\/api\/sessions\/[^/]+\/(?:events|diff)$/],
  // D51: a Workflow agent's conversation (its transcript on that machine).
  ['GET', /^\/api\/sessions\/[^/]+\/workflow-agents\/[^/]+\/chat$/],
  // Fix · long messages: a cut event's whole text (from the transcript on that machine).
  ['GET', /^\/api\/sessions\/[^/]+\/events\/[^/]+\/full$/],
  // D50: Stop (interrupt) and the background-task stop work on a peer's session too.
  ['POST', /^\/api\/sessions\/[^/]+\/(?:messages|pause|resume|close|reopen|interrupt)$/],
  ['POST', /^\/api\/sessions\/[^/]+\/background\/stop$/],
  ['PUT', /^\/api\/sessions\/[^/]+\/(?:title|remote|model)$/],
  ['GET', /^\/api\/inbox$/],
  ['POST', /^\/api\/questions\/batch\/[^/]+\/answers$/],
  ['POST', /^\/api\/inbox\/[^/]+\/actions\/[^/]+$/],
  ['GET', /^\/api\/folders$/],
  ['GET', /^\/api\/models$/],
  // D62: that machine's CLIs (the New-session form's CLI row for a start there) and a switch of its session's CLI.
  ['GET', /^\/api\/clis$/],
  ['POST', /^\/api\/sessions\/[^/]+\/provider$/],
  ['GET', /^\/api\/solutions$/],
  ['POST', /^\/api\/branching\/preflight$/],
  ['GET', /^\/api\/terminal-sessions$/],
  ['POST', /^\/api\/terminal-sessions\/[^/]+\/hook$/],
  ['GET', /^\/api\/hooks$/],
  ['POST', /^\/api\/hooks\/(?:install|remove)$/],
  // D52: the schedules (list, Save schedule = create / Edit, Run now, Pause / Resume, Delete) and the terminal sessions' loops.
  ['GET', /^\/api\/schedules$/],
  ['POST', /^\/api\/schedules$/],
  ['POST', /^\/api\/schedules\/[^/]+\/(?:run|pause|resume)$/],
  ['DELETE', /^\/api\/schedules\/[^/]+$/],
  ['GET', /^\/api\/terminal-loops$/],
  // D57: attachments: upload to a session (or staged for a start there), and serve them (the file lives on that machine).
  ['POST', /^\/api\/sessions\/[^/]+\/attachments$/],
  ['GET', /^\/api\/sessions\/[^/]+\/attachments\/[^/]+$/],
  ['POST', /^\/api\/attachments$/],
  // D61: the MCP servers page: that machine's servers (list, check, reconnect, sign in, enable / disable, add / edit / remove).
  ['GET', /^\/api\/mcp$/],
  ['POST', /^\/api\/mcp\/check$/],
  ['POST', /^\/api\/mcp\/servers$/],
  ['GET', /^\/api\/mcp\/servers\/[^/]+$/],
  ['PUT', /^\/api\/mcp\/servers\/[^/]+$/],
  ['DELETE', /^\/api\/mcp\/servers\/[^/]+$/],
  ['POST', /^\/api\/mcp\/servers\/[^/]+\/(?:reconnect|toggle|auth)$/],
  ['GET', /^\/api\/mcp\/auth\/[^/]+$/],
  ['POST', /^\/api\/mcp\/auth\/[^/]+\/callback$/],
  ['DELETE', /^\/api\/mcp\/auth\/[^/]+$/],
  // D62 P7: that machine's Codex CLI / OpenCode MCP servers.
  ['GET', /^\/api\/mcp\/cli\/[^/]+$/],
  ['POST', /^\/api\/mcp\/cli\/[^/]+\/servers$/],
  ['DELETE', /^\/api\/mcp\/cli\/[^/]+\/servers\/[^/]+$/],
];

/** D57: the peer API's attachment download (its answer is bytes, not JSON). */
export const PEER_ATTACHMENT_GET = /^\/api\/sessions\/[^/]+\/attachments\/[^/]+$/;

/** `true` when the peer API may serve `method path` (`url` may carry a query). */
export function peerApiAllowed(method: string, url: string): boolean {
  const pathname = url.split('?')[0] as string;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  // Never a remote id: a peer reaches this machine's own sessions only (no chains of peers).
  if (decoded.split('/').some((segment) => isRemoteId(segment))) return false;
  return PEER_API_ALLOW.some(([allowed, pattern]) => allowed === method.toUpperCase() && pattern.test(pathname));
}

/** The stored listener switch. */
interface ListenerSetting {
  readonly enabled: boolean;
  readonly address: string | null;
  readonly port: number;
}

/** Options of {@link PeerService}. */
export interface PeerServiceOptions {
  readonly config: ServerConfig;
  readonly store: Store;
  readonly bus: HubBus;
  /** The install token: injected peer requests carry it as the UI's cookie would. */
  readonly token: string;
  readonly onError?: (error: unknown) => void;
  /** The service's version, told to peers. */
  readonly version?: string;
  /**
   * Fix · peer reconnects: the connections' timings (`ServerConfig.peerTimings`;
   * tests shorten them). Absent fields keep the defaults.
   */
  readonly timings?: PeerTimings;
  /** Connection state changes and failed attempts (default: `console.info` / `console.warn`). Never a token. */
  readonly log?: (level: 'info' | 'warn', message: string) => void;
}

/** Fix · peer reconnects: tunable timings of the peer connections. */
export interface PeerTimings {
  /** `reconnecting` → `offline` after this long (default `PEER_GRACE_MS`). */
  readonly graceMs?: number;
  /** A quiet stream counts as stalled after this long (default `PEER_STALL_MS`). */
  readonly stallMs?: number;
  /** An action on a `reconnecting` machine waits at most this long (default {@link PEER_HOLD_MS}). */
  readonly holdMs?: number;
}

/** A refusal of a machines action, sent as `{ error, message }` with `status`. */
export class PeerError extends Error {
  override name = 'PeerError';
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** One peer's open event stream to us. */
interface InboundStream {
  readonly machineId: string;
  readonly res: ServerResponse;
  readonly close: () => void;
}

/** The D48 service. */
export class PeerService implements PeerHandlers {
  readonly #config: ServerConfig;
  readonly #store: Store;
  readonly #bus: HubBus;
  readonly #token: string;
  readonly #onError: (error: unknown) => void;
  readonly #version: string;
  readonly #timings: PeerTimings;
  readonly #log: (level: 'info' | 'warn', message: string) => void;
  /** Per machine: the state last logged and the failed attempt last logged (so the log tells each change once). */
  readonly #logged = new Map<string, { state: MachineState | null; attempt: number; failures: number }>();
  /** Tests only (`SWITCHBOARD_PEER_TEST_HOOKS`): the end of a simulated outage of the listener. */
  #outage: NodeJS.Timeout | undefined;
  readonly #pairing = new PairingCodes();
  readonly #connections = new Map<string, PeerConnection>();
  /** The machines' records, by id (kept in step with the store by every change here). */
  readonly #records = new Map<string, MachineRecord>();
  readonly #inbound = new Set<InboundStream>();
  #app: FastifyInstance | null = null;
  #listener: FastifyInstance | null = null;
  #listening: string | null = null;
  #listenerError: string | null = null;
  #listenerChange: Promise<void> = Promise.resolve();
  #started = false;
  #closed = false;
  #self: { id: string; name: string } | null = null;
  /** The session list last stored per machine (so an unchanged list is not written again). */
  readonly #savedLists = new Map<string, string>();
  /** `true` while a peer's event is being published on the local bus (listeners run synchronously): never sent on to a peer. */
  #republishing = false;
  /** D52: each machine's schedules and terminal loops as last known (raw, as the peer answered), by machine then kind. */
  readonly #lists = new Map<string, Map<PeerListKind, unknown[]>>();
  /** D52: when each `<machine> <kind>` list was last fetched (ms), and the fetch in flight. */
  readonly #listFetched = new Map<string, number>();
  readonly #listRefresh = new Map<string, Promise<boolean>>();

  constructor(options: PeerServiceOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#bus = options.bus;
    this.#token = options.token;
    this.#onError = options.onError ?? ((error) => console.error('switchboard peers:', error));
    this.#version = options.version ?? '0.1.0';
    this.#timings = options.timings ?? options.config.peerTimings ?? {};
    this.#log =
      options.log ??
      ((level, message) => {
        if (level === 'warn') console.warn(`switchboard peers: ${message}`);
        else console.info(`switchboard peers: ${message}`);
      });
  }

  /** The local app the peer API injects into (set once it is built). */
  useApp(app: FastifyInstance): void {
    this.#app = app;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  /** Starts the peer listener (when switched on) and connects to every paired machine. Called once the UI port is ours. */
  async start(): Promise<void> {
    if (this.#started || this.#closed) return;
    this.#started = true;
    await this.self();
    for (const record of await this.#store.machines.list()) {
      this.#records.set(record.id, record);
      this.#connect(record.id);
      // D48 ruling D48-cache-persist: the last known sessions stay listed (unreachable) until the machine is reached.
      const snapshot = await this.#store.peerSnapshots.get(record.id, 'sessions', '');
      if (Array.isArray(snapshot)) {
        this.#connections.get(record.id)?.seed(snapshot as Session[]);
        this.#savedLists.set(record.id, JSON.stringify(snapshot));
      }
      // D52: its schedules and terminal loops stay listed from the snapshot too.
      for (const kind of Object.keys(PEER_LISTS) as PeerListKind[]) {
        const list = await this.#store.peerSnapshots.get(record.id, kind, '');
        if (Array.isArray(list)) this.#setList(record.id, kind, list);
      }
    }
    await this.#applyListener();
  }

  /** Stops the listener, the streams and the connections. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#outage);
    await this.#listenerChange.catch(() => undefined);
    for (const stream of [...this.#inbound]) stream.close();
    await Promise.all([...this.#connections.values()].map((connection) => connection.close()));
    this.#connections.clear();
    await this.#stopListener();
  }

  // ── identity ──────────────────────────────────────────────────────────

  /** This install's id and name (made on first use: a random id, the host name). */
  async self(): Promise<{ readonly id: string; readonly name: string }> {
    if (this.#self) return this.#self;
    const stored = (await this.#store.settings.get(SELF_SETTING)) as { id?: unknown; name?: unknown } | undefined;
    const id = isMachineId(stored?.id) ? stored.id : newMachineId();
    const name = cleanMachineName(stored?.name) ?? defaultMachineName();
    if (stored?.id !== id || stored?.name !== name) await this.#store.settings.set(SELF_SETTING, { id, name });
    this.#self = { id, name };
    return this.#self;
  }

  /** Renames this machine (what peers see at their next pairing; ASSUMED D48-names). */
  async renameSelf(name: unknown): Promise<{ readonly id: string; readonly name: string }> {
    const clean = cleanMachineName(name);
    if (!clean) throw new PeerError(422, 'invalid', 'the name must be 1–40 characters');
    const self = await this.self();
    this.#self = { id: self.id, name: clean };
    await this.#store.settings.set(SELF_SETTING, this.#self);
    return this.#self;
  }

  // ── the listener ──────────────────────────────────────────────────────

  async #listenerSetting(): Promise<ListenerSetting> {
    const stored = (await this.#store.settings.get(LISTENER_SETTING)) as Partial<ListenerSetting> | undefined;
    return {
      enabled: stored?.enabled === true,
      address: typeof stored?.address === 'string' && parseIPv4(stored.address) ? stored.address : null,
      port: isPort(stored?.port) ? stored.port : DEFAULT_PEER_PORT,
    };
  }

  /** The listener's switch and what it does now. */
  async listenerState(): Promise<PeerListenerState> {
    const setting = await this.#listenerSetting();
    return {
      enabled: setting.enabled,
      configuredAddress: setting.address,
      port: setting.port,
      listening: this.#listening,
      error: setting.enabled ? this.#listenerError : null,
    };
  }

  /** Saves the switch (`PUT /api/machines/listener`) and applies it when the service runs. */
  async setListener(input: unknown): Promise<PeerListenerState> {
    const body = (typeof input === 'object' && input !== null && !Array.isArray(input) ? input : null) as PeerListenerInput | null;
    if (!body) throw new PeerError(422, 'invalid', 'the body must be { enabled?, address?, port? }');
    const current = await this.#listenerSetting();
    const next: { enabled: boolean; address: string | null; port: number } = { ...current };
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw new PeerError(422, 'invalid', 'enabled must be true or false');
      next.enabled = body.enabled;
    }
    if (body.address !== undefined) {
      const text = typeof body.address === 'string' ? body.address.trim() : body.address;
      if (text === null || text === '') next.address = null;
      else if (typeof text === 'string' && parseIPv4(text)) next.address = text;
      else throw new PeerError(422, 'invalid', 'the address must be an IPv4 address (the Tailscale 100.x address), or empty for `tailscale ip -4`');
    }
    if (body.port !== undefined) {
      if (!isPort(body.port) || body.port === this.#config.port) throw new PeerError(422, 'invalid', `the port must be 1–65535 and not the UI's port ${this.#config.port}`);
      next.port = body.port;
    }
    await this.#store.settings.set(LISTENER_SETTING, next);
    if (this.#started && !this.#closed) await this.#applyListener();
    return this.listenerState();
  }

  /** (Re)starts or stops the listener to match the switch; serialized. */
  #applyListener(): Promise<void> {
    const run = this.#listenerChange.catch(() => undefined).then(async () => {
      const setting = await this.#listenerSetting();
      await this.#stopListener();
      this.#listenerError = null;
      if (!setting.enabled || this.#closed) return;
      const host = setting.address ?? (await tailscaleIPv4(this.#config.tailscaleCommand, { cwd: this.#config.dataDir }));
      if (!host) {
        this.#listenerError = 'No Tailscale address: is Tailscale running and signed in? (`tailscale ip -4` found none; or set the address)';
        return;
      }
      const app = buildPeerApp({ host, port: setting.port, handlers: this });
      try {
        await listenPeer(app, host, setting.port, this.#config.peerTestLoopback);
        this.#listener = app;
        this.#listening = formatPeerAddress({ host, port: setting.port });
      } catch (error) {
        await app.close().catch(() => undefined);
        this.#listenerError = error instanceof Error ? error.message : String(error);
      }
      // Paired machines learn the new address with the next hello.
      for (const connection of this.#connections.values()) connection.kick();
    });
    this.#listenerChange = run;
    return run;
  }

  async #stopListener(): Promise<void> {
    for (const stream of [...this.#inbound]) stream.close();
    const app = this.#listener;
    this.#listener = null;
    this.#listening = null;
    if (app) await app.close();
  }

  // ── machines ──────────────────────────────────────────────────────────

  /** `GET /api/machines`. */
  async view(): Promise<MachinesView> {
    const self = await this.self();
    return { self, listener: await this.listenerState(), machines: await this.machines() };
  }

  /** The paired machines with their connection state. */
  async machines(): Promise<Machine[]> {
    return (await this.#store.machines.list()).map((record) => this.#machine(record));
  }

  #machine(record: MachineRecord): Machine {
    const connection = this.#connections.get(record.id);
    const status = connection?.status;
    const iso = (ms: number | null | undefined): string | null => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
    return {
      id: record.id,
      name: record.name,
      address: record.address,
      state: connection?.state ?? (record.address ? 'offline' : 'no-address'),
      lastError: connection?.lastError ?? null,
      lastSeenAt: record.lastSeenAt,
      pairedAt: record.pairedAt,
      connection: {
        attempt: status?.attempt ?? 0,
        trying: status?.trying ?? false,
        nextAttemptAt: status && !status.trying && status.state !== 'online' ? iso(status.nextAttemptAt) : null,
        graceUntil: iso(status?.graceUntil),
        lastFailure: status?.lastFailure ? { kind: status.lastFailure.kind, message: status.lastFailure.message, at: new Date(status.lastFailure.at).toISOString() } : null,
        hint: status && status.state !== 'online' ? connectionHint(record.name, status.recentFailures) : null,
      },
    };
  }

  /**
   * Fix · peer reconnects: **Reconnect now** (`POST /api/machines/{id}/reconnect`).
   * Cuts the wait and tries at once (joining an attempt that already runs: never
   * two at once); answers when that attempt is over.
   */
  async reconnect(id: string): Promise<ReconnectResult> {
    const record = this.#records.get(id);
    const connection = this.#connections.get(id);
    if (!record || !connection) throw new PeerError(404, 'not-found', `no machine ${id}`);
    if (connection.state !== 'online') this.#log('info', `${this.#label(record)}: Reconnect now`);
    const outcome = await connection.reconnectNow();
    const current = this.#records.get(id) ?? record;
    return { outcome, machine: this.#machine(current) };
  }

  /** `name (id)` for the log. */
  #label(record: MachineRecord): string {
    return `${record.name} (${record.id})`;
  }

  /** Publishes a machine's status on `/hub` (`machineState`: Settings → Machines and every note follow it live). */
  #publishMachine(id: string): void {
    const record = this.#records.get(id);
    if (!record || this.#closed) return;
    this.#bus.publish('machineState', this.#machine(record));
  }

  /** Logs a state change (with the reason and attempt count) and each failed attempt, once. */
  #logStatus(id: string, status: PeerConnectionStatus): void {
    const record = this.#records.get(id);
    if (!record) return;
    const seen = this.#logged.get(id) ?? { state: null, attempt: 0, failures: 0 };
    const label = this.#label(record);
    const reason = status.lastFailure?.message ?? status.lastError ?? 'unknown';
    if (seen.state !== status.state) {
      const from = seen.state ?? 'start';
      if (status.state === 'online') this.#log('info', `${label}: ${from} → online${seen.failures > 0 ? ` after ${seen.failures} failed attempt${seen.failures === 1 ? '' : 's'}` : ''}`);
      else if (status.state === 'reconnecting') this.#log(seen.state === 'online' ? 'warn' : 'info', seen.state === null ? `${label}: connecting` : `${label}: ${from} → reconnecting (${reason})`);
      else this.#log('warn', `${label}: ${from} → ${status.state} (${reason}; ${status.attempt} failed attempt${status.attempt === 1 ? '' : 's'})`);
      seen.state = status.state;
    }
    if (status.state === 'online') {
      seen.attempt = 0;
      seen.failures = 0;
    } else if (!status.trying && status.attempt > seen.attempt) {
      seen.attempt = status.attempt;
      seen.failures = status.attempt;
      // Every failed attempt while reconnecting, then the first five and every 20th (a long outage stays readable).
      if (status.state === 'reconnecting' || status.attempt <= 5 || status.attempt % 20 === 0) {
        const next = status.nextAttemptAt === null ? '' : `; next try in ${Math.max(0, Math.round((status.nextAttemptAt - Date.now()) / 1000))} s`;
        this.#log('info', `${label}: attempt ${status.attempt} failed (${reason})${next}`);
      }
    }
    this.#logged.set(id, seen);
  }

  /**
   * Tests only (`SWITCHBOARD_PEER_TEST_HOOKS=1`): closes every peer's open event
   * stream to this machine, as a dropped connection would (they reconnect at once).
   */
  testDropStreams(): number {
    const streams = [...this.#inbound];
    for (const stream of streams) stream.res.destroy();
    return streams.length;
  }

  /**
   * Tests only (`SWITCHBOARD_PEER_TEST_HOOKS=1`): an outage of this machine's
   * peer listener: it stops now (peers get "connection refused") and starts again
   * after `ms`, or at {@link testEndOutage}.
   */
  async testOutage(ms: number): Promise<void> {
    clearTimeout(this.#outage);
    await this.#listenerChange.catch(() => undefined);
    await this.#stopListener();
    this.#outage = setTimeout(() => void this.testEndOutage(), ms);
  }

  /** Tests only: ends a {@link testOutage} now (the listener starts again). */
  async testEndOutage(): Promise<void> {
    clearTimeout(this.#outage);
    this.#outage = undefined;
    if (!this.#closed) await this.#applyListener();
  }

  #ref(machineId: string): PeerMachineRef | null {
    const record = this.#records.get(machineId);
    if (!record) return null;
    const connection = this.#connections.get(machineId);
    return { id: record.id, name: record.name, state: connection?.state ?? 'offline' };
  }

  /** "Allow a new peer": a new one-time code (the listener must be on for the other machine to use it). */
  createPairingCode(): PairingCode {
    const { code, expiresAt } = this.#pairing.create();
    return { code, expiresAt: expiresAt.toISOString() };
  }

  /** "Add machine": pairs with the machine at `address` using its code (`POST /api/machines`). */
  async addMachine(input: unknown): Promise<Machine> {
    const body = (typeof input === 'object' && input !== null ? input : {}) as Partial<AddMachineInput>;
    const address = parsePeerAddress(body.address);
    if (!address) throw new PeerError(422, 'invalid', 'the address must be the other machine\'s Tailscale IPv4, optionally with :port (default 13002)');
    const code = normalizePairingCode(body.code);
    if (!code) throw new PeerError(422, 'invalid', 'the code must be the 8-character code shown on the other machine (XXXX-XXXX)');
    const self = await this.self();
    const inbound = newPeerToken();
    const target = formatPeerAddress(address);
    let response: Response;
    try {
      response = await fetch(`http://${target}/peer/v1/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ code, id: self.id, name: self.name, address: this.#listening, token: inbound }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new PeerError(502, 'peer-unreachable', `${target} could not be reached (is its peer listener on?): ${error instanceof Error ? error.message : String(error)}`);
    }
    const answer = (await response.json().catch(() => null)) as { id?: unknown; name?: unknown; token?: unknown; error?: unknown; reason?: unknown } | null;
    if (response.status === 403 && answer?.error === 'pairing-refused') {
      throw new PeerError(409, 'pairing-refused', pairingRefusalText(String(answer.reason ?? '')));
    }
    if (response.status !== 200 || !answer || !isMachineId(answer.id) || typeof answer.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(answer.token)) {
      throw new PeerError(502, 'pairing-failed', `${target} answered the pairing with HTTP ${response.status}`);
    }
    if (answer.id === self.id) throw new PeerError(409, 'pairing-refused', 'that address is this machine itself');
    const record = await this.#store.machines.upsert({
      id: answer.id,
      name: cleanMachineName(answer.name) ?? answer.id,
      address: target,
      outboundToken: answer.token,
      inboundTokenHash: hashPeerToken(inbound),
    });
    this.#records.set(record.id, record);
    this.#connect(record.id, true);
    return this.#machine(record);
  }

  /** Renames a machine here (its tag). */
  async renameMachine(id: string, name: unknown): Promise<Machine> {
    const clean = cleanMachineName(name);
    if (!clean) throw new PeerError(422, 'invalid', 'the name must be 1–40 characters');
    const record = await this.#store.machines.update(id, { name: clean });
    if (!record) throw new PeerError(404, 'not-found', `no machine ${id}`);
    this.#records.set(id, record);
    this.#publishMachineSessions(id);
    this.#publishMachine(id);
    return this.#machine(record);
  }

  /** Removes (revokes) a machine: its tokens stop working here, and the machine is told to forget us too (best effort). */
  async removeMachine(id: string): Promise<void> {
    const record = await this.#store.machines.get(id);
    if (!record) throw new PeerError(404, 'not-found', `no machine ${id}`);
    const connection = this.#connections.get(id);
    if (connection && record.address) await connection.request('DELETE', '/peer/v1/pair', undefined, { timeoutMs: 5_000 }).catch(() => undefined);
    await this.#forget(id);
  }

  async #forget(id: string): Promise<void> {
    const sessions = this.#connections.get(id)?.sessions ?? [];
    const ref = this.#ref(id);
    const record = this.#records.get(id);
    const gone = record ? this.#machine(record) : null;
    await this.#connections.get(id)?.close();
    this.#connections.delete(id);
    this.#logged.delete(id);
    await this.#store.peerSnapshots.deleteMachine(id);
    await this.#store.machines.delete(id);
    this.#records.delete(id);
    this.#savedLists.delete(id);
    this.#lists.delete(id);
    for (const stream of [...this.#inbound]) if (stream.machineId === id) stream.close();
    if (ref) for (const session of sessions) this.#publishFromPeer('sessionUpdated', peerSession({ ...ref, state: 'offline' }, session));
    // Fix · peer reconnects: Settings → Machines (and every note) drop it at once.
    if (gone && !this.#closed) this.#bus.publish('machineState', { ...gone, removed: true });
    await this.#publishInboxCount();
  }

  #connect(id: string, kick = false): void {
    const existing = this.#connections.get(id);
    if (existing) {
      if (kick) existing.kick();
      return;
    }
    if (this.#closed) return;
    const connection = new PeerConnection({
      target: async () => {
        const record = this.#records.get(id) ?? (await this.#store.machines.get(id));
        return record ? { id: record.id, address: record.address, token: record.outboundToken } : null;
      },
      ownAddress: () => this.#listening,
      onEvent: (name, payload) => this.#onPeerEvent(id, name, payload),
      onState: (state) => this.#onPeerState(id, state),
      onStatus: (status) => {
        this.#logStatus(id, status);
        this.#publishMachine(id);
      },
      onCache: () => {
        void this.#saveSessions(id);
      },
      onSeen: () => {
        void this.#touch(id);
      },
      onError: (error) => this.#onError(error),
      ...(this.#timings.graceMs !== undefined ? { graceMs: this.#timings.graceMs } : {}),
      ...(this.#timings.stallMs !== undefined ? { stallMs: this.#timings.stallMs } : {}),
    });
    this.#connections.set(id, connection);
    if (this.#started) connection.start();
  }

  /** D48 ruling D48-cache-persist: stores the machine's open sessions as last known (and drops the snapshots of the others). */
  async #saveSessions(id: string): Promise<void> {
    const connection = this.#connections.get(id);
    if (!connection || !this.#records.has(id) || this.#closed) return;
    const sessions = connection.sessions;
    const text = JSON.stringify(sessions);
    if (this.#savedLists.get(id) === text) return;
    this.#savedLists.set(id, text);
    try {
      await this.#store.peerSnapshots.put(id, 'sessions', '', sessions);
      await this.#store.peerSnapshots.prune(id, sessions.map((session) => session.id));
    } catch (error) {
      this.#onError(error);
    }
  }

  async #touch(id: string): Promise<void> {
    const record = await this.#store.machines.update(id, { lastSeenAt: new Date().toISOString() });
    if (record) this.#records.set(id, record);
  }

  #onPeerState(id: string, state: MachineState): void {
    const connection = this.#connections.get(id);
    if (connection) this.#logStatus(id, connection.status);
    this.#publishMachine(id);
    this.#publishMachineSessions(id);
    void this.#publishInboxCount();
    // D52: (re)connected: its schedules and terminal loops are fetched again.
    if (state === 'online') for (const kind of Object.keys(PEER_LISTS) as PeerListKind[]) void this.refreshList(id, kind);
  }

  /** Every cached session of the machine again (its tag's state changed, or its name). */
  #publishMachineSessions(id: string): void {
    const ref = this.#ref(id);
    const connection = this.#connections.get(id);
    if (!ref || !connection) return;
    for (const session of connection.sessions) this.#publishFromPeer('sessionUpdated', peerSession(ref, session));
  }

  #onPeerEvent<K extends HubEventName>(id: string, name: K, payload: HubEvents[K]): void {
    const ref = this.#ref(id);
    if (!ref) return;
    if (name === 'inboxChanged') {
      void this.#publishInboxCount();
      return;
    }
    if (name === 'scheduleRun' || name === 'schedulesChanged') {
      // D52: the peer's schedules are fetched again first, so a page that reloads on the event sees the run.
      void this.refreshList(id, 'schedules').then(() => {
        const current = this.#ref(id);
        const mapped = current ? peerHubEvent(current, name, payload) : null;
        if (mapped !== null) this.#publishFromPeer(name, mapped);
      });
      return;
    }
    const mapped = peerHubEvent(ref, name, payload);
    if (mapped !== null) this.#publishFromPeer(name, mapped);
  }

  /** Publishes a peer's (mapped) event locally, marked so the peer streams of this machine skip it. */
  #publishFromPeer<K extends HubEventName>(name: K, payload: HubEvents[K]): void {
    this.#republishing = true;
    try {
      this.#bus.publish(name, payload);
    } finally {
      this.#republishing = false;
    }
  }

  async #publishInboxCount(): Promise<void> {
    try {
      this.#publishFromPeer('inboxChanged', { count: (await inboxCount(this.#store)) + this.remoteInbox().length });
    } catch (error) {
      this.#onError(error);
    }
  }

  // ── merged lists ──────────────────────────────────────────────────────

  /** The paired machines' open sessions as last known, namespaced and tagged (an unreachable machine's too). */
  remoteSessions(): Session[] {
    const out: Session[] = [];
    for (const [id, connection] of this.#connections) {
      const ref = this.#ref(id);
      if (ref) for (const session of connection.sessions) out.push(peerSession(ref, session));
    }
    return out;
  }

  /** The reachable machines' Inbox items, namespaced and tagged. */
  remoteInbox(): InboxItem[] {
    const out: InboxItem[] = [];
    for (const [id, connection] of this.#connections) {
      const ref = this.#ref(id);
      if (ref) for (const item of connection.inbox) out.push(peerInboxItem(ref, item));
    }
    return out;
  }

  /**
   * D52: the paired machines' schedules as last known, namespaced and tagged (an
   * unreachable machine's from its snapshot, tagged with its state). A list older
   * than {@link PEER_LIST_STALE_MS} is fetched again in the background: nothing here
   * waits on the network.
   */
  remoteSchedules(): Schedule[] {
    return this.#remoteList('schedules', (ref, item) => peerSchedule(ref, item as Schedule));
  }

  /** D52: the paired machines' terminal loops (`GET /api/terminal-loops` there) as last known; see {@link remoteSchedules}. */
  remoteTerminalLoops(): TerminalLoop[] {
    return this.#remoteList('terminal-loops', (ref, item) => peerTerminalLoop(ref, item as TerminalLoop));
  }

  #remoteList<T>(kind: PeerListKind, map: (ref: PeerMachineRef, item: unknown) => T): T[] {
    const out: T[] = [];
    for (const id of this.#records.keys()) {
      const ref = this.#ref(id);
      if (!ref) continue;
      if (ref.state === 'online' && Date.now() - (this.#listFetched.get(`${id} ${kind}`) ?? 0) > PEER_LIST_STALE_MS) void this.refreshList(id, kind);
      for (const item of this.#lists.get(id)?.get(kind) ?? []) {
        if (typeof item === 'object' && item !== null) out.push(map(ref, item));
      }
    }
    return out;
  }

  #setList(id: string, kind: PeerListKind, list: unknown[]): void {
    let lists = this.#lists.get(id);
    if (!lists) {
      lists = new Map();
      this.#lists.set(id, lists);
    }
    lists.set(kind, list);
  }

  /**
   * D52: fetches machine `id`'s list `kind` now (coalesced per machine and kind) and
   * keeps it as last known (the cache and its snapshot). Resolves `true` when the
   * list changed; `false` when it did not, the machine is not connected, or it did
   * not answer the list (an older Switchboard without D52 answers 403: its list
   * stays empty).
   */
  refreshList(id: string, kind: PeerListKind): Promise<boolean> {
    const key = `${id} ${kind}`;
    const running = this.#listRefresh.get(key);
    if (running) return running;
    const run = (async (): Promise<boolean> => {
      const connection = this.#connections.get(id);
      if (!connection || connection.state !== 'online' || this.#closed) return false;
      this.#listFetched.set(key, Date.now());
      let answer: { status: number; body: unknown };
      try {
        answer = await connection.request('GET', `/peer/v1${PEER_LISTS[kind]}`, undefined, { timeoutMs: PEER_FORWARD_TIMEOUT_MS });
      } catch (error) {
        if (!(error instanceof PeerUnreachableError)) this.#onError(error);
        return false;
      }
      if (answer.status !== 200 || !Array.isArray(answer.body) || !this.#records.has(id) || this.#closed) return false;
      const before = JSON.stringify(this.#lists.get(id)?.get(kind) ?? []);
      this.#setList(id, kind, answer.body);
      if (before === JSON.stringify(answer.body)) return false;
      await this.#store.peerSnapshots.put(id, kind, '', answer.body).catch((error: unknown) => this.#onError(error));
      return true;
    })().finally(() => this.#listRefresh.delete(key));
    this.#listRefresh.set(key, run);
    return run;
  }

  // ── forwarding (local UI → peer) ──────────────────────────────────────

  /**
   * Sends a local API request to machine `machineId` (`path` is the peer's own
   * path, ids raw) and namespaces its answer. 404 `not-found` for an unknown machine,
   * 502 `peer-unreachable` when it cannot be reached, 502 `peer-auth-failed` when it
   * refuses our token; any other answer is passed on (2xx bodies mapped).
   */
  async forward(machineId: string, method: string, path: string, body: unknown): Promise<{ readonly status: number; readonly body: unknown }> {
    const connection = this.#connections.get(machineId);
    const ref = this.#ref(machineId);
    if (!connection || !ref) return { status: 404, body: { error: 'not-found', message: `no paired machine ${machineId}` } };
    // D52: Save schedule (a folder scan) and Run now (a start with worktrees) take the long limit too.
    // D57: an upload (up to 20 MiB over the tailnet) takes the long limit too.
    const long =
      (method === 'POST' && (path === '/api/sessions' || path.startsWith('/api/branching/') || path.startsWith('/api/hooks/') || path.startsWith('/api/schedules') || path.split('?')[0]?.endsWith('/attachments'))) ||
      path.endsWith('/hook');
    const kind = peerAnswerKind(method, path);
    // D48 ruling D48-cache-persist: a session's detail and its (whole) events are kept as last known and read while the machine is away.
    const snapshot = snapshotOf(method, path, kind);
    const offline = async (reason: string): Promise<{ readonly status: number; readonly body: unknown }> => {
      if (snapshot) {
        const stored = await this.#store.peerSnapshots.get(machineId, snapshot.kind, snapshot.key);
        if (stored !== undefined) return { status: 200, body: mapPeerAnswer(this.#ref(machineId) ?? ref, kind, stored) };
      }
      const current = this.#ref(machineId) ?? ref;
      return { status: 502, body: { error: 'peer-unreachable', message: unreachableMessage(current), reason, state: current.state } };
    };
    // Fix · peer reconnects: while it reconnects, a read with a snapshot answers from it at once; anything else is
    // held for the reconnection (at most the hold time, or until the grace ends).
    if (connection.state === 'reconnecting' && !(snapshot && (await this.#store.peerSnapshots.get(machineId, snapshot.kind, snapshot.key)) !== undefined)) {
      await connection.whenSettled(this.#timings.holdMs ?? PEER_HOLD_MS);
    }
    // Nothing is sent to a machine that is not connected: reads come from the snapshot, everything else is refused at once.
    if (connection.state !== 'online') return offline(connection.lastError ?? connection.state);
    let answer: { status: number; body: unknown };
    try {
      answer = await connection.request(method, `/peer/v1${path}`, body ?? undefined, { timeoutMs: long ? PEER_LONG_TIMEOUT_MS : PEER_FORWARD_TIMEOUT_MS });
    } catch (error) {
      if (error instanceof PeerUnreachableError) return offline(error.message);
      throw error;
    }
    if (snapshot && answer.status === 200) await this.#store.peerSnapshots.put(machineId, snapshot.kind, snapshot.key, answer.body).catch((error: unknown) => this.#onError(error));
    if (answer.status === 401) {
      connection.kick();
      return { status: 502, body: { error: 'peer-auth-failed', message: `${ref.name} refused this pairing (revoked there?): pair again` } };
    }
    if (answer.status >= 200 && answer.status < 300) {
      // D52: a schedule changed there (saved, run, paused, resumed, deleted): its list is fetched again before the answer goes back.
      if (method.toUpperCase() !== 'GET' && path.split('?')[0]?.startsWith('/api/schedules')) await this.refreshList(machineId, 'schedules');
      return { status: answer.status, body: mapPeerAnswer(this.#ref(machineId) ?? ref, kind, answer.body) };
    }
    return answer;
  }

  /**
   * D57: a GET of an attachment on machine `machineId` (`path` is the peer's own
   * path): the bytes and their serving headers, passed on as they are. 404 for an
   * unknown machine, 502 `peer-unreachable` when it is not connected (no snapshot:
   * an offline machine's files are not kept here).
   */
  async forwardRaw(machineId: string, path: string): Promise<{ readonly status: number; readonly bytes: Buffer | null; readonly headers: Readonly<Record<string, string>>; readonly body?: unknown }> {
    const connection = this.#connections.get(machineId);
    const ref = this.#ref(machineId);
    if (!connection || !ref) return { status: 404, bytes: null, headers: {}, body: { error: 'not-found', message: `no paired machine ${machineId}` } };
    const offline = (reason: string) => {
      const current = this.#ref(machineId) ?? ref;
      return { status: 502, bytes: null, headers: {}, body: { error: 'peer-unreachable', message: unreachableMessage(current), reason, state: current.state } };
    };
    if (connection.state === 'reconnecting') await connection.whenSettled(this.#timings.holdMs ?? PEER_HOLD_MS);
    if (connection.state !== 'online') return offline(connection.lastError ?? connection.state);
    try {
      const answer = await connection.requestRaw(`/peer/v1${path}`, { timeoutMs: PEER_LONG_TIMEOUT_MS });
      if (answer.status === 401) {
        connection.kick();
        return { status: 502, bytes: null, headers: {}, body: { error: 'peer-auth-failed', message: `${ref.name} refused this pairing (revoked there?): pair again` } };
      }
      return { status: answer.status, bytes: answer.bytes, headers: answer.headers };
    } catch (error) {
      if (error instanceof PeerUnreachableError) return offline(error.message);
      throw error;
    }
  }

  /** `true` when `id` is a paired machine. */
  hasMachine(id: string): boolean {
    return this.#records.has(id);
  }

  // ── PeerHandlers (the peer listener's routes) ─────────────────────────

  async authenticate(token: string): Promise<MachineRecord | null> {
    const hash = hashPeerToken(token);
    const record = await this.#store.machines.getByInboundHash(hash);
    return record && hashesMatch(record.inboundTokenHash, hash) ? record : null;
  }

  async pair(input: unknown): Promise<{ readonly status: number; readonly body: unknown }> {
    const body = (typeof input === 'object' && input !== null ? input : {}) as { code?: unknown; id?: unknown; name?: unknown; address?: unknown; token?: unknown };
    const refusal = this.#pairing.consume(body.code);
    if (refusal) return { status: 403, body: { error: 'pairing-refused', reason: refusal } };
    const self = await this.self();
    if (!isMachineId(body.id) || body.id === self.id || typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) {
      return { status: 400, body: { error: 'invalid', message: 'the pairing request is not well-formed' } };
    }
    const address = body.address === null || body.address === undefined ? null : parsePeerAddress(body.address);
    const outbound = body.token;
    const inbound = newPeerToken();
    const record = await this.#store.machines.upsert({
      id: body.id,
      name: cleanMachineName(body.name) ?? body.id,
      address: address ? formatPeerAddress(address) : null,
      outboundToken: outbound,
      inboundTokenHash: hashPeerToken(inbound),
    });
    this.#records.set(record.id, record);
    this.#connect(record.id, true);
    return { status: 200, body: { id: self.id, name: self.name, token: inbound } };
  }

  async hello(machine: MachineRecord, input: unknown): Promise<unknown> {
    const body = (typeof input === 'object' && input !== null ? input : {}) as { address?: unknown };
    const parsed = typeof body.address === 'string' ? parsePeerAddress(body.address) : null;
    const address = parsed ? formatPeerAddress(parsed) : null;
    const patch: { lastSeenAt: string; address?: string } = { lastSeenAt: new Date().toISOString() };
    // The caller's listener moved (or was switched on): remember where it is now (never forgotten on a hello without one).
    if (address && address !== machine.address) patch.address = address;
    const record = await this.#store.machines.update(machine.id, patch);
    if (record) this.#records.set(record.id, record);
    if (patch.address) this.#connect(machine.id, true);
    // The machine just reached us: reach back now instead of waiting out the reconnect backoff (an attempt in progress goes on).
    else if (this.#connections.get(machine.id)?.state !== 'online') this.#connections.get(machine.id)?.wake();
    const self = await this.self();
    return { id: self.id, name: self.name, version: this.#version };
  }

  async unpair(machine: MachineRecord): Promise<void> {
    await this.#forget(machine.id);
  }

  events(machine: MachineRecord, res: ServerResponse): void {
    if (this.#closed) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'closing' }));
      return;
    }
    res.writeHead(200, { 'content-type': SSE_CONTENT_TYPE, 'cache-control': 'no-store', connection: 'keep-alive' });
    res.flushHeaders();
    const write = (frame: string): void => {
      if (res.writableEnded || res.destroyed) return;
      res.write(frame);
      // A peer that stopped reading is dropped (it reconnects and refetches).
      if (res.writableLength > 8 * 1024 * 1024) stream.close();
    };
    const unsubscribe = this.#bus.subscribe((message) => {
      // Only this machine's own events: never one that came from a peer (no echo, no chains).
      if (this.#republishing || !PEER_HUB_EVENTS.has(message.name) || isAboutRemote(message)) return;
      if (message.name === 'inboxChanged') {
        // This machine's own count (the bus's count may include other peers' items).
        void inboxCount(this.#store).then(
          (count) => write(formatEvent('inboxChanged', { count })),
          (error: unknown) => this.#onError(error),
        );
        return;
      }
      write(formatEvent(message.name, message.payload));
    });
    const keepalive = setInterval(() => write(KEEPALIVE_FRAME), 10_000);
    keepalive.unref();
    let closed = false;
    const stream: InboundStream = {
      machineId: machine.id,
      res,
      close: () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(keepalive);
        this.#inbound.delete(stream);
        if (!res.writableEnded) res.end();
      },
    };
    this.#inbound.add(stream);
    res.on('close', stream.close);
    res.on('error', stream.close);
  }

  async api(machine: MachineRecord, method: string, url: string, body: unknown): Promise<PeerApiAnswer> {
    if (!peerApiAllowed(method, url)) {
      return { status: 403, body: JSON.stringify({ error: 'peer-forbidden', message: `${method} ${url.split('?')[0]} is not part of the peer API` }), contentType: 'application/json; charset=utf-8' };
    }
    const app = this.#app;
    if (!app) return { status: 503, body: JSON.stringify({ error: 'closing' }), contentType: 'application/json; charset=utf-8' };
    const response = await app.inject({
      method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
      url,
      headers: {
        host: `127.0.0.1:${this.#config.port}`,
        cookie: `${TOKEN_COOKIE}=${this.#token}`,
        [PEER_REQUEST_HEADER]: machine.id,
        ...(body === undefined || body === null ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined || body === null ? {} : { payload: JSON.stringify(body) }),
    });
    const contentType = response.headers['content-type'];
    // D57: an attachment is bytes: sent as they are, with the headers that say how to show it.
    if (method.toUpperCase() === 'GET' && PEER_ATTACHMENT_GET.test(url.split('?')[0] ?? '')) {
      const headers: Record<string, string> = {};
      for (const name of PEER_RAW_HEADERS) {
        const value = response.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      return { status: response.statusCode, body: response.rawPayload, contentType: typeof contentType === 'string' ? contentType : null, headers };
    }
    return { status: response.statusCode, body: response.body, contentType: typeof contentType === 'string' ? contentType : null };
  }
}

/** `true` for a bus message about a peer's session (its ids are remote ids): never sent on to another peer. */
function isAboutRemote(message: HubMessage): boolean {
  const payload = message.payload as unknown as Record<string, unknown>;
  if (typeof payload !== 'object' || payload === null) return false;
  return isRemoteId(payload['sessionId']) || isRemoteId(payload['id']) || isRemoteId(payload['scheduleId']) || (message.name === 'sessionUpdated' && payload['machine'] != null);
}

/** The host name without a `.local` / domain tail. */
function defaultMachineName(): string {
  return cleanMachineName(os.hostname().replace(/\.local$/i, '').split('.')[0]) ?? 'this machine';
}

function pairingRefusalText(reason: string): string {
  switch (reason) {
    case 'no-code':
      return 'the other machine has no pairing code waiting: click "Allow a new peer" there first';
    case 'expired':
      return 'the code expired: make a new one on the other machine';
    case 'too-many-tries':
      return 'too many wrong codes: make a new one on the other machine';
    default:
      return 'the code is wrong';
  }
}

/**
 * D48 ruling D48-cache-persist, reworded by the fix · peer reconnects: the 502's
 * message while a machine cannot be reached (the UI shows its own line with the
 * retry countdown and **Reconnect now**).
 */
export function offlineMessage(name: string): string {
  return `${name} is unreachable — it retries by itself; Reconnect now tries at once`;
}

/** Fix · peer reconnects: the 502's message for the machine's state now (a held action that timed out says so). */
export function unreachableMessage(machine: { readonly name: string; readonly state: MachineState }): string {
  if (machine.state === 'reconnecting') return `${machine.name} is still reconnecting — try again in a moment`;
  if (machine.state === 'auth-failed') return `${machine.name} refused this pairing (revoked there?): pair again`;
  return offlineMessage(machine.name);
}

/** The snapshot a forwarded read is kept as: a session's detail, or its whole event list (no `since`); `null` for anything else. */
function snapshotOf(method: string, path: string, kind: ReturnType<typeof peerAnswerKind>): { readonly kind: 'detail' | 'events'; readonly key: string } | null {
  if (method.toUpperCase() !== 'GET' || (kind !== 'detail' && kind !== 'events')) return null;
  const [pathname, query] = path.split('?') as [string, string | undefined];
  if (kind === 'events' && query && new URLSearchParams(query).has('since')) return null;
  const segment = pathname.split('/')[3];
  if (!segment) return null;
  try {
    return { kind, key: decodeURIComponent(segment) };
  } catch {
    return null;
  }
}
