import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../routes.ts';

/**
 * `GET /hub`: the Server-Sent Events stream (M2.3, D5, contract → Event hub).
 * The security guard (security.ts) runs first like on every route: foreign
 * Host/Origin → 403, no `sb_token` cookie → 401. The handler then hands the raw
 * response to the SSE hub (`hub/hub.ts`, `docs/hub.md`). D87: `?client=<id>` (a
 * page's own id) ties the stream to that page's presence on a paired device
 * (`docs/devices.md`); without it, or on this machine's UI, nothing changes. D95 follow-up:
 * `?agents=delta` asks for agent deltas in `sessionUpdated` (`docs/performance.md` → *Agent deltas*). No HEAD route: a HEAD
 * request would hold a stream open that can carry no body.
 */
export async function registerHubRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  app.get<{ Querystring: { client?: string; agents?: string } }>('/hub', { exposeHeadRoute: false }, (request, reply) => {
    reply.hijack();
    // D87: a paired device's page names itself (`/hub?client=<id>`): while this stream is open it may count as in front.
    const release = context.devices.hubConnected(request.device ?? null, request.query.client);
    if (release) reply.raw.once('close', release);
    // D95 follow-up: `?agents=delta` = sessionUpdated carries only the agents that changed (`core/agent-delta.ts`).
    context.hub.attach(reply.raw, { agentDeltas: request.query.agents === 'delta' });
  });
}
