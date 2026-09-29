import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { isTailscaleIPv4, parseIPv4 } from '../../core/peers.ts';
import { LOOPBACK_HOST } from '../config.ts';
import type { MachineRecord } from '../db/repos/machines.ts';
import { bearerToken } from './tokens.ts';

/**
 * The optional **peer listener** (D48, `docs/peers.md`, `docs/security.md` → *Peer
 * listener*): a second socket, bound only to this machine's Tailscale address
 * (100.64.0.0/10), serving only the peer API under `/peer/v1`. It is not the UI
 * listener: no page, no cookie, no `/api` of its own. Every request needs
 * `Host: <bound address>:<port>` exactly and no `Origin`; every route but the
 * pairing exchange needs a per-pair bearer token. Off by default.
 */

/** Thrown when the peer listener is asked to bind an address it must not. */
export class PeerBindRefusedError extends Error {
  override name = 'PeerBindRefusedError';
}

/**
 * Refuses every bind address but a Tailscale IPv4 (100.64.0.0/10); with
 * `allowLoopback` (tests only, `SWITCHBOARD_PEER_TEST_LOOPBACK=1`) also 127.0.0.1.
 * @throws {PeerBindRefusedError}
 */
export function assertPeerBind(host: string, allowLoopback: boolean): void {
  if (parseIPv4(host) === null) throw new PeerBindRefusedError(`Refusing to bind the peer listener to "${host}": not an IPv4 address`);
  if (isTailscaleIPv4(host)) return;
  if (allowLoopback && host === LOOPBACK_HOST) return;
  throw new PeerBindRefusedError(`Refusing to bind the peer listener to "${host}": only a Tailscale address (100.64.0.0/10) is allowed`);
}

/** What the peer routes do; the {@link PeerService} implements it. */
export interface PeerHandlers {
  /** The machine presenting `token` (constant-time hash compare), or `null`. */
  authenticate(token: string): Promise<MachineRecord | null>;
  /** `POST /peer/v1/pair` (no token: the one-time code is the credential). */
  pair(body: unknown): Promise<{ readonly status: number; readonly body: unknown }>;
  /** `POST /peer/v1/hello`: who we are; the caller tells its own listener address. */
  hello(machine: MachineRecord, body: unknown): Promise<unknown>;
  /** `DELETE /peer/v1/pair`: the caller removed us; forget it too. */
  unpair(machine: MachineRecord): Promise<void>;
  /** `GET /peer/v1/events`: take over the raw response as an event stream. */
  events(machine: MachineRecord, res: ServerResponse): void;
  /** `/peer/v1/api/*`: the allow-listed local API, answered as the local UI would get it. */
  api(machine: MachineRecord, method: string, url: string, body: unknown): Promise<{ readonly status: number; readonly body: string; readonly contentType: string | null }>;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** D48: the paired machine a peer-listener request authenticated as. */
    peerMachine?: MachineRecord;
  }
}

/** Largest peer request body (1 MiB). */
export const PEER_BODY_LIMIT = 1024 * 1024;

function deny(reply: FastifyReply, status: number, error: string): FastifyReply {
  return reply.code(status).header('cache-control', 'no-store').send({ error });
}

/** `true` for the pairing exchange (the one route without a token). */
function isPairRoute(request: FastifyRequest): boolean {
  const pathname = request.url.split('?')[0];
  return request.method === 'POST' && pathname === '/peer/v1/pair';
}

/**
 * Builds the peer app (not listening). The guard runs first on every request and
 * every 404: Host exact, no Origin, then the bearer token (the pairing exchange
 * excepted).
 */
export function buildPeerApp(options: { readonly host: string; readonly port: number; readonly handlers: PeerHandlers }): FastifyInstance {
  const { handlers } = options;
  const expectedHost = `${options.host}:${options.port}`;
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: PEER_BODY_LIMIT });
  app.decorateRequest('peerMachine', undefined);
  app.addHook('onRequest', async (request, reply) => {
    if ((request.headers.host ?? '').trim().toLowerCase() !== expectedHost) return deny(reply, 403, 'forbidden-host');
    // A browser page never talks to the peer API: any Origin (a cross-site fetch, a rebinding page) is refused.
    if (request.headers.origin !== undefined) return deny(reply, 403, 'forbidden-origin');
    if (isPairRoute(request)) return undefined;
    const token = bearerToken(request.headers.authorization);
    const machine = token ? await handlers.authenticate(token) : null;
    if (!machine) return deny(reply, 401, 'unauthorized');
    request.peerMachine = machine;
    return undefined;
  });

  app.post('/peer/v1/pair', async (request, reply) => {
    const answer = await handlers.pair(request.body);
    return reply.code(answer.status).header('cache-control', 'no-store').send(answer.body);
  });
  app.post('/peer/v1/hello', async (request) => handlers.hello(request.peerMachine as MachineRecord, request.body));
  app.delete('/peer/v1/pair', async (request, reply) => {
    await handlers.unpair(request.peerMachine as MachineRecord);
    return reply.code(204).send();
  });
  app.get('/peer/v1/events', { exposeHeadRoute: false }, (request, reply) => {
    reply.hijack();
    handlers.events(request.peerMachine as MachineRecord, reply.raw);
  });
  app.route({
    method: ['GET', 'POST', 'PUT', 'DELETE'],
    url: '/peer/v1/api/*',
    handler: async (request, reply) => {
      const url = request.url.slice('/peer/v1'.length);
      const answer = await handlers.api(request.peerMachine as MachineRecord, request.method, url, request.body);
      reply.code(answer.status).header('cache-control', 'no-store');
      if (answer.contentType) reply.header('content-type', answer.contentType);
      return reply.send(answer.body === '' ? undefined : answer.body);
    },
  });
  return app;
}

/**
 * Listens on `host:port` after {@link assertPeerBind} and checks the address the
 * socket actually bound (closing it when that is anything else).
 */
export async function listenPeer(app: FastifyInstance, host: string, port: number, allowLoopback: boolean): Promise<AddressInfo> {
  assertPeerBind(host, allowLoopback);
  await app.listen({ host, port });
  const address = app.server.address();
  if (address === null || typeof address === 'string' || address.address !== host) {
    await app.close();
    throw new PeerBindRefusedError(`The peer listener bound an unexpected address ${JSON.stringify(address)}; closed`);
  }
  return address;
}
