import http from 'node:http';
import https from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { LOOPBACK_HOST } from '../config.ts';
import { TOKEN_COOKIE, isAllowedHost } from '../security.ts';
import { withFrameAncestors } from './framing.ts';

/**
 * The framing proxy of one embedded tool (D15, `docs/tools.md` → *Framing proxy*,
 * `docs/security.md` → *Tool framing proxies*): a reverse proxy on its own
 * loopback port that forwards everything to the tool's origin, so the Tool view's
 * iframe can show a tool that refuses to be framed (Codebase Memory answers
 * `frame-ancestors 'none'`). Requests and answers pass unchanged, bodies streamed
 * both ways, WebSocket upgrades piped, with these exceptions only:
 * - a request whose `Host` is not this proxy (`127.0.0.1:<port>` / `localhost:<port>`)
 *   is refused with 403 (DNS rebinding), one whose target is not a path with 400;
 * - the forwarded request's `Host` is the tool's, and Switchboard's `sb_token` is
 *   removed from its `Cookie` (cookies ignore ports, so the browser sends it here);
 * - the answer loses `X-Frame-Options`; every `Content-Security-Policy` gets
 *   `frame-ancestors` = Switchboard's origins (added as its own header when the
 *   tool sends none, so no other site can frame the tool through the proxy);
 * - a `Location` pointing at the tool's origin is rewritten to the proxy's;
 * - connection-level (hop-by-hop) headers are the proxy's own, as HTTP requires.
 * It only ever connects to the configured tool URL's host and port. An upstream
 * failure is a 502 with a short text.
 */

/** Options for {@link startToolProxy}. */
export interface ToolProxyOptions {
  /** The tool's saved URL (`http:` / `https:`, `tools/validate.ts`); its origin is the only upstream. */
  readonly target: string;
  /** The origins `frame-ancestors` is set to: Switchboard's own (`framing.ts` → `switchboardOrigins`). */
  readonly frameOrigins: readonly string[];
  /** Port to listen on; `0` (the default) lets the OS pick a free one. Always on 127.0.0.1. */
  readonly port?: number;
}

/** A running framing proxy. */
export interface ToolProxy {
  /** The tool URL it forwards to. */
  readonly target: string;
  /** The port it listens on (127.0.0.1). */
  readonly port: number;
  /**
   * The URL the iframe loads: the proxy's origin on `hostname` (`127.0.0.1`, the
   * default, or `localhost`, matching the page) + the tool URL's path, query and hash.
   */
  frameUrl(hostname?: string): string;
  /** Stops listening and drops every open connection (upstream ones and WebSockets too). */
  close(): Promise<void>;
}

/** Hop-by-hop headers (RFC 9110 §7.6.1): they describe one connection, never forwarded. */
const HOP_BY_HOP: ReadonlySet<string> = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'http2-settings']);

/** The host names the proxy answers to; anything else in `Host` is refused. */
function proxyHostname(hostHeader: string | undefined): string {
  return /^localhost(?::|$)/i.test(hostHeader?.trim() ?? '') ? 'localhost' : LOOPBACK_HOST;
}

/** The `Cookie` header without any `sb_token` pair; `undefined` when nothing is left. */
export function stripTokenCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const kept = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      if (part === '') return false;
      const eq = part.indexOf('=');
      return (eq < 0 ? part : part.slice(0, eq)).trim() !== TOKEN_COOKIE;
    });
  return kept.length > 0 ? kept.join('; ') : undefined;
}

/** Connection-level headers named in a `Connection` header (they are hop-by-hop too). */
function connectionTokens(value: string | string[] | undefined): Set<string> {
  const text = Array.isArray(value) ? value.join(',') : (value ?? '');
  return new Set(
    text
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * The request headers sent to the tool: every header of `req` except hop-by-hop
 * ones (an upgrade keeps `Connection: Upgrade` + `Upgrade`), `Host` = the tool's
 * host, and `Cookie` without `sb_token`.
 */
function upstreamRequestHeaders(req: http.IncomingMessage, target: URL, upgrade: boolean): http.OutgoingHttpHeaders {
  const named = connectionTokens(req.headers.connection);
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name === 'host' || name === 'cookie') continue;
    if (HOP_BY_HOP.has(name) || named.has(name)) continue;
    headers[name] = value;
  }
  headers['host'] = target.host;
  const cookie = stripTokenCookie(req.headers.cookie);
  if (cookie !== undefined) headers['cookie'] = cookie;
  if (upgrade) {
    headers['connection'] = 'Upgrade';
    if (req.headers.upgrade !== undefined) headers['upgrade'] = req.headers.upgrade;
  }
  return headers;
}

/** `location` rewritten to the proxy when it is absolute (or scheme-relative) and points at the tool's origin. */
export function rewriteLocation(location: string, target: URL, proxyOrigin: string): string {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(location) && !location.startsWith('//')) return location;
  let url: URL;
  try {
    url = new URL(location, target);
  } catch {
    return location;
  }
  if (url.origin !== target.origin) return location;
  return `${proxyOrigin}${url.pathname}${url.search}${url.hash}`;
}

/**
 * The answer's headers as the browser gets them (flat `[name, value, …]` list,
 * duplicates and case kept): hop-by-hop headers and `X-Frame-Options` dropped,
 * every `Content-Security-Policy` with `frame-ancestors` = `frameOrigins` (one added
 * when there is none), `Location` at the tool rewritten to `proxyOrigin`.
 */
export function proxiedResponseHeaders(rawHeaders: readonly string[], target: URL, proxyOrigin: string, frameOrigins: readonly string[]): string[] {
  const named = new Set<string>();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i]!.toLowerCase() === 'connection') for (const token of connectionTokens(rawHeaders[i + 1])) named.add(token);
  }
  const out: string[] = [];
  let hasCsp = false;
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!;
    let value = rawHeaders[i + 1]!;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || named.has(lower) || lower === 'x-frame-options') continue;
    if (lower === 'content-security-policy') {
      hasCsp = true;
      value = withFrameAncestors(value, frameOrigins);
    } else if (lower === 'location') {
      value = rewriteLocation(value, target, proxyOrigin);
    }
    out.push(name, value);
  }
  if (!hasCsp) out.push('Content-Security-Policy', withFrameAncestors('', frameOrigins));
  return out;
}

/** A raw HTTP/1.1 answer head for a socket (upgrades, which bypass `ServerResponse`). */
function rawHead(statusCode: number, statusMessage: string, headers: readonly string[]): string {
  let head = `HTTP/1.1 ${statusCode} ${statusMessage}\r\n`;
  for (let i = 0; i + 1 < headers.length; i += 2) head += `${headers[i]}: ${headers[i + 1]}\r\n`;
  return `${head}\r\n`;
}

/** Ends an upgrade socket with a short plain-text answer. */
function refuseSocket(socket: Duplex, statusCode: number, text: string): void {
  if (socket.destroyed) return;
  const body = `${text}\n`;
  socket.end(
    rawHead(statusCode, http.STATUS_CODES[statusCode] ?? '', ['Content-Type', 'text/plain; charset=utf-8', 'Content-Length', String(Buffer.byteLength(body)), 'Connection', 'close']) + body,
  );
}

/** Sends a short plain-text answer on an HTTP response (403, 400, 502). */
function refuse(res: http.ServerResponse, statusCode: number, text: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`${text}\n`);
}

/**
 * Starts the framing proxy for `options.target` on 127.0.0.1 (an OS-assigned port
 * unless `port` is given) and resolves once it listens.
 * @throws when the URL is not `http:` / `https:` or the socket cannot be bound.
 */
export async function startToolProxy(options: ToolProxyOptions): Promise<ToolProxy> {
  const target = new URL(options.target);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error(`a tool URL must be http(s), got ${target.protocol}`);
  const transport = target.protocol === 'https:' ? https : http;
  const upstreamHost = target.hostname.replace(/^\[(.*)\]$/, '$1');
  const upstreamPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  // Keep-alive to the tool, owned by this proxy so close() also ends those sockets.
  const agent = new transport.Agent({ keepAlive: true });
  const sockets = new Set<Duplex>();
  const track = (socket: Duplex): void => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  let port = 0;
  const unreachable = (error: unknown): string => {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return `Switchboard's tool proxy could not reach ${target.host}${code ? ` (${code})` : ''}`;
  };

  const server = http.createServer((req, res) => {
    if (!isAllowedHost(req.headers.host, port)) return refuse(res, 403, 'forbidden host');
    const path = req.url ?? '';
    if (!path.startsWith('/')) return refuse(res, 400, 'bad request target');
    const proxyOrigin = `http://${proxyHostname(req.headers.host)}:${port}`;
    const upstream = transport.request({
      host: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path,
      headers: upstreamRequestHeaders(req, target, false),
      agent,
      ...(target.protocol === 'https:' ? { servername: upstreamHost } : {}),
    });
    upstream.on('response', (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage || undefined, proxiedResponseHeaders(answer.rawHeaders, target, proxyOrigin, options.frameOrigins));
      answer.on('error', () => res.destroy());
      answer.pipe(res);
    });
    upstream.on('error', (error) => refuse(res, 502, unreachable(error)));
    // The browser went away (navigated, reloaded): stop the upstream request too.
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on('connection', track);

  // WebSocket (any HTTP upgrade): the same checks, then the two sockets piped together.
  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    if (!isAllowedHost(req.headers.host, port)) return refuseSocket(socket, 403, 'forbidden host');
    const path = req.url ?? '';
    if (!path.startsWith('/')) return refuseSocket(socket, 400, 'bad request target');
    const proxyOrigin = `http://${proxyHostname(req.headers.host)}:${port}`;
    const upstream = transport.request({
      host: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path,
      headers: upstreamRequestHeaders(req, target, true),
      agent: false,
      ...(target.protocol === 'https:' ? { servername: upstreamHost } : {}),
    });
    socket.on('close', () => upstream.destroy());
    upstream.on('upgrade', (answer, upstreamSocket: Socket, upstreamHead: Buffer) => {
      track(upstreamSocket);
      upstreamSocket.on('error', () => socket.destroy());
      socket.on('error', () => upstreamSocket.destroy());
      upstreamSocket.on('close', () => socket.destroy());
      socket.on('close', () => upstreamSocket.destroy());
      if (socket.destroyed) {
        upstreamSocket.destroy();
        return;
      }
      upstreamSocket.setNoDelay(true);
      if (upstreamHead.length > 0) upstreamSocket.unshift(upstreamHead);
      if (head.length > 0) socket.unshift(head);
      socket.write(rawHead(answer.statusCode ?? 101, answer.statusMessage ?? 'Switching Protocols', answer.rawHeaders));
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    // The tool answered without upgrading: pass its answer on and close.
    // The body is already de-chunked (Transfer-Encoding is dropped as hop-by-hop), so the end of the connection ends it.
    upstream.on('response', (answer) => {
      const headers = proxiedResponseHeaders(answer.rawHeaders, target, proxyOrigin, options.frameOrigins);
      socket.write(rawHead(answer.statusCode ?? 502, answer.statusMessage ?? '', [...headers, 'Connection', 'close']));
      answer.pipe(socket);
    });
    upstream.on('error', (error) => refuseSocket(socket, 502, unreachable(error)));
    upstream.end();
  });

  // CONNECT (forward-proxy tunnels) is never served: Node closes those connections when no 'connect' listener exists.

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: LOOPBACK_HOST, port: options.port ?? 0 }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address || address.address !== LOOPBACK_HOST) {
    server.close();
    throw new Error(`the tool proxy bound an unexpected address ${JSON.stringify(address)}`);
  }
  port = address.port;
  server.on('error', () => undefined);

  let closing: Promise<void> | null = null;
  return {
    target: options.target,
    port,
    frameUrl(hostname = LOOPBACK_HOST): string {
      const host = hostname.toLowerCase() === 'localhost' ? 'localhost' : LOOPBACK_HOST;
      return `http://${host}:${port}${target.pathname}${target.search}${target.hash}`;
    },
    close(): Promise<void> {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        agent.destroy();
      });
      return closing;
    },
  };
}
