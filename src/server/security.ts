import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isDeviceRequest } from './devices/mark.ts';

/**
 * Request guard for the loopback service (ARCHITECTURE → Security, decisions gap #20).
 * Details and the reasoning behind each rule: docs/security.md.
 */

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * `true` only for the UI page and its static files: they are served without
     * the `sb_token` cookie. Every other route (and every 404) needs the cookie.
     */
    public?: boolean;
  }
}

/** Name of the auth cookie. */
export const TOKEN_COOKIE = 'sb_token';

/** Host names that reach the service on 127.0.0.1. Compared case-insensitively. */
const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost']);

/** `Sec-Fetch-Site` values under which a page load may receive the cookie (gap #20). */
const COOKIE_FETCH_SITES: ReadonlySet<string> = new Set(['none', 'same-origin']);

/**
 * `true` when a `Host` header names this service: a loopback host name
 * (`127.0.0.1` or `localhost`) with exactly the service's port. Anything else,
 * a missing header included, is a DNS-rebinding or misrouted request.
 */
export function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const match = /^([^:[\]]+)(?::(\d{1,5}))?$/.exec(hostHeader.trim());
  if (!match) return false;
  const name = match[1]!.toLowerCase();
  const hostPort = match[2] === undefined ? 80 : Number(match[2]);
  return LOOPBACK_NAMES.has(name) && hostPort === port;
}

/**
 * `true` when an `Origin` header is this service's own origin
 * (`http://127.0.0.1:<port>` or `http://localhost:<port>`). `null` and every other
 * origin, other loopback ports included, are foreign.
 */
export function isAllowedOrigin(origin: string, port: number): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return false;
  const originPort = url.port === '' ? 80 : Number(url.port);
  return LOOPBACK_NAMES.has(url.hostname.toLowerCase()) && originPort === port;
}

/** All values of cookie `name` in a `Cookie` header, in header order. */
export function readCookieValues(header: string | undefined, name: string): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    values.push(value);
  }
  return values;
}

/** Constant-time comparison of a presented token with the install token. */
export function tokenMatches(candidate: string, token: string): boolean {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(token, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * `true` when the request carries the install token in an `sb_token` cookie.
 * Any matching value counts, so a stray cookie with the same name set by another
 * loopback app (cookies are not isolated by port) cannot lock the UI out.
 */
export function hasValidTokenCookie(request: FastifyRequest, token: string): boolean {
  return readCookieValues(request.headers.cookie, TOKEN_COOKIE).some((value) => tokenMatches(value, token));
}

/** `true` for `/api`, `/api/…`, `/hub` and `/hub/…`: always cookie-protected. */
export function isProtectedPath(url: string): boolean {
  const q = url.indexOf('?');
  const pathname = q < 0 ? url : url.slice(0, q);
  return pathname === '/api' || pathname.startsWith('/api/') || pathname === '/hub' || pathname.startsWith('/hub/');
}

/**
 * Gap #20: the UI page sets the cookie only when the browser says the load was not
 * initiated by another site (`Sec-Fetch-Site: none` for a typed URL, bookmark or
 * reload; `same-origin` for Switchboard's own links). A missing header gets no cookie.
 */
export function mayIssueCookie(request: FastifyRequest): boolean {
  const site = request.headers['sec-fetch-site'];
  return typeof site === 'string' && COOKIE_FETCH_SITES.has(site.trim().toLowerCase());
}

/** `Set-Cookie` value for the token: session cookie, HttpOnly, SameSite=Strict, whole site. */
export function serializeTokenCookie(token: string): string {
  return `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}

/** Options for {@link registerSecurity}. */
export interface SecurityOptions {
  /** The port the service listens on; Host and Origin must carry exactly this port. */
  readonly port: number;
  /** The per-install token. */
  readonly token: string;
  /**
   * D48 P4: the hook token (`<dataDir>/hook-token`, 0600). `/hook/*` takes only it,
   * as `Authorization: Bearer <token>` (never the cookie); without one `/hook/*`
   * is refused.
   */
  readonly hookToken?: string | null;
  /**
   * D68: checks a session's agent token: `/agent/*` takes only that, as `Authorization:
   * Bearer <token>` with the session named in `x-switchboard-session` (never the
   * cookie). Without it `/agent/*` is refused.
   */
  readonly agentTokenValid?: (sessionId: string, token: string) => boolean;
  /**
   * D73: the guard of requests that arrived on the **device listener**
   * (`DeviceService.guard`, `docs/devices.md`). Such a request never goes through
   * the loopback rules below (it comes from 127.0.0.1 through `tailscale serve`, so
   * loopback proves nothing): only this guard decides. Without one, every device
   * request is refused.
   */
  readonly deviceGuard?: (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>;
}

/** D68: `true` for `/agent` and `/agent/…` (the agent todo tools' endpoints, called by the `switchboard` MCP helper). */
export function isAgentPath(url: string): boolean {
  const q = url.indexOf('?');
  const pathname = q < 0 ? url : url.slice(0, q);
  return pathname === '/agent' || pathname.startsWith('/agent/');
}

/** D68: the bearer token of an `Authorization` header, `null` when there is none. */
export function bearerOf(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer (\S+)$/.exec(header.trim());
  return match ? (match[1] as string) : null;
}

/** D48 P4: `true` for `/hook` and `/hook/…` (the hook script's endpoints). */
export function isHookPath(url: string): boolean {
  const q = url.indexOf('?');
  const pathname = q < 0 ? url : url.slice(0, q);
  return pathname === '/hook' || pathname.startsWith('/hook/');
}

/** D48 P4: `true` when an `Authorization` header carries the hook token (constant time). */
export function hasHookToken(header: string | undefined, hookToken: string | null | undefined): boolean {
  if (!hookToken || typeof header !== 'string') return false;
  const match = /^Bearer (\S+)$/.exec(header.trim());
  return match !== null && tokenMatches(match[1] as string, hookToken);
}

function deny(reply: FastifyReply, status: 401 | 403, error: string): FastifyReply {
  return reply.code(status).header('cache-control', 'no-store').send({ error });
}

/**
 * Installs the guard as the first `onRequest` hook, for every route and every 404.
 * D73: a request that arrived on the device listener is judged by
 * {@link SecurityOptions.deviceGuard} only; everything below is the UI listener's:
 * 1. `Host` must be a loopback name with the service port → else 403 `forbidden-host`.
 *    D48 P4: `/hook/*` then needs no `Origin` (403) and the hook token as a bearer
 *    (401), never the cookie. D68: `/agent/*` likewise, with the agent token of the
 *    session named in `x-switchboard-session`.
 * 2. `Origin`, when present, must be the service's own origin → else 403 `forbidden-origin`.
 * 3. Unless the route is marked `config.public` (UI page, static files) and the path
 *    is not under `/api` or `/hub`, the `sb_token` cookie must match → else 401 `unauthorized`.
 */
export function registerSecurity(app: FastifyInstance, options: SecurityOptions): void {
  const { port, token } = options;
  // D73: the device a device-listener request authenticated as (`null` everywhere else).
  if (!app.hasRequestDecorator('device')) app.decorateRequest('device', null);
  app.addHook('onRequest', async (request, reply) => {
    // D73: the device listener has its own guard; loopback trust never applies to it.
    if (isDeviceRequest(request.raw)) return options.deviceGuard ? options.deviceGuard(request, reply) : deny(reply, 403, 'forbidden-host');
    if (!isAllowedHost(request.headers.host, port)) return deny(reply, 403, 'forbidden-host');
    const origin = request.headers.origin;
    // D48 P4: the hook script's endpoints: no browser (any Origin refused), only the hook token.
    if (isHookPath(request.url)) {
      if (origin !== undefined) return deny(reply, 403, 'forbidden-origin');
      if (!hasHookToken(request.headers.authorization, options.hookToken)) return deny(reply, 401, 'unauthorized');
      return undefined;
    }
    // D68: the agent todo tools' endpoints: no browser, only the session's own agent token.
    if (isAgentPath(request.url)) {
      if (origin !== undefined) return deny(reply, 403, 'forbidden-origin');
      const sessionId = request.headers['x-switchboard-session'];
      const bearer = bearerOf(request.headers.authorization);
      if (typeof sessionId !== 'string' || bearer === null || !options.agentTokenValid?.(sessionId, bearer)) return deny(reply, 401, 'unauthorized');
      return undefined;
    }
    if (origin !== undefined && !isAllowedOrigin(origin, port)) return deny(reply, 403, 'forbidden-origin');
    const isPublic = request.routeOptions.config?.public === true && !isProtectedPath(request.url);
    if (!isPublic && !hasValidTokenCookie(request, token)) return deny(reply, 401, 'unauthorized');
    return undefined;
  });
}
