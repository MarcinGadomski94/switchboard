import http from 'node:http';
import type { Socket } from 'node:net';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DEFAULT_DEVICE_HTTPS_PORT,
  DEFAULT_DEVICE_PORT,
  DEFAULT_PUSH_EVENTS,
  DEVICE_CODE_MAX_FAILURES,
  DEVICE_CODE_TTL_MS,
  DEVICE_PAIR_MAX_ATTEMPTS,
  DEVICE_PAIR_WINDOW_MS,
  type Device,
  type DeviceAccessInput,
  type DeviceAccessState,
  type DeviceHttpsState,
  type DevicePairingCode,
  type DeviceSelfView,
  type DevicesView,
  type PushEvents,
  type PushPayload,
  SERVE_HTTPS_PORTS,
  cleanDeviceName,
  deviceNameFromUserAgent,
  mergePushEvents,
  readPushEvents,
} from '../../core/devices.ts';
import { isPort, normalizePairingCode } from '../../core/peers.ts';
import { LOOPBACK_HOST, type ServerConfig } from '../config.ts';
import type { DeviceRecord } from '../db/repos/devices.ts';
import type { Store } from '../db/store.ts';
import type { HubBus } from '../hub/bus.ts';
import { listInbox } from '../inbox/wire.ts';
import { BindRefusedError, assertLoopbackBind } from '../listen.ts';
import { hashPeerToken, hashesMatch, newPairingCode } from '../peers/tokens.ts';
import { isAgentPath, isHookPath, isProtectedPath } from '../security.ts';
import { APP_FILES, APP_ICONS_PREFIX } from '../web.ts';
import {
  clearDeviceCookie,
  deviceSecretMatches,
  hashDeviceSecret,
  newDeviceId,
  newDeviceSecret,
  readDeviceCookies,
  serializeDeviceCookie,
} from './credentials.ts';
import { isLocalOnly } from './local-only.ts';
import { isDeviceRequest, markDeviceRequest } from './mark.ts';
import { type VapidKeys, generateVapidKeys, validVapidKeys } from './push/crypto.ts';
import { type PushNotice, PushNotifier } from './push/notifier.ts';
import { type PushOutcome, sendPush, validSubscription } from './push/sender.ts';
import { type TailscaleCallOptions, isTailscaleFailure, serveOff, serveOn, serveStatus, servedByOther, tailscaleStatus } from './tailscale-serve.ts';

/**
 * D73 "Devices" (`docs/devices.md`, `docs/security.md` → *Device listener*): the
 * phones and tablets paired with this Switchboard and the way they reach it.
 *
 * - **Transport:** a second listener dedicated to devices, on **loopback**
 *   (`127.0.0.1:<port>`, default 13003), published to the tailnet over HTTPS by
 *   `tailscale serve --bg --https=<httpsPort> http://127.0.0.1:<port>` (a real
 *   `*.ts.net` certificate: a secure context, so the app installs and web push
 *   works). Off by default. Every request on it arrives from 127.0.0.1, so
 *   nothing on it trusts loopback: it serves the same app as the UI listener, but
 *   through its own guard ({@link guard}).
 * - **Pairing:** a one-time code (10 minutes, single use, burned after 5 wrong
 *   tries, at most 10 tries per 10 minutes) shown as a QR code on this machine;
 *   the device trades it for a long-lived credential (an HttpOnly, Secure,
 *   SameSite=Strict `__Host-` cookie; only its hash is stored).
 * - **Revoking** deletes the device and destroys its open connections (its `/hub`
 *   stream ends at once).
 * - **Push:** VAPID keys (`<dataDir>/vapid.json`, 0600) and each device's
 *   subscription; {@link PushNotifier} picks the happenings.
 *
 * The UI listener (13001) is untouched by all of this.
 */

/** Settings key of the device access switch. */
export const DEVICE_ACCESS_SETTING = 'devices.access';

/** Settings key of what Switchboard told `tailscale serve` (so it only ever turns off its own). */
export const DEVICE_SERVE_SETTING = 'devices.serve';

/** The VAPID key file in the data folder (0600). */
export const VAPID_FILE = 'vapid.json';

/** A device's `last_seen_at` is written at most this often. */
const SEEN_EVERY_MS = 60_000;

/** Body limit of the pairing exchange. */
export const PAIR_BODY_LIMIT = 4 * 1024;

declare module 'fastify' {
  interface FastifyRequest {
    /** D73: the paired device a device-listener request authenticated as (`null`: none / not a device request). */
    device: DeviceRecord | null;
  }
}

/** A refusal with an HTTP status and an error code, sent as `{ error, message }`. */
export class DeviceError extends Error {
  override name = 'DeviceError';
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The stored access switch. */
interface AccessSetting {
  readonly enabled: boolean;
  readonly port: number;
  readonly httpsPort: number;
}

/** What Switchboard set up with `tailscale serve`. */
interface ServeSetting {
  readonly httpsPort: number;
  readonly target: string;
}

/** Options of {@link DeviceService}. */
export interface DeviceServiceOptions {
  readonly config: ServerConfig;
  readonly store: Store;
  readonly bus: HubBus;
  /** This machine's name (the pairing page; default: "this computer"). */
  readonly machineName?: () => Promise<string>;
  /** Epoch ms (tests pass a fake clock). */
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
  /** Replaces `fetch` for push deliveries (tests). */
  readonly fetch?: typeof fetch;
}

/** A device the guard authenticated, with the presented secret (to refresh the cookie). */
interface Authenticated {
  readonly record: DeviceRecord;
  readonly secret: string;
}

function deny(reply: FastifyReply, status: number, error: string, message?: string): FastifyReply {
  return reply
    .code(status)
    .header('cache-control', 'no-store')
    .send(message ? { error, message } : { error });
}

function pathnameOf(url: string): string {
  const cut = url.indexOf('?');
  return cut < 0 ? url : url.slice(0, cut);
}

/** `true` for a request an unpaired device may make: the pairing page and exchange, and the installable-app files. */
function isPairingPublic(method: string, url: string): boolean {
  const pathname = pathnameOf(url);
  if ((method === 'GET' || method === 'HEAD') && (pathname === '/pair' || APP_FILES.some((file) => file.path === pathname) || pathname.startsWith(APP_ICONS_PREFIX))) return true;
  return method === 'POST' && pathname === '/device/v1/pair';
}

/** A browser page load (not the API, the hub or a file). */
function isNavigation(request: FastifyRequest): boolean {
  if (request.method !== 'GET') return false;
  const pathname = pathnameOf(request.url);
  if (isProtectedPath(request.url) || pathname.startsWith('/device/')) return false;
  const last = pathname.split('/').pop() ?? '';
  if (last.includes('.')) return false;
  const accept = request.headers.accept ?? '';
  return accept.includes('text/html');
}

/** The D73 service. */
export class DeviceService {
  readonly #config: ServerConfig;
  readonly #store: Store;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  readonly #machineName: () => Promise<string>;
  readonly #fetch: typeof fetch | undefined;
  readonly #notifier: PushNotifier;
  #app: FastifyInstance | null = null;
  #server: http.Server | null = null;
  #listening: string | null = null;
  #origin: string | null = null;
  #https: DeviceHttpsState = 'off';
  #message: string | null = null;
  #actionUrl: string | null = null;
  #change: Promise<void> = Promise.resolve();
  #started = false;
  #closed = false;
  #vapid: Promise<VapidKeys> | null = null;
  readonly #sockets = new Set<Socket>();
  readonly #deviceSockets = new Map<string, Set<Socket>>();
  readonly #seen = new Map<string, number>();
  readonly #attempts: number[] = [];

  constructor(options: DeviceServiceOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? ((error) => console.error('switchboard devices:', error));
    this.#machineName = options.machineName ?? (async () => 'this computer');
    this.#fetch = options.fetch;
    this.#notifier = new PushNotifier({
      bus: options.bus,
      inbox: () => listInbox(this.#store),
      deliver: (notice) => this.deliver(notice),
      onError: (error) => this.#onError(error),
    });
  }

  /** The app the device listener hands its requests to (set once it is built). */
  useApp(app: FastifyInstance): void {
    this.#app = app;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  /** Starts device access (when switched on) and the push notifier. Called once the UI port is ours. */
  async start(): Promise<void> {
    if (this.#started || this.#closed) return;
    this.#started = true;
    await this.#notifier.start();
    await this.#apply();
  }

  /** Stops the device listener (its connections dropped) and the notifier; `tailscale serve` is left as configured. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#change.catch(() => undefined);
    await this.#notifier.stop();
    await this.#stopListener();
  }

  /** Resolves once the push notifier has handled what it heard (tests). */
  notifierIdle(): Promise<void> {
    return this.#notifier.idle();
  }

  // ── access ────────────────────────────────────────────────────────────

  async #accessSetting(): Promise<AccessSetting> {
    const stored = (await this.#store.settings.get(DEVICE_ACCESS_SETTING)) as Partial<AccessSetting> | undefined;
    return {
      enabled: stored?.enabled === true,
      port: isPort(stored?.port) ? stored.port : DEFAULT_DEVICE_PORT,
      httpsPort: typeof stored?.httpsPort === 'number' && SERVE_HTTPS_PORTS.includes(stored.httpsPort) ? stored.httpsPort : DEFAULT_DEVICE_HTTPS_PORT,
    };
  }

  /** The switch and what it does now. */
  async accessState(): Promise<DeviceAccessState> {
    const setting = await this.#accessSetting();
    return {
      enabled: setting.enabled,
      port: setting.port,
      httpsPort: setting.httpsPort,
      listening: this.#listening,
      origin: this.#origin,
      https: setting.enabled ? this.#https : 'off',
      message: setting.enabled ? this.#message : null,
      actionUrl: setting.enabled ? this.#actionUrl : null,
    };
  }

  /** `PUT /api/devices/access`: saves the switch and applies it when the service runs. */
  async setAccess(input: unknown): Promise<DeviceAccessState> {
    const body = (typeof input === 'object' && input !== null && !Array.isArray(input) ? input : null) as DeviceAccessInput | null;
    if (!body) throw new DeviceError(422, 'invalid', 'the body must be { enabled?, port?, httpsPort? }');
    const next: { enabled: boolean; port: number; httpsPort: number } = { ...(await this.#accessSetting()) };
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw new DeviceError(422, 'invalid', 'enabled must be true or false');
      next.enabled = body.enabled;
    }
    if (body.port !== undefined) {
      if (!isPort(body.port) || body.port === this.#config.port) throw new DeviceError(422, 'invalid', `the port must be 1–65535 and not the UI's port ${this.#config.port}`);
      next.port = body.port;
    }
    if (body.httpsPort !== undefined) {
      if (typeof body.httpsPort !== 'number' || !SERVE_HTTPS_PORTS.includes(body.httpsPort)) throw new DeviceError(422, 'invalid', `the HTTPS port must be one of ${SERVE_HTTPS_PORTS.join(', ')} (what tailscale serve allows)`);
      next.httpsPort = body.httpsPort;
    }
    await this.#store.settings.set(DEVICE_ACCESS_SETTING, next);
    if (this.#started && !this.#closed) await this.#apply();
    return this.accessState();
  }

  #tailscale(): TailscaleCallOptions {
    return { command: this.#config.tailscaleCommand, cwd: this.#config.dataDir };
  }

  /** Starts or stops device access to match the switch; serialized. */
  #apply(): Promise<void> {
    const run = this.#change.catch(() => undefined).then(() => this.#applyNow());
    this.#change = run.catch((error: unknown) => this.#onError(error));
    return this.#change;
  }

  #setState(https: DeviceHttpsState, message: string | null = null, actionUrl: string | null = null): void {
    this.#https = https;
    this.#message = message;
    this.#actionUrl = actionUrl;
  }

  async #applyNow(): Promise<void> {
    const setting = await this.#accessSetting();
    await this.#stopListener();
    this.#origin = null;
    const served = (await this.#store.settings.get(DEVICE_SERVE_SETTING)) as ServeSetting | undefined;
    const target = `http://${LOOPBACK_HOST}:${setting.port}`;
    // What Switchboard served before and serves no longer (switched off, or another port): turn off its own only.
    if (served && (!setting.enabled || served.httpsPort !== setting.httpsPort || served.target !== target)) {
      const failure = await serveOff(this.#tailscale(), served.httpsPort);
      if (failure) this.#onError(new Error(failure.message));
      await this.#store.settings.set(DEVICE_SERVE_SETTING, null);
    }
    if (!setting.enabled || this.#closed) {
      this.#setState('off');
      return;
    }
    const status = await tailscaleStatus(this.#tailscale());
    if (isTailscaleFailure(status)) {
      this.#setState('no-tailscale', `Tailscale could not be asked: is it installed, running and signed in? (${status.message})`, status.actionUrl);
      return;
    }
    if (status.backendState !== null && status.backendState !== 'Running') {
      this.#setState('no-tailscale', `Tailscale is not connected (state: ${status.backendState}). Start it and sign in.`);
      return;
    }
    if (!status.dnsName || !status.magicDns) {
      this.#setState('no-https', 'Turn on MagicDNS for your tailnet (Tailscale admin console → DNS), then switch device access off and on.');
      return;
    }
    if (!status.certDomains.includes(status.dnsName)) {
      this.#setState('no-https', 'Turn on HTTPS certificates for your tailnet (Tailscale admin console → DNS → HTTPS Certificates), then switch device access off and on. Phones need HTTPS to install the app and get notifications.');
      return;
    }
    try {
      await this.#startListener(setting.port);
    } catch (error) {
      this.#setState('serve-failed', `The device listener could not start on ${LOOPBACK_HOST}:${setting.port}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const current = await serveStatus(this.#tailscale());
    if (current !== null && servedByOther(current, setting.httpsPort, target)) {
      await this.#stopListener();
      this.#setState('port-busy', `HTTPS port ${setting.httpsPort} of this machine is already served by something else (tailscale serve status). Pick another HTTPS port or free it.`);
      return;
    }
    const failure = await serveOn(this.#tailscale(), setting.httpsPort, target);
    if (failure) {
      await this.#stopListener();
      this.#setState('serve-failed', failure.message, failure.actionUrl);
      return;
    }
    await this.#store.settings.set(DEVICE_SERVE_SETTING, { httpsPort: setting.httpsPort, target } satisfies ServeSetting);
    this.#origin = this.#config.deviceTestOrigin ?? `https://${status.dnsName}${setting.httpsPort === 443 ? '' : `:${setting.httpsPort}`}`;
    this.#setState('ok');
  }

  async #startListener(port: number): Promise<void> {
    const app = this.#app;
    if (!app) throw new Error('the app is not ready');
    assertLoopbackBind(LOOPBACK_HOST);
    const server = http.createServer((req, res) => {
      markDeviceRequest(req);
      app.routing(req, res);
    });
    server.on('connection', (socket: Socket) => {
      this.#sockets.add(socket);
      socket.once('close', () => this.#sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: LOOPBACK_HOST, port, exclusive: true }, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string' || address.address !== LOOPBACK_HOST) {
      server.close();
      throw new BindRefusedError(`the device listener bound an unexpected address ${JSON.stringify(address)}`);
    }
    server.on('error', (error) => this.#onError(error));
    this.#server = server;
    this.#listening = `${LOOPBACK_HOST}:${address.port}`;
  }

  async #stopListener(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#listening = null;
    if (!server) return;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    this.#deviceSockets.clear();
    await closed;
  }

  // ── host / origin ─────────────────────────────────────────────────────

  /** The `Host` values the devices' origin may arrive with. */
  #hosts(): string[] {
    if (!this.#origin) return [];
    const url = new URL(this.#origin);
    const hosts = [url.host.toLowerCase()];
    if (url.port === '') hosts.push(`${url.hostname.toLowerCase()}:${url.protocol === 'https:' ? 443 : 80}`);
    return hosts;
  }

  /**
   * `true` when the request names the devices' origin: `Host` is it (`tailscale
   * serve` keeps the browser's Host), or `Host` is the loopback listener itself and
   * `X-Forwarded-Host` (which `tailscale serve` sets) names it.
   */
  hostAllowed(host: string | undefined, forwardedHost: string | string[] | undefined): boolean {
    const hosts = this.#hosts();
    if (hosts.length === 0 || typeof host !== 'string') return false;
    const name = host.trim().toLowerCase();
    if (hosts.includes(name)) return true;
    if (this.#listening && name === this.#listening && typeof forwardedHost === 'string') return hosts.includes(forwardedHost.trim().toLowerCase());
    return false;
  }

  /** `true` when an `Origin` header is the devices' origin. */
  originAllowed(origin: string): boolean {
    if (!this.#origin) return false;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return false;
    return url.origin === new URL(this.#origin).origin;
  }

  /** The devices' origin while device access is on, else `null`. */
  get origin(): string | null {
    return this.#origin;
  }

  // ── the guard ─────────────────────────────────────────────────────────

  /**
   * The device listener's request guard (installed by `registerSecurity` as the
   * first check of every request that arrived on the device listener):
   * 1. `Host` must name the devices' origin → else 403 `forbidden-host`;
   * 2. `/hook/*` and `/agent/*` are never served here → 403 `forbidden`;
   * 3. `Origin`, when present, must be the devices' origin → else 403 `forbidden-origin`;
   * 4. the device credential (cookie) is checked; the pairing page, the pairing
   *    exchange and the installable-app files are served without one; any other
   *    page load goes to `/pair` (302), anything else is 401 `unauthorized`;
   * 5. a paired device is refused the local-only routes → 403 `local-only`.
   * Loopback is never trusted here: every request on this listener comes from 127.0.0.1.
   */
  async guard(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    request.device = null;
    if (!this.hostAllowed(request.headers.host, request.headers['x-forwarded-host'])) return deny(reply, 403, 'forbidden-host');
    if (isHookPath(request.url) || isAgentPath(request.url)) return deny(reply, 403, 'forbidden');
    const origin = request.headers.origin;
    if (origin !== undefined && !this.originAllowed(origin)) return deny(reply, 403, 'forbidden-origin');
    const found = await this.authenticate(request);
    if (!found) {
      if (isPairingPublic(request.method, request.url)) return undefined;
      if (isNavigation(request)) {
        if (readDeviceCookies(request.headers.cookie).length > 0) reply.header('set-cookie', clearDeviceCookie());
        return reply.code(302).header('location', '/pair').header('cache-control', 'no-store').send();
      }
      return deny(reply, 401, 'unauthorized');
    }
    if (isLocalOnly(request.method, request.url)) {
      return deny(reply, 403, 'local-only', 'This needs Switchboard on its own computer: a paired device cannot do it (docs/devices.md → What a device may not do).');
    }
    request.device = found.record;
    this.#track(found.record.id, request.raw.socket);
    this.#markSeen(found.record.id);
    // Page loads keep the credential alive (its Max-Age starts again).
    if (isNavigation(request)) reply.header('set-cookie', serializeDeviceCookie(found.record.id, found.secret));
    return undefined;
  }

  /** The paired device a request's cookie names (constant-time secret check; the Tailscale login when one was recorded). */
  async authenticate(request: FastifyRequest): Promise<Authenticated | null> {
    for (const { id, secret } of readDeviceCookies(request.headers.cookie)) {
      const record = await this.#store.devices.get(id);
      if (!record || !deviceSecretMatches(secret, record.credentialHash)) continue;
      if (record.tailscaleLogin !== null && request.headers['tailscale-user-login'] !== record.tailscaleLogin) continue;
      return { record, secret };
    }
    return null;
  }

  #track(deviceId: string, socket: Socket | null | undefined): void {
    if (!socket || socket.destroyed) return;
    let set = this.#deviceSockets.get(deviceId);
    if (!set) {
      set = new Set();
      this.#deviceSockets.set(deviceId, set);
    }
    if (set.has(socket)) return;
    set.add(socket);
    socket.once('close', () => set.delete(socket));
  }

  #markSeen(deviceId: string): void {
    const last = this.#seen.get(deviceId) ?? 0;
    const now = this.#now();
    if (now - last < SEEN_EVERY_MS) return;
    this.#seen.set(deviceId, now);
    this.#store.devices.touch(deviceId).catch((error: unknown) => this.#onError(error));
  }

  // ── devices ───────────────────────────────────────────────────────────

  async #toDevice(record: DeviceRecord): Promise<Device> {
    return {
      id: record.id,
      name: record.name,
      userAgent: record.userAgent,
      pairedAt: record.pairedAt,
      lastSeenAt: record.lastSeenAt,
      push: (await this.#store.devices.push(record.id)) !== null,
    };
  }

  /** `GET /api/devices`. */
  async view(): Promise<DevicesView> {
    const devices: Device[] = [];
    for (const record of await this.#store.devices.list()) devices.push(await this.#toDevice(record));
    return { access: await this.accessState(), devices };
  }

  /** Renames a device (`PUT /api/devices/{id}`, or the device itself). */
  async rename(id: string, name: unknown): Promise<Device> {
    const clean = cleanDeviceName(name);
    if (!clean) throw new DeviceError(422, 'invalid', 'the name must be 1–40 characters');
    const record = await this.#store.devices.rename(id, clean);
    if (!record) throw new DeviceError(404, 'not-found', 'no such device');
    return this.#toDevice(record);
  }

  /** Revokes a device: its credential stops working now and its open connections (the `/hub` stream) are closed. */
  async revoke(id: string): Promise<void> {
    const removed = await this.#store.devices.delete(id);
    if (!removed) throw new DeviceError(404, 'not-found', 'no such device');
    this.#seen.delete(id);
    const sockets = this.#deviceSockets.get(id);
    this.#deviceSockets.delete(id);
    for (const socket of sockets ?? []) socket.destroy();
  }

  // ── pairing ───────────────────────────────────────────────────────────

  /** "Pair a device": a new one-time code (the old one stops working) and the URL the QR code carries. */
  async createPairingCode(): Promise<DevicePairingCode> {
    const state = await this.accessState();
    if (!state.enabled || state.https !== 'ok' || !this.#origin) {
      throw new DeviceError(409, 'access-off', 'Switch device access on (and get HTTPS working) before pairing a device.');
    }
    const code = newPairingCode();
    const expiresAt = new Date(this.#now() + DEVICE_CODE_TTL_MS).toISOString();
    await this.#store.devices.replaceCode({ id: randomBytes(9).toString('base64url'), codeHash: hashPeerToken(code), expiresAt });
    return { code, expiresAt, url: `${this.#origin}/pair#code=${code}` };
  }

  /** Drops the waiting code. */
  async cancelPairingCode(): Promise<void> {
    await this.#store.devices.clearCodes();
  }

  /** `true` while a code waits. */
  async pairingPending(): Promise<boolean> {
    const current = await this.#store.devices.currentCode();
    return current !== null && Date.parse(current.expiresAt) > this.#now();
  }

  /**
   * `POST /device/v1/pair` (device listener, no credential): trades the one-time
   * code for a device credential. At most {@link DEVICE_PAIR_MAX_ATTEMPTS} tries
   * per {@link DEVICE_PAIR_WINDOW_MS} from anyone (429), the code expires, is
   * single use and burns after {@link DEVICE_CODE_MAX_FAILURES} wrong tries.
   */
  async pair(body: unknown, headers: FastifyRequest['headers']): Promise<{ readonly status: number; readonly body: unknown; readonly cookie?: string }> {
    const now = this.#now();
    while (this.#attempts.length > 0 && (this.#attempts[0] as number) <= now - DEVICE_PAIR_WINDOW_MS) this.#attempts.shift();
    if (this.#attempts.length >= DEVICE_PAIR_MAX_ATTEMPTS) {
      return { status: 429, body: { error: 'rate-limited', message: 'Too many pairing attempts. Wait a few minutes, then make a new code.' } };
    }
    this.#attempts.push(now);
    const input = (typeof body === 'object' && body !== null ? body : {}) as { code?: unknown; name?: unknown };
    const current = await this.#store.devices.currentCode();
    if (!current) return { status: 400, body: { error: 'no-code', message: 'No pairing code is waiting. Make one on the computer: Settings → Devices → Pair a device.' } };
    if (Date.parse(current.expiresAt) <= now) {
      await this.#store.devices.clearCodes();
      return { status: 400, body: { error: 'expired', message: 'The code expired. Make a new one on the computer.' } };
    }
    const typed = normalizePairingCode(input.code);
    if (typed === null || !hashesMatch(hashPeerToken(typed), current.codeHash)) {
      const failures = current.failures + 1;
      if (failures >= DEVICE_CODE_MAX_FAILURES) {
        await this.#store.devices.clearCodes();
        return { status: 400, body: { error: 'too-many-tries', message: 'Too many wrong codes: this code no longer works. Make a new one on the computer.' } };
      }
      await this.#store.devices.setCodeFailures(current.id, failures);
      return { status: 400, body: { error: 'wrong-code', message: 'That code is not right. Check it and try again.' } };
    }
    // Single use: gone before the device exists.
    await this.#store.devices.clearCodes();
    const userAgent = typeof headers['user-agent'] === 'string' ? headers['user-agent'].slice(0, 400) : null;
    const login = typeof headers['tailscale-user-login'] === 'string' && headers['tailscale-user-login'].trim() ? headers['tailscale-user-login'].trim().slice(0, 200) : null;
    const id = newDeviceId();
    const secret = newDeviceSecret();
    const record = await this.#store.devices.create({
      id,
      name: cleanDeviceName(input.name) ?? deviceNameFromUserAgent(userAgent),
      userAgent,
      credentialHash: hashDeviceSecret(secret),
      tailscaleLogin: login,
    });
    this.#markSeen(record.id);
    return { status: 201, body: { device: await this.#toDevice(record) }, cookie: serializeDeviceCookie(id, secret) };
  }

  /** What the pairing page shows. */
  async machineName(): Promise<string> {
    try {
      return await this.#machineName();
    } catch {
      return 'this computer';
    }
  }

  // ── this device and push ──────────────────────────────────────────────

  /** `GET /api/device`: the asking device (or `null` on this machine's UI), the VAPID key and its toggles. */
  async selfView(device: DeviceRecord | null): Promise<DeviceSelfView> {
    const access = await this.accessState();
    const push = device ? await this.#store.devices.push(device.id) : null;
    return {
      device: device ? await this.#toDevice(device) : null,
      vapidPublicKey: device && access.enabled ? (await this.vapidKeys()).publicKey : null,
      events: push ? readPushEvents(push.events) : DEFAULT_PUSH_EVENTS,
    };
  }

  /** `PUT /api/device/push`: stores the device's subscription and / or its toggles. */
  async savePush(device: DeviceRecord, body: unknown): Promise<DeviceSelfView> {
    const input = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : null) as { subscription?: unknown; events?: unknown } | null;
    if (!input) throw new DeviceError(422, 'invalid', 'the body must be { subscription?, events? }');
    const existing = await this.#store.devices.push(device.id);
    let events: PushEvents = existing ? readPushEvents(existing.events) : DEFAULT_PUSH_EVENTS;
    if (input.events !== undefined) {
      const merged = mergePushEvents(events, input.events);
      if (!merged) throw new DeviceError(422, 'invalid', 'events must map permission / questions / turnFinished / errors / inbox to true or false');
      events = merged;
    }
    if (input.subscription !== undefined) {
      if (!validSubscription(input.subscription, this.#config.pushTestEndpoints)) {
        throw new DeviceError(422, 'invalid-subscription', "the subscription must be a browser push subscription on a known push service (Apple, Google, Mozilla, Microsoft)");
      }
      const subscription = input.subscription;
      await this.#store.devices.savePush({ deviceId: device.id, endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, events });
    } else if (existing) {
      await this.#store.devices.setPushEvents(device.id, events);
    } else {
      throw new DeviceError(409, 'no-subscription', 'Enable notifications first.');
    }
    return this.selfView(device);
  }

  /** `DELETE /api/device/push`: notifications off for this device. */
  async deletePush(device: DeviceRecord): Promise<DeviceSelfView> {
    await this.#store.devices.deletePush(device.id);
    return this.selfView(device);
  }

  /** `POST /api/device/push/test`: one test notification to this device. */
  async testPush(device: DeviceRecord): Promise<PushOutcome> {
    const record = await this.#store.devices.push(device.id);
    if (!record) throw new DeviceError(409, 'no-subscription', 'Enable notifications first.');
    const payload: PushPayload = { kind: 'test', title: 'Switchboard', body: 'Notifications work on this device.', url: '/settings/devices', tag: 'test' };
    return this.#deliverTo(record.deviceId, payload, 'normal');
  }

  /** The VAPID keys (`<dataDir>/vapid.json`, 0600; made on first use). */
  vapidKeys(): Promise<VapidKeys> {
    this.#vapid ??= loadOrCreateVapidKeys(this.#config.dataDir).catch((error: unknown) => {
      this.#vapid = null;
      throw error;
    });
    return this.#vapid;
  }

  /** Sends a notice to every device whose toggle for its kind is on (only while device access is on). */
  async deliver(notice: PushNotice): Promise<void> {
    if (!(await this.#accessSetting()).enabled) return;
    const subscriptions = await this.#store.devices.pushList();
    await Promise.all(
      subscriptions
        .filter((record) => readPushEvents(record.events)[notice.kind])
        .map((record) => this.#deliverTo(record.deviceId, notice.payload, notice.urgency)),
    );
  }

  async #deliverTo(deviceId: string, payload: PushPayload, urgency: 'high' | 'normal'): Promise<PushOutcome> {
    const record = await this.#store.devices.push(deviceId);
    if (!record) return { ok: false, gone: true, status: 0, error: 'no subscription' };
    const outcome = await sendPush(
      { endpoint: record.endpoint, keys: { p256dh: record.p256dh, auth: record.auth } },
      payload,
      { vapid: await this.vapidKeys(), urgency, ...(this.#fetch ? { fetch: this.#fetch } : {}), now: this.#now },
    );
    if (outcome.ok) {
      if (record.lastError !== null) await this.#store.devices.setPushError(deviceId, null);
    } else if (outcome.gone) {
      // 404 / 410: the browser dropped the subscription; forget it (the device can enable again).
      await this.#store.devices.deletePush(deviceId);
    } else {
      await this.#store.devices.setPushError(deviceId, `${outcome.status || 'network'}: ${outcome.error}`.slice(0, 300));
    }
    return outcome;
  }
}

/** Reads `<dataDir>/vapid.json`, or makes and stores a new pair (0600). */
export async function loadOrCreateVapidKeys(dataDir: string): Promise<VapidKeys> {
  const file = path.join(dataDir, VAPID_FILE);
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (validVapidKeys(parsed)) return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const keys = generateVapidKeys();
  await writeFile(file, `${JSON.stringify(keys)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(file, 0o600);
  return keys;
}

/** `true` when the request arrived on the device listener (re-exported for the routes). */
export { isDeviceRequest };
