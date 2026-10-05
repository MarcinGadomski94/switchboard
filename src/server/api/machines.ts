import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ATTACHMENT_UPLOAD_BODY_MAX } from '../../core/attachments.ts';
import { parseRemoteId } from '../../core/peers.ts';
import { PEER_REQUEST_HEADER, PeerError, type PeerService } from '../peers/service.ts';
import type { ApiContext } from '../routes.ts';

/**
 * D48 (`docs/peers.md`): Settings → Machines and the proxy to paired machines.
 *
 * - `GET /api/machines`: this machine, the peer listener, the paired machines.
 * - `PUT /api/machines/self` `{ name }`, `PUT /api/machines/listener` `{ enabled?, address?, port? }`.
 * - `POST /api/machines/pairing-code` → `{ code, expiresAt }` ("Allow a new peer").
 * - `POST /api/machines` `{ address, code }` → 201 Machine ("Add machine").
 * - `PUT /api/machines/{id}` `{ name }`, `DELETE /api/machines/{id}` (revoke).
 * - `POST /api/machines/{id}/reconnect` → ReconnectResult (Reconnect now; fix · peer reconnects).
 * - `PUT /api/machines/{id}/sidebar-sync` `{ enabled }` → Machine (D71: the shared sidebar layout with it).
 * - `/api/machines/{id}/api/*`: that machine's peer API (its folders, models,
 *   branching preflight, new sessions, terminal sessions and hooks), answers namespaced.
 *
 * Plus the forwarding of the existing routes: a request whose `:id` / `:batchId`
 * is a remote id (`r~<machine>~<id>`) is sent to that machine ({@link registerPeerForwarding}).
 */
export async function registerMachineRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { peers } = context;

  app.get('/api/machines', async () => peers.view());

  app.put('/api/machines/self', async (request, reply) => {
    try {
      return await peers.renameSelf((request.body as { name?: unknown } | null)?.name);
    } catch (error) {
      return sendPeerError(reply, error);
    }
  });

  app.put('/api/machines/listener', async (request, reply) => {
    try {
      return await peers.setListener(request.body);
    } catch (error) {
      return sendPeerError(reply, error);
    }
  });

  app.post('/api/machines/pairing-code', async () => peers.createPairingCode());

  app.post('/api/machines', async (request, reply) => {
    try {
      return reply.code(201).send(await peers.addMachine(request.body));
    } catch (error) {
      return sendPeerError(reply, error);
    }
  });

  app.put<{ Params: { id: string } }>('/api/machines/:id', async (request, reply) => {
    try {
      return await peers.renameMachine(request.params.id, (request.body as { name?: unknown } | null)?.name);
    } catch (error) {
      return sendPeerError(reply, error);
    }
  });

  // D71: the shared sidebar layout with that machine, on / off (off until switched on; turning it on merges both layouts).
  app.put<{ Params: { id: string } }>('/api/machines/:id/sidebar-sync', async (request, reply) => {
    try {
      return await peers.setSidebarSync(request.params.id, request.body);
    } catch (error) {
      return sendPeerError(reply, error);
    }
  });

  // Fix · peer reconnects: Reconnect now (cuts the wait; joins an attempt already running; never two at once).
  app.post<{ Params: { id: string } }>('/api/machines/:id/reconnect', async (request, reply) => {
    try {
      return await peers.reconnect(request.params.id);
    } catch (error) {
      return sendPeerError(reply, error);
    }
  });

  // Fix · peer reconnects, tests only (`SWITCHBOARD_PEER_TEST_HOOKS=1`): a dropped stream and an outage of the listener.
  if (context.config.peerTestHooks) {
    app.post('/api/test/peers/drop', async () => ({ dropped: peers.testDropStreams() }));
    app.post('/api/test/peers/outage', async (request, reply) => {
      const ms = (request.body as { ms?: unknown } | null)?.ms;
      if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0 || ms > 600_000) return reply.code(422).send({ error: 'invalid', message: 'ms must be 0–600000' });
      await peers.testOutage(ms);
      return reply.code(204).send();
    });
    app.delete('/api/test/peers/outage', async (_request, reply) => {
      await peers.testEndOutage();
      return reply.code(204).send();
    });
  }

  app.delete<{ Params: { id: string } }>('/api/machines/:id', async (request, reply) => {
    try {
      await peers.removeMachine(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return sendPeerError(reply, error);
    }
  });

  const machineApi = async (request: FastifyRequest<{ Params: { id: string; '*'?: string } }>, reply: FastifyReply, rest: string): Promise<FastifyReply> => {
    if (request.headers[PEER_REQUEST_HEADER] !== undefined) return reply.code(403).send({ error: 'peer-forbidden', message: 'a peer cannot reach further machines' });
    const query = queryOf(request.url);
    const answer = await peers.forward(request.params.id, request.method, `/api/${rest}${query}`, request.body);
    return reply.code(answer.status).send(answer.body ?? undefined);
  };
  // D57: a New-session start on that machine uploads its attachments there first (one file per call, base64).
  app.post<{ Params: { id: string } }>('/api/machines/:id/api/attachments', { bodyLimit: ATTACHMENT_UPLOAD_BODY_MAX }, (request, reply) => machineApi(request, reply, 'attachments'));
  app.route<{ Params: { id: string; '*': string } }>({
    method: ['GET', 'POST', 'PUT', 'DELETE'],
    url: '/api/machines/:id/api/*',
    handler: async (request, reply) => machineApi(request, reply, request.params['*']),
  });
}

/** Sends a {@link PeerError} as `{ error, message }`; rethrows anything else. */
export function sendPeerError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PeerError) return reply.code(error.status).send({ error: error.code, message: error.message });
  throw error;
}

function queryOf(url: string): string {
  const cut = url.indexOf('?');
  return cut < 0 ? '' : url.slice(cut);
}

/** The route params that carry an id the peers' proxy understands. */
const ID_PARAMS = ['id', 'batchId'] as const;

/**
 * D48: a `preHandler` for every route. A request whose `:id` or `:batchId` param is
 * a remote id goes to that machine with the id made raw again, and its answer comes
 * back namespaced (`PeerService.forward`); `POST /api/sessions` with a `machine`
 * field (another machine's id) starts the session there (P3); D52: `POST
 * /api/schedules` with a `machine` field saves a new schedule there, and with the
 * `id` of a peer's schedule edits it there. Requests the peer API
 * injected (header {@link PEER_REQUEST_HEADER}) are never forwarded.
 */
export function registerPeerForwarding(app: FastifyInstance, peers: PeerService): void {
  app.addHook('preHandler', async (request, reply) => {
    if (request.headers[PEER_REQUEST_HEADER] !== undefined) return undefined;
    const route = request.routeOptions.url;
    if (!route || !route.startsWith('/api/') || route.startsWith('/api/machines')) return undefined;
    const params = (request.params ?? {}) as Record<string, unknown>;
    let machineId: string | null = null;
    let path = route;
    for (const name of ID_PARAMS) {
      const value = params[name];
      if (typeof value !== 'string') continue;
      const remote = parseRemoteId(value);
      if (!remote) continue;
      if (machineId !== null && machineId !== remote.machineId) return reply.code(422).send({ error: 'invalid', message: 'ids of two machines in one request' });
      machineId = remote.machineId;
      path = path.replace(`:${name}`, encodeURIComponent(remote.id));
    }
    let body: unknown = request.body;
    if (machineId === null && route === '/api/sessions' && request.method === 'POST') {
      const machine = (body as { machine?: unknown } | null)?.machine;
      if (machine !== undefined) {
        const { machine: _machine, ...rest } = body as Record<string, unknown>;
        body = rest;
        if (typeof machine === 'string' && machine !== '' && machine !== (await peers.self()).id) machineId = machine;
        // This machine (or none): the field is the form's, not NewSession's.
        else request.body = rest;
      }
    }
    // D52: Save schedule on a peer: `machine` names it (a new schedule), or `id` is a peer's schedule (an Edit; made raw).
    if (machineId === null && route === '/api/schedules' && request.method === 'POST' && body !== null && typeof body === 'object' && !Array.isArray(body)) {
      const { machine, ...rest } = body as Record<string, unknown>;
      const remote = parseRemoteId(rest['id']);
      const self = (await peers.self()).id;
      const given = typeof machine === 'string' && machine !== '' ? machine : null;
      const named = given !== null && given !== self ? given : null;
      if (remote && given !== null && given !== remote.machineId) return reply.code(422).send({ error: 'invalid', message: 'a schedule stays on its machine: `machine` names another one' });
      if (remote) {
        machineId = remote.machineId;
        body = { ...rest, id: remote.id };
      } else if (named !== null) {
        machineId = named;
        body = rest;
      } else if (machine !== undefined) {
        // This machine (or none): the field is the form's, not ScheduleInput's.
        request.body = rest;
      }
    }
    if (machineId === null) return undefined;
    // Other params (`:action`) keep their value.
    for (const [name, value] of Object.entries(params)) {
      if (typeof value === 'string') path = path.replace(`:${name}`, encodeURIComponent(value));
    }
    // D57: an attachment is bytes: passed on with its serving headers (never parsed as JSON).
    if (request.method === 'GET' && route === ATTACHMENT_ROUTE) {
      const raw = await peers.forwardRaw(machineId, `${path}${queryOf(request.url)}`);
      if (raw.bytes === null) return reply.code(raw.status).send(raw.body ?? undefined);
      reply.code(raw.status).header('cache-control', 'private, no-cache');
      for (const [name, value] of Object.entries(raw.headers)) reply.header(name, value);
      return reply.send(raw.bytes);
    }
    const answer = await peers.forward(machineId, request.method, `${path}${queryOf(request.url)}`, body);
    return reply.code(answer.status).send(answer.body ?? undefined);
  });
}

/** D57: the attachment download route (its peer answer is bytes). */
const ATTACHMENT_ROUTE = '/api/sessions/:id/attachments/:attachmentId';

/** `true` when the request came in through the peer API (answer this machine's own data only). */
export function isPeerRequest(request: FastifyRequest): boolean {
  return request.headers[PEER_REQUEST_HEADER] !== undefined;
}
