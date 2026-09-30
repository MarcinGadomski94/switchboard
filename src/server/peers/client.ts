import type { HubEventName, HubEvents, InboxItem, Session } from '../../core/api.ts';
import { HUB_EVENT_NAMES } from '../../core/api.ts';
import type { MachineState } from '../../core/peers.ts';
import { readSse } from './sse.ts';

/**
 * One outbound connection to a paired machine (D48, `docs/peers.md` →
 * *Connections*): the peer's live event stream (`GET /peer/v1/events`) kept open
 * with reconnects on a backoff, and the peer's open sessions and Inbox items kept
 * as a cache (so local lists never wait on the network, and an offline peer's
 * sessions still show, as unreachable). Requests carry the per-pair bearer token;
 * nothing here logs it.
 */

/** Backoff between connection attempts: 1 s doubling up to 60 s, back to 1 s after a success. */
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;

/** Default time limit of one request to a peer. */
export const PEER_REQUEST_TIMEOUT_MS = 15_000;

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

/** Options of {@link PeerConnection}. */
export interface PeerConnectionOptions {
  /** The machine (its address and token may change: read on every attempt). */
  readonly target: () => Promise<PeerTarget | null>;
  /** This machine's own listener address (`host:port`) to tell the peer, `null` when it does not listen. */
  readonly ownAddress: () => string | null;
  /** A raw event from the peer's stream (not mapped yet). */
  readonly onEvent: <K extends HubEventName>(name: K, payload: HubEvents[K]) => void;
  /** The state changed (online / offline / auth-failed / no-address). */
  readonly onState: (state: MachineState, error: string | null) => void;
  /** The session or Inbox cache changed. */
  readonly onCache: () => void;
  /** A successful contact (hello). */
  readonly onSeen: (info: { readonly name: string | null }) => void;
  readonly onError?: (error: unknown) => void;
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** The fetch to use (tests). */
  readonly fetch?: typeof fetch;
}

/** One paired machine's connection and caches. */
export class PeerConnection {
  readonly #options: PeerConnectionOptions;
  readonly #fetch: typeof fetch;
  #state: MachineState = 'offline';
  #error: string | null = null;
  #sessions: Session[] = [];
  #inbox: InboxItem[] = [];
  #closed = false;
  #abort: AbortController | null = null;
  #timer: NodeJS.Timeout | undefined;
  #backoffMs: number;
  #running: Promise<void> | null = null;
  #inboxRefresh: Promise<void> | null = null;
  #inboxAgain = false;

  constructor(options: PeerConnectionOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    this.#backoffMs = options.minBackoffMs ?? RECONNECT_MIN_MS;
  }

  get state(): MachineState {
    return this.#state;
  }

  get lastError(): string | null {
    return this.#error;
  }

  /** The peer's open sessions as last known (raw, not mapped). */
  get sessions(): readonly Session[] {
    return this.#sessions;
  }

  /** The peer's Inbox items as last known (raw). Empty while not online (an unreachable peer's items cannot be answered). */
  get inbox(): readonly InboxItem[] {
    return this.#state === 'online' ? this.#inbox : [];
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
    this.#running = this.#loop().finally(() => {
      this.#running = null;
    });
  }

  /** Connects again now (after a new pairing or an address change), dropping the current stream. */
  kick(): void {
    this.#backoffMs = this.#options.minBackoffMs ?? RECONNECT_MIN_MS;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#wake?.();
    this.#abort?.abort();
    this.start();
  }

  /** Cuts a reconnect backoff short (the machine just reached us); an attempt in progress is left alone. */
  wake(): void {
    this.#backoffMs = this.#options.minBackoffMs ?? RECONNECT_MIN_MS;
    if (this.#abort) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#wake?.();
  }

  /** Stops for good (the machine was removed, or the service stops). */
  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#wake?.();
    this.#abort?.abort();
    await this.#running;
  }

  #wake: (() => void) | null = null;

  async #sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#wake = resolve;
      this.#timer = setTimeout(resolve, ms);
      this.#timer.unref();
    });
    this.#wake = null;
  }

  #setState(state: MachineState, error: string | null): void {
    if (this.#state === state && this.#error === error) return;
    this.#state = state;
    this.#error = error;
    this.#options.onState(state, error);
  }

  async #loop(): Promise<void> {
    while (!this.#closed) {
      let next = this.#backoffMs;
      try {
        const outcome = await this.#connectOnce();
        if (outcome === 'streamed') next = this.#options.minBackoffMs ?? RECONNECT_MIN_MS;
      } catch (error) {
        if (!this.#closed) this.#options.onError?.(error);
      }
      if (this.#closed) break;
      this.#backoffMs = Math.min(next * 2, this.#options.maxBackoffMs ?? RECONNECT_MAX_MS);
      await this.#sleep(next);
    }
  }

  /** One attempt: hello, the caches, then the stream until it ends. */
  async #connectOnce(): Promise<'streamed' | 'failed'> {
    const target = await this.#options.target();
    if (!target) return 'failed';
    if (!target.address) {
      this.#setState('no-address', 'the machine has not told an address (its peer listener is off)');
      return 'failed';
    }
    const abort = new AbortController();
    this.#abort = abort;
    try {
      const hello = await this.#call(target, 'POST', '/peer/v1/hello', { address: this.#options.ownAddress() }, { signal: abort.signal });
      if (hello.status === 401) {
        this.#setState('auth-failed', 'the machine refused this pairing (revoked there?): pair again');
        return 'failed';
      }
      if (hello.status !== 200) {
        this.#setState('offline', `hello answered HTTP ${hello.status}`);
        return 'failed';
      }
      const info = hello.body as { name?: unknown } | null;
      this.#options.onSeen({ name: typeof info?.name === 'string' ? info.name : null });
      const response = await this.#fetch(`http://${target.address}/peer/v1/events`, {
        headers: { authorization: `Bearer ${target.token}`, accept: 'text/event-stream' },
        signal: abort.signal,
      });
      if (response.status === 401) {
        this.#setState('auth-failed', 'the machine refused this pairing (revoked there?): pair again');
        return 'failed';
      }
      if (response.status !== 200 || !response.body) {
        this.#setState('offline', `the event stream answered HTTP ${response.status}`);
        return 'failed';
      }
      // Online once the stream is open; the caches follow (their events are already flowing).
      await this.#refreshSessions(target, abort.signal);
      this.#setState('online', null);
      void this.refreshInbox();
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
      );
      if (!this.#closed) this.#setState('offline', 'the event stream ended');
      return 'streamed';
    } catch (error) {
      if (!this.#closed) this.#setState('offline', describe(error));
      return 'failed';
    } finally {
      if (this.#abort === abort) this.#abort = null;
    }
  }

  #apply<K extends HubEventName>(name: K, payload: HubEvents[K]): void {
    if (name === 'sessionUpdated') {
      const session = payload as HubEvents['sessionUpdated'];
      const rest = this.#sessions.filter((known) => known.id !== session.id);
      this.#sessions = session.closedAt ? rest : [...rest, session].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
      throw new PeerUnreachableError(`${target.address} could not be reached: ${describe(error)}`);
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
      throw new PeerUnreachableError(`${target.address} could not be reached: ${describe(error)}`);
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
