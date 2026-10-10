import type { ServerResponse } from 'node:http';
import type { HubEventName } from '../../core/api.ts';
import type { SystemProvider } from '../providers.ts';
import type { HubBus, HubMessage } from './bus.ts';
import { AgentDeltaEncoder } from '../../core/agent-delta.ts';

/**
 * The `/hub` Server-Sent Events stream (M2.3, D5, `contracts/local-api.md` →
 * Event hub). Every message published on the {@link HubBus} goes to every
 * connected client as
 *
 * ```
 * event: <name>
 * data: <payload as one line of camelCase JSON>
 *
 * ```
 *
 * A `: keepalive` comment goes out at least every 15 s, and a `system` event
 * (the `GET /api/system` shape from `providers.system`) every 5 s while at least
 * one client is connected. Details and the reasoning: `docs/hub.md`.
 */

/** `Content-Type` of the stream, exactly as the contract names it. */
export const SSE_CONTENT_TYPE = 'text/event-stream';

/** The keepalive comment frame. */
export const KEEPALIVE_FRAME = ': keepalive\n\n';

/** Default gap between keepalive comments (the contract's bound is 15 s). */
export const DEFAULT_KEEPALIVE_MS = 10_000;

/** Default gap between `system` events (contract: every 5 s). */
export const DEFAULT_SYSTEM_INTERVAL_MS = 5_000;

/** A client whose unsent output grows past this is dropped (it reconnects and refetches). */
export const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/**
 * One SSE frame. `JSON.stringify` escapes line breaks inside strings, so the
 * payload is always a single `data:` line.
 */
export function formatEvent(name: HubEventName, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Options for {@link SseHub}. */
export interface SseHubOptions {
  readonly bus: HubBus;
  /** Source of the periodic `system` event; without one no `system` event is sent. */
  readonly system?: SystemProvider;
  /** Gap between keepalive comments (default 10 s; must stay ≤ 15 s in production). */
  readonly keepaliveMs?: number;
  /** Gap between `system` events (default 5 s). */
  readonly systemIntervalMs?: number;
  /** Per-client cap on unsent bytes before the client is dropped (default 8 MiB). */
  readonly maxBufferedBytes?: number;
  /** Called when the system provider or a write fails (default: `console.error`). */
  readonly onError?: (error: unknown) => void;
}

/** Options of the hub a server builds; tests shorten the intervals. */
export type HubTimingOptions = Pick<SseHubOptions, 'keepaliveMs' | 'systemIntervalMs' | 'maxBufferedBytes'>;

interface Client {
  readonly res: ServerResponse;
  readonly detach: () => void;
  /** D95 follow-up: the client asked for agent deltas (`/hub?agents=delta`); what it was sent. */
  readonly deltas: AgentDeltaEncoder | null;
}

/** Fans the bus out to the connected SSE clients. */
export class SseHub {
  readonly #bus: HubBus;
  readonly #system: SystemProvider | undefined;
  readonly #keepaliveMs: number;
  readonly #systemIntervalMs: number;
  readonly #maxBuffered: number;
  readonly #onError: (error: unknown) => void;
  readonly #clients = new Set<Client>();
  #unsubscribe: (() => void) | null = null;
  #keepaliveTimer: NodeJS.Timeout | undefined;
  #systemTimer: NodeJS.Timeout | undefined;
  #systemInFlight = false;
  #closed = false;

  constructor(options: SseHubOptions) {
    this.#bus = options.bus;
    this.#system = options.system;
    this.#keepaliveMs = options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
    this.#systemIntervalMs = options.systemIntervalMs ?? DEFAULT_SYSTEM_INTERVAL_MS;
    this.#maxBuffered = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.#onError = options.onError ?? ((error) => console.error('switchboard hub:', error));
  }

  /** Number of connected clients (M9.2 polls usage only while one is connected). */
  get clientCount(): number {
    return this.#clients.size;
  }

  /** `true` once {@link close} ran; new clients are refused with 503. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Takes over a request that passed the security guard (Fastify `reply.hijack()`):
   * writes the stream headers and keeps the response open until the client goes
   * away or the hub closes.
   */
  attach(res: ServerResponse, options: { readonly agentDeltas?: boolean } = {}): void {
    if (this.#closed) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'closing' }));
      return;
    }
    res.writeHead(200, {
      'content-type': SSE_CONTENT_TYPE,
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.flushHeaders();
    const onGone = (): void => this.#drop(client);
    const onError = (): void => this.#drop(client);
    const client: Client = {
      res,
      deltas: options.agentDeltas ? new AgentDeltaEncoder() : null,
      detach: () => {
        res.off('close', onGone);
        res.off('error', onError);
      },
    };
    res.on('close', onGone);
    res.on('error', onError);
    this.#clients.add(client);
    this.#start();
  }

  /** Ends every stream (clients see a clean end of stream), stops the timers and leaves the bus. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const client of [...this.#clients]) {
      this.#clients.delete(client);
      client.detach();
      if (!client.res.writableEnded) client.res.end();
    }
    this.#stop();
  }

  #start(): void {
    if (!this.#unsubscribe) this.#unsubscribe = this.#bus.subscribe((message) => this.#broadcast(message));
    if (!this.#keepaliveTimer) {
      this.#keepaliveTimer = setInterval(() => this.#writeAll(KEEPALIVE_FRAME), this.#keepaliveMs);
      this.#keepaliveTimer.unref();
    }
    if (this.#system && !this.#systemTimer) {
      this.#systemTimer = setInterval(() => void this.#tickSystem(), this.#systemIntervalMs);
      this.#systemTimer.unref();
    }
  }

  /** Timers and the bus subscription live only while a client is connected. */
  #stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    clearInterval(this.#keepaliveTimer);
    this.#keepaliveTimer = undefined;
    clearInterval(this.#systemTimer);
    this.#systemTimer = undefined;
  }

  #drop(client: Client): void {
    if (!this.#clients.delete(client)) return;
    client.detach();
    if (!client.res.destroyed) client.res.destroy();
    if (this.#clients.size === 0) this.#stop();
  }

  #broadcast(message: HubMessage): void {
    if (message.name === 'sessionUpdated' && [...this.#clients].some((client) => client.deltas)) {
      // D95 follow-up: a delta client gets its own frame (only the agents that changed for it).
      let whole: string | null = null;
      for (const client of [...this.#clients]) {
        try {
          const frame = client.deltas ? formatEvent('sessionUpdated', client.deltas.encode(message.payload)) : (whole ??= formatEvent('sessionUpdated', message.payload));
          this.#write(client, frame);
        } catch (error) {
          this.#onError(error);
        }
      }
      return;
    }
    let frame: string;
    try {
      frame = formatEvent(message.name, message.payload);
    } catch (error) {
      this.#onError(error);
      return;
    }
    this.#writeAll(frame);
  }

  #write(client: Client, frame: string): void {
    const { res } = client;
    if (res.writableEnded || res.destroyed) {
      this.#drop(client);
      return;
    }
    res.write(frame);
    if (res.writableLength > this.#maxBuffered) this.#drop(client);
  }

  #writeAll(frame: string): void {
    // A client that stopped reading would make the server buffer without bound (#write drops it).
    for (const client of [...this.#clients]) this.#write(client, frame);
  }

  async #tickSystem(): Promise<void> {
    if (!this.#system || this.#systemInFlight || this.#clients.size === 0) return;
    this.#systemInFlight = true;
    try {
      const info = await this.#system.system();
      if (!this.#closed && this.#clients.size > 0) this.#broadcast({ name: 'system', payload: info });
    } catch (error) {
      this.#onError(error);
    } finally {
      this.#systemInFlight = false;
    }
  }
}
