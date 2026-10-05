import type { HubEventName, HubEvents, InboxItem, Session } from '../../core/api.ts';
import { HUB_EVENT_NAMES } from '../../core/api.ts';
import { type MachineState, PEER_GRACE_MS, PEER_STALL_MS, type PeerFailureKind, peerFailureText } from '../../core/peers.ts';
import { readSse } from './sse.ts';

/**
 * One outbound connection to a paired machine (D48, `docs/peers.md` →
 * *Connections*): the peer's live event stream (`GET /peer/v1/events`) kept open
 * with reconnects on a backoff, and the peer's open sessions and Inbox items kept
 * as a cache (so local lists never wait on the network, and an offline peer's
 * sessions still show, as unreachable). Requests carry the per-pair bearer token;
 * nothing here logs it.
 */

/**
 * Fix · peer reconnects (`docs/peers.md` → *Connection states*): the waits before
 * each attempt after a drop: at once, then 1 s, 2 s, 5 s, 10 s, then every
 * {@link RECONNECT_MAX_MS} (ASSUMED reconnect-schedule), each with ±20 % jitter
 * (the first stays immediate).
 */
export const RECONNECT_SCHEDULE_MS: readonly number[] = [0, 1_000, 2_000, 5_000, 10_000];
export const RECONNECT_MAX_MS = 15_000;
/** ± share of a wait that is random, so two machines do not retry in lockstep. */
export const RECONNECT_JITTER = 0.2;

/** Default time limit of one request to a peer. */
export const PEER_REQUEST_TIMEOUT_MS = 15_000;

/** How many recent failure kinds are kept (for the hint). */
const RECENT_FAILURES = 5;

/** An answer from a peer: status and parsed JSON body (`null` for none). */
export interface PeerAnswer {
  readonly status: number;
  readonly body: unknown;
}

/** D57: a peer's answer as bytes (an attachment), with the headers that describe it. */
export interface PeerRawAnswer {
  readonly status: number;
  readonly bytes: Buffer;
  readonly headers: Readonly<Record<string, string>>;
}

/** D57: the headers of a peer's attachment answer that are passed on (the serving rules travel with it). */
export const PEER_RAW_HEADERS = ['content-type', 'content-disposition', 'x-content-type-options', 'content-security-policy'] as const;

/** Thrown when a peer cannot be reached (connection refused, timeout, no address). */
export class PeerUnreachableError extends Error {
  override name = 'PeerUnreachableError';
}

/** What the connection needs to know about its machine (read fresh from the store each time). */
export interface PeerTarget {
  readonly id: string;
  readonly address: string | null;
  readonly token: string;
}

/** The connection's retry state (`Machine.connection` without the hint and with epoch ms). */
export interface PeerConnectionStatus {
  readonly state: MachineState;
  readonly lastError: string | null;
  readonly attempt: number;
  readonly trying: boolean;
  readonly nextAttemptAt: number | null;
  readonly graceUntil: number | null;
  readonly lastFailure: { readonly kind: PeerFailureKind; readonly message: string; readonly at: number } | null;
  /** The newest failure kinds, oldest first (since the last time it was online). */
  readonly recentFailures: readonly PeerFailureKind[];
}

/** Options of {@link PeerConnection}. */
export interface PeerConnectionOptions {
  /** The machine (its address and token may change: read on every attempt). */
  readonly target: () => Promise<PeerTarget | null>;
  /** This machine's own listener address (`host:port`) to tell the peer, `null` when it does not listen. */
  readonly ownAddress: () => string | null;
  /** A raw event from the peer's stream (not mapped yet). */
  readonly onEvent: <K extends HubEventName>(name: K, payload: HubEvents[K]) => void;
  /** The state changed (online / reconnecting / offline / auth-failed / no-address). */
  readonly onState: (state: MachineState, error: string | null) => void;
  /** Anything of {@link PeerConnection.status} changed (an attempt started or failed, the next one was scheduled). */
  readonly onStatus?: (status: PeerConnectionStatus) => void;
  /** The session or Inbox cache changed. */
  readonly onCache: () => void;
  /** A successful contact (hello). */
  readonly onSeen: (info: { readonly name: string | null }) => void;
  readonly onError?: (error: unknown) => void;
  /** The waits between attempts ({@link RECONNECT_SCHEDULE_MS}); the last one repeats up to `maxBackoffMs`. */
  readonly schedule?: readonly number[];
  readonly maxBackoffMs?: number;
  /** Jitter share ({@link RECONNECT_JITTER}; 0 in tests that time the schedule). */
  readonly jitter?: number;
  /** `reconnecting` → `offline` after this long without success ({@link PEER_GRACE_MS}). */
  readonly graceMs?: number;
  /** A stream with nothing (no event, no keepalive) for this long is dropped and reconnected ({@link PEER_STALL_MS}). */
  readonly stallMs?: number;
  /** Time limit of the hello and of the event stream's answer (headers). */
  readonly connectTimeoutMs?: number;
  /** Randomness of the jitter (tests). */
  readonly random?: () => number;
  /** The fetch to use (tests). */
  readonly fetch?: typeof fetch;
}

/** The wait before the attempt after `failures` failed ones (0 = right after a drop, or the first). */
export function reconnectDelay(failures: number, options: { readonly schedule?: readonly number[]; readonly maxMs?: number; readonly jitter?: number; readonly random?: () => number } = {}): number {
  const schedule = options.schedule ?? RECONNECT_SCHEDULE_MS;
  const max = options.maxMs ?? RECONNECT_MAX_MS;
  const base = Math.min(failures < schedule.length ? (schedule[failures] as number) : max, max);
  if (base <= 0) return 0;
  const jitter = options.jitter ?? RECONNECT_JITTER;
  const random = options.random ?? Math.random;
  return Math.max(0, Math.min(max, Math.round(base * (1 + (random() * 2 - 1) * jitter))));
}

/** The kind of a failed fetch / stream read (the cause's code where there is one). */
export function classifyFailure(error: unknown): PeerFailureKind {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const { name, code, message } = current as { name?: unknown; code?: unknown; message?: unknown };
    if (name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') return 'timeout';
    if (code === 'ECONNREFUSED') return 'refused';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EHOSTDOWN' || code === 'ENETDOWN' || code === 'EADDRNOTAVAIL') return 'route';
    if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET' || code === 'ECONNABORTED' || (typeof message === 'string' && /other side closed|terminated|socket hang up/i.test(message) && !(current as { cause?: unknown }).cause)) return 'reset';
    current = (current as { cause?: unknown }).cause;
  }
  return 'other';
}

/** A pending "the running attempt is over" (Reconnect now waits on it; never two attempts at once). */
interface AttemptWaiter {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function waiter(): AttemptWaiter {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The service's session order (`created_at DESC, id`). */
function newestFirst(a: Session, b: Session): number {
  return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
}

/** One paired machine's connection and caches. */
export class PeerConnection {
  readonly #options: PeerConnectionOptions;
  readonly #fetch: typeof fetch;
  // Fix · peer reconnects: a new connection is `reconnecting` (within the grace) until its first attempt settles it.
  #state: MachineState = 'reconnecting';
  #error: string | null = null;
  #sessions: Session[] = [];
  #inbox: InboxItem[] = [];
  #closed = false;
  #abort: AbortController | null = null;
  #timer: NodeJS.Timeout | undefined;
  #graceTimer: NodeJS.Timeout | undefined;
  #graceUntil: number | null = null;
  /** Failed attempts since the last time it was online. */
  #failures = 0;
  #trying = false;
  #nextAttemptAt: number | null = null;
  #lastFailure: { kind: PeerFailureKind; message: string; at: number } | null = null;
  #recent: PeerFailureKind[] = [];
  /** Why this service is about to cut its own stream (a kick, a stall). */
  #cut: PeerFailureKind | null = null;
  #attemptDone: AttemptWaiter | null = null;
  /** The next attempt starts without a wait (after a kick). */
  #immediate = false;
  #settled: Array<() => void> = [];
  #running: Promise<void> | null = null;
  #inboxRefresh: Promise<void> | null = null;
  #inboxAgain = false;

  constructor(options: PeerConnectionOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
  }

  get state(): MachineState {
    return this.#state;
  }

  get lastError(): string | null {
    return this.#error;
  }

  /** The retry state (fix · peer reconnects). */
  get status(): PeerConnectionStatus {
    return {
      state: this.#state,
      lastError: this.#error,
      attempt: this.#failures,
      trying: this.#trying,
      nextAttemptAt: this.#nextAttemptAt,
      graceUntil: this.#state === 'reconnecting' ? this.#graceUntil : null,
      lastFailure: this.#lastFailure,
      recentFailures: [...this.#recent],
    };
  }

  /** The peer's open sessions as last known (raw, not mapped). */
  get sessions(): readonly Session[] {
    return this.#sessions;
  }

  /**
   * The peer's Inbox items as last known (raw). Empty while it cannot be reached
   * (an unreachable peer's items cannot be answered); kept while `reconnecting`
   * (an answer is held until it is back).
   */
  get inbox(): readonly InboxItem[] {
    return this.#state === 'online' || this.#state === 'reconnecting' ? this.#inbox : [];
  }

  /**
   * D48 ruling D48-cache-persist: the last known sessions from the stored snapshot,
   * shown (unreachable) until the machine is reached and its live list replaces them.
   */
  seed(sessions: readonly Session[]): void {
    if (this.#sessions.length === 0) this.#sessions = [...sessions];
  }

  /** Starts the connect loop (idempotent). */
  start(): void {
    if (this.#closed || this.#running) return;
    if (this.#state === 'reconnecting' && this.#graceTimer === undefined) this.#startGrace();
    this.#running = this.#loop().finally(() => {
      this.#running = null;
    });
  }

  /** Connects again now (after a new pairing or an address change), dropping the current stream. */
  kick(): void {
    this.#cut = 'restart';
    this.#cutWait();
    this.#abort?.abort();
    this.start();
  }

  /** Cuts a reconnect backoff short (the machine just reached us); an attempt in progress is left alone. */
  wake(): void {
    if (this.#closed || this.#state === 'online' || this.#trying) return;
    this.#cutWait();
  }

  /**
   * Fix · peer reconnects: **Reconnect now**. Cuts any wait and tries at once; when
   * an attempt is already running it waits for that one instead (never two at
   * once). Resolves with the state the attempt left (`online` on success), at the
   * latest after `timeoutMs`.
   */
  async reconnectNow(timeoutMs = 2 * PEER_REQUEST_TIMEOUT_MS): Promise<MachineState> {
    if (this.#closed || this.#state === 'online') return this.#state;
    this.#attemptDone ??= waiter();
    const done = this.#attemptDone.promise;
    if (!this.#trying) {
      this.#cutWait();
      this.start();
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    return this.#state;
  }

  /**
   * Fix · peer reconnects: resolves once the connection is no longer
   * `reconnecting` (online, or the grace ended), at the latest after `maxMs`.
   * What a held action waits on.
   */
  whenSettled(maxMs: number): Promise<MachineState> {
    if (this.#state !== 'reconnecting' || this.#closed) return Promise.resolve(this.#state);
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.#settled = this.#settled.filter((entry) => entry !== finish);
        resolve(this.#state);
      };
      const timer = setTimeout(finish, maxMs);
      timer.unref();
      this.#settled.push(finish);
    });
  }

  /** Stops for good (the machine was removed, or the service stops). */
  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    clearTimeout(this.#graceTimer);
    this.#wake?.();
    this.#abort?.abort();
    for (const finish of [...this.#settled]) finish();
    this.#attemptDone?.resolve();
    await this.#running;
  }

  #wake: (() => void) | null = null;

  /** Ends the wait before the next attempt (if one is running). */
  #cutWait(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#wake?.();
  }

  async #sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => {
      this.#wake = resolve;
      this.#timer = setTimeout(resolve, ms);
      this.#timer.unref();
    });
    this.#wake = null;
    this.#timer = undefined;
  }

  #emitStatus(): void {
    this.#options.onStatus?.(this.status);
  }

  #setState(state: MachineState, error: string | null): void {
    if (this.#state === state && this.#error === error) return;
    const before = this.#state;
    this.#state = state;
    this.#error = error;
    if (state !== 'reconnecting') {
      clearTimeout(this.#graceTimer);
      this.#graceTimer = undefined;
      this.#graceUntil = null;
    }
    this.#options.onState(state, error);
    if (before === 'reconnecting' && state !== 'reconnecting') for (const finish of [...this.#settled]) finish();
  }

  #startGrace(): void {
    clearTimeout(this.#graceTimer);
    const graceMs = this.#options.graceMs ?? PEER_GRACE_MS;
    this.#graceUntil = Date.now() + graceMs;
    this.#graceTimer = setTimeout(() => {
      this.#graceTimer = undefined;
      if (this.#closed || this.#state !== 'reconnecting') return;
      this.#setState('offline', this.#error ?? 'not reached within the grace period');
      this.#emitStatus();
    }, graceMs);
    this.#graceTimer.unref();
  }

  /** The open stream dropped: `reconnecting` within the grace period (actions held, reads from the cache). */
  #dropped(kind: PeerFailureKind, detail: string | null): void {
    this.#recordFailure(kind, detail);
    if (this.#state === 'online') {
      this.#setState('reconnecting', this.#lastFailure?.message ?? null);
      this.#startGrace();
    }
  }

  #recordFailure(kind: PeerFailureKind, detail: string | null): void {
    const words = peerFailureText(kind);
    const message = detail ? `${words} (${detail})` : words;
    this.#lastFailure = { kind, message, at: Date.now() };
    this.#recent = [...this.#recent, kind].slice(-RECENT_FAILURES);
  }

  /** One attempt failed: offline (unless still within the grace), auth failed or no address. */
  #failed(kind: PeerFailureKind, detail: string | null, state?: 'auth-failed' | 'no-address'): void {
    // An attempt this service cut itself (a kick) is no failure of the machine: the next one starts at once.
    if (kind === 'restart') {
      this.#immediate = true;
      return;
    }
    this.#failures += 1;
    this.#recordFailure(kind, detail);
    const message = this.#lastFailure?.message ?? null;
    if (state) this.#setState(state, message);
    // Within the grace period it stays `reconnecting` (the status carries the failure).
    else if (this.#state === 'reconnecting') this.#error = message;
    else this.#setState('offline', message);
  }

  #attemptOver(): void {
    const done = this.#attemptDone;
    this.#attemptDone = null;
    done?.resolve();
  }

  async #loop(): Promise<void> {
    while (!this.#closed) {
      this.#trying = true;
      this.#nextAttemptAt = null;
      this.#emitStatus();
      let streamed = false;
      try {
        streamed = await this.#connectOnce();
      } catch (error) {
        if (!this.#closed) {
          this.#options.onError?.(error);
          this.#failed('other', describe(error));
        }
      }
      this.#trying = false;
      this.#attemptOver();
      if (this.#closed) break;
      // Right after a drop the next attempt starts at once; after failed attempts it waits along the schedule.
      const immediate = streamed || this.#immediate;
      this.#immediate = false;
      const wait = immediate
        ? 0
        : reconnectDelay(this.#failures, {
            ...(this.#options.schedule ? { schedule: this.#options.schedule } : {}),
            ...(this.#options.maxBackoffMs !== undefined ? { maxMs: this.#options.maxBackoffMs } : {}),
            ...(this.#options.jitter !== undefined ? { jitter: this.#options.jitter } : {}),
            ...(this.#options.random ? { random: this.#options.random } : {}),
          });
      this.#nextAttemptAt = Date.now() + wait;
      this.#emitStatus();
      await this.#sleep(wait);
    }
  }

  /** One attempt: hello, the caches, then the stream until it ends. `true` when it was online (and then dropped). */
  async #connectOnce(): Promise<boolean> {
    const target = await this.#options.target();
    if (!target) {
      this.#failed('other', 'the machine is not paired');
      return false;
    }
    if (!target.address) {
      this.#failures += 1;
      this.#setState('no-address', 'the machine has not told an address (its peer listener is off)');
      return false;
    }
    const abort = new AbortController();
    this.#abort = abort;
    this.#cut = null;
    let online = false;
    let stall: NodeJS.Timeout | undefined;
    const connectTimeoutMs = this.#options.connectTimeoutMs ?? PEER_REQUEST_TIMEOUT_MS;
    try {
      let hello: PeerAnswer;
      try {
        hello = await this.#call(target, 'POST', '/peer/v1/hello', { address: this.#options.ownAddress() }, { signal: abort.signal, timeoutMs: connectTimeoutMs });
      } catch (error) {
        this.#failed(this.#cut ?? classifyFailure(error), describe(error));
        return false;
      }
      if (hello.status === 401) {
        this.#failed('auth', null, 'auth-failed');
        return false;
      }
      if (hello.status !== 200) {
        this.#failed('http', `hello answered HTTP ${hello.status}`);
        return false;
      }
      const info = hello.body as { name?: unknown } | null;
      this.#options.onSeen({ name: typeof info?.name === 'string' ? info.name : null });
      // The stream's answer (its headers) must come within the time limit too: a peer that took the connection
      // but never answers would otherwise hold the attempt for ever.
      const headers = setTimeout(() => {
        this.#cut = 'timeout';
        abort.abort();
      }, connectTimeoutMs);
      let response: Response;
      try {
        response = await this.#fetch(`http://${target.address}/peer/v1/events`, {
          headers: { authorization: `Bearer ${target.token}`, accept: 'text/event-stream' },
          signal: abort.signal,
        });
      } catch (error) {
        this.#failed(this.#cut ?? classifyFailure(error), describe(error));
        return false;
      } finally {
        clearTimeout(headers);
      }
      if (response.status === 401) {
        this.#failed('auth', null, 'auth-failed');
        return false;
      }
      if (response.status !== 200 || !response.body) {
        this.#failed('http', `the event stream answered HTTP ${response.status}`);
        return false;
      }
      // A stream that goes quiet (no event, no keepalive) is cut and reconnected, not left for TCP to notice.
      const stallMs = this.#options.stallMs ?? PEER_STALL_MS;
      const armStall = (): void => {
        clearTimeout(stall);
        stall = setTimeout(() => {
          this.#cut = 'stalled';
          abort.abort();
        }, stallMs);
        stall.unref();
      };
      armStall();
      // Online once the stream is open; the caches follow (their events are already flowing).
      try {
        await this.#refreshSessions(target, abort.signal);
      } catch (error) {
        this.#failed(this.#cut ?? classifyFailure(error), describe(error));
        return false;
      }
      online = true;
      this.#trying = false;
      this.#failures = 0;
      this.#recent = [];
      this.#setState('online', null);
      this.#attemptOver();
      this.#emitStatus();
      void this.refreshInbox();
      let readError: unknown = null;
      try {
        await readSse(
          response.body,
          (frame) => {
            const name = frame.event as HubEventName;
            if (!HUB_EVENT_NAMES.includes(name)) return;
            let payload: unknown;
            try {
              payload = JSON.parse(frame.data);
            } catch {
              return;
            }
            this.#apply(name, payload as HubEvents[typeof name]);
          },
          abort.signal,
          armStall,
        );
      } catch (error) {
        readError = error;
      }
      if (!this.#closed) {
        const stallSeconds = Math.round(stallMs / 1000);
        if (this.#cut === 'stalled') this.#dropped('stalled', `nothing for ${stallSeconds} s`);
        else if (this.#cut) this.#dropped(this.#cut, null);
        else if (readError) this.#dropped(classifyFailure(readError), describe(readError));
        else this.#dropped('ended', null);
      }
      return true;
    } finally {
      clearTimeout(stall);
      if (this.#abort === abort) this.#abort = null;
      // A failed attempt never leaves a half-open stream behind.
      if (!online) abort.abort();
    }
  }

  #apply<K extends HubEventName>(name: K, payload: HubEvents[K]): void {
    if (name === 'sessionUpdated') {
      const session = payload as HubEvents['sessionUpdated'];
      const rest = this.#sessions.filter((known) => known.id !== session.id);
      // The peer's own list order (newest first, `GET /api/sessions`): its rows keep their places in the sidebar (D71 fix:
      // this was oldest first, so the rows flipped between a refresh and the next update).
      this.#sessions = session.closedAt ? rest : [...rest, session].sort(newestFirst);
      this.#options.onCache();
    }
    if (name === 'activity') {
      // D53: the cached session carries the newest live activity, so a list read after the event (the sidebar's
      // reload on any `sessionUpdated`) shows the running tool, not the activity of the last `sessionUpdated`.
      // Not written to the snapshot (`onCache`): it changes too often, and an offline peer shows none anyway.
      const { sessionId, activity } = payload as HubEvents['activity'];
      this.#sessions = this.#sessions.map((known) => (known.id === sessionId ? { ...known, activity } : known));
    }
    if (name === 'inboxChanged') void this.refreshInbox();
    if (name === 'questionBatch') {
      // The toast reads the batch's Inbox item: have it in the cache before the event goes out.
      void this.refreshInbox().then(() => {
        if (!this.#closed) this.#options.onEvent(name, payload);
      });
      return;
    }
    this.#options.onEvent(name, payload);
  }

  async #refreshSessions(target: PeerTarget, signal: AbortSignal): Promise<void> {
    const answer = await this.#call(target, 'GET', '/peer/v1/api/sessions', undefined, { signal });
    if (answer.status === 200 && Array.isArray(answer.body)) {
      this.#sessions = answer.body as Session[];
      this.#options.onCache();
    }
  }

  /** Fetches the peer's Inbox again (coalesced: one refresh at a time, one more after it when asked meanwhile). */
  refreshInbox(): Promise<void> {
    if (this.#inboxRefresh) {
      this.#inboxAgain = true;
      return this.#inboxRefresh;
    }
    this.#inboxRefresh = (async () => {
      do {
        this.#inboxAgain = false;
        try {
          const target = await this.#options.target();
          if (!target?.address) return;
          const answer = await this.#call(target, 'GET', '/peer/v1/api/inbox');
          if (answer.status === 200 && Array.isArray(answer.body)) {
            this.#inbox = answer.body as InboxItem[];
            this.#options.onCache();
          }
        } catch (error) {
          if (!this.#closed) this.#options.onError?.(error);
        }
      } while (this.#inboxAgain && !this.#closed);
    })().finally(() => {
      this.#inboxRefresh = null;
    });
    return this.#inboxRefresh;
  }

  /**
   * One request to the peer (`path` under `/peer/v1`). Throws {@link PeerUnreachableError}
   * when there is no address or the peer cannot be reached in time.
   */
  async request(method: string, path: string, body?: unknown, options: { readonly timeoutMs?: number } = {}): Promise<PeerAnswer> {
    const target = await this.#options.target();
    if (!target) throw new PeerUnreachableError('the machine is not paired');
    if (!target.address) throw new PeerUnreachableError('the machine has not told an address (its peer listener is off)');
    return this.#call(target, method, path, body, { timeoutMs: options.timeoutMs ?? PEER_REQUEST_TIMEOUT_MS });
  }

  /**
   * D57: a GET whose answer is bytes (an attachment the peer serves): the body is
   * not parsed, and {@link PEER_RAW_HEADERS} come along. Throws
   * {@link PeerUnreachableError} like {@link request}.
   */
  async requestRaw(path: string, options: { readonly timeoutMs?: number } = {}): Promise<PeerRawAnswer> {
    const target = await this.#options.target();
    if (!target) throw new PeerUnreachableError('the machine is not paired');
    if (!target.address) throw new PeerUnreachableError('the machine has not told an address (its peer listener is off)');
    let response: Response;
    try {
      response = await this.#fetch(`http://${target.address}${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${target.token}` },
        signal: AbortSignal.timeout(options.timeoutMs ?? PEER_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new PeerUnreachableError(`${target.address} could not be reached: ${describe(error)}`, { cause: error });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const headers: Record<string, string> = {};
    for (const name of PEER_RAW_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    return { status: response.status, bytes, headers };
  }

  async #call(
    target: PeerTarget,
    method: string,
    path: string,
    body?: unknown,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ): Promise<PeerAnswer> {
    const signals = [AbortSignal.timeout(options.timeoutMs ?? PEER_REQUEST_TIMEOUT_MS)];
    if (options.signal) signals.push(options.signal);
    let response: Response;
    try {
      response = await this.#fetch(`http://${target.address}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${target.token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      throw new PeerUnreachableError(`${target.address} could not be reached: ${describe(error)}`, { cause: error });
    }
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, body: parsed };
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return `${error.message} (${cause.message})`;
    return error.message;
  }
  return String(error);
}
