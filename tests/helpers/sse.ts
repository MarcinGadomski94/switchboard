import http from 'node:http';
import type { FastifyInstance } from 'fastify';
import { listenLoopback } from '../../src/server/listen.ts';
import { freeTestPorts } from './net.ts';

/** One dispatched SSE message (a block ended by a blank line that had fields). */
export interface SseMessage {
  /** `event:` field (`message` when absent, as in the EventSource spec). */
  readonly event: string;
  /** `data:` lines joined with `\n`. */
  readonly data: string;
  /** How many `data:` lines the block had (the contract sends exactly one). */
  readonly dataLines: number;
  /** The block exactly as received, blank-line terminator included. */
  readonly raw: string;
  /** `Date.now()` when the block was complete. */
  readonly at: number;
}

/** A comment line (`: …`) with its arrival time. */
export interface SseComment {
  readonly text: string;
  readonly at: number;
}

/**
 * Incremental parser for the EventSource wire format (WHATWG HTML → Server-sent
 * events): lines end with LF, CR or CRLF; `:` starts a comment; `field: value`
 * with one optional space; a blank line dispatches.
 */
export class SseParser {
  readonly messages: SseMessage[] = [];
  readonly comments: SseComment[] = [];
  /** Fields other than event/data/id/retry, or malformed lines (the hub must send none). */
  readonly unexpected: string[] = [];
  #buffer = '';
  #event = '';
  #data: string[] = [];
  #raw = '';

  push(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.#buffer);
      if (!match) break;
      // A lone CR at the end may be the first half of CRLF: wait for more.
      if (match[0] === '\r' && match.index === this.#buffer.length - 1) break;
      const line = this.#buffer.slice(0, match.index);
      this.#raw += this.#buffer.slice(0, match.index + match[0].length);
      this.#buffer = this.#buffer.slice(match.index + match[0].length);
      this.#line(line);
    }
  }

  #line(line: string): void {
    if (line === '') {
      if (this.#data.length > 0 || this.#event !== '') {
        this.messages.push({ event: this.#event || 'message', data: this.#data.join('\n'), dataLines: this.#data.length, raw: this.#raw, at: Date.now() });
      }
      this.#event = '';
      this.#data = [];
      this.#raw = '';
      return;
    }
    if (line.startsWith(':')) {
      this.comments.push({ text: line.slice(1).replace(/^ /, ''), at: Date.now() });
      this.#raw = '';
      return;
    }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') this.#event = value;
    else if (field === 'data') this.#data.push(value);
    else this.unexpected.push(line);
  }
}

/** An open `/hub` stream over a real socket. */
export interface HubStream {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly parser: SseParser;
  /** Every body byte so far (utf8). */
  body(): string;
  /** Messages named `event` so far, payloads parsed. */
  payloads<T = unknown>(event: string): T[];
  /** Resolves once `check` returns a value (not `undefined`/`false`), or throws after `timeoutMs`. */
  waitFor<T>(check: (parser: SseParser) => T | undefined | false, what: string, timeoutMs?: number): Promise<T>;
  /** Resolves when the server ended the stream cleanly (`end`), `aborted` when the socket broke. */
  readonly ended: Promise<'end' | 'aborted'>;
  /** Closes the connection from the client side. */
  close(): void;
}

/** Options for {@link openHub}. */
export interface OpenHubOptions {
  readonly port: number;
  readonly cookie?: string;
  readonly headers?: Record<string, string>;
  readonly path?: string;
}

/** Opens `GET /hub` like a browser's EventSource (Accept: text/event-stream) and resolves on the response head. */
export function openHub(options: OpenHubOptions): Promise<HubStream> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: options.port,
        path: options.path ?? '/hub',
        method: 'GET',
        agent: false,
        headers: {
          accept: 'text/event-stream',
          'cache-control': 'no-cache',
          ...(options.cookie ? { cookie: options.cookie } : {}),
          ...options.headers,
        },
      },
      (res) => {
        const parser = new SseParser();
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          parser.push(chunk);
        });
        const ended = new Promise<'end' | 'aborted'>((done) => {
          res.once('end', () => done('end'));
          res.once('close', () => done(res.complete ? 'end' : 'aborted'));
          res.once('error', () => done('aborted'));
        });
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          parser,
          body: () => body,
          payloads: <T>(event: string) => parser.messages.filter((m) => m.event === event).map((m) => JSON.parse(m.data) as T),
          async waitFor<T>(check: (p: SseParser) => T | undefined | false, what: string, timeoutMs = 10_000): Promise<T> {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
              const value = check(parser);
              if (value !== undefined && value !== false) return value;
              if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; received:\n${body}`);
              await new Promise((r) => setTimeout(r, 20));
            }
          },
          ended,
          close: () => {
            req.destroy();
          },
        });
      },
    );
    req.once('error', reject);
    req.end();
  });
}

/** A JSON response over a real socket. */
export interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

/** An HTTP request with an optional JSON body to 127.0.0.1:`port`; the Host header is the loopback one. */
export function requestJson(port: number, method: string, path: string, cookie: string, body?: unknown): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        agent: false,
        headers: { cookie, ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }) },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text === '' ? null : (JSON.parse(text) as unknown) }));
      },
    );
    req.once('error', reject);
    req.end(payload);
  });
}

/**
 * Builds an app for each free test port (4871–4879; the port feeds the Host
 * check) and listens on the first that binds, retrying when a parallel test took it.
 */
export async function listenOnFreeTestPort(build: (port: number) => Promise<FastifyInstance>): Promise<{ app: FastifyInstance; port: number }> {
  for (const port of await freeTestPorts()) {
    const app = await build(port);
    try {
      await listenLoopback(app, { port });
      return { app, port };
    } catch (error) {
      await app.close();
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('no free test port in 4871-4879');
}
