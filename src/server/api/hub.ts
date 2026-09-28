import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../routes.ts';

/**
 * `GET /hub`: the Server-Sent Events stream (M2.3, D5, contract → Event hub).
 * The security guard (security.ts) runs first like on every route: foreign
 * Host/Origin → 403, no `sb_token` cookie → 401. The handler then hands the raw
 * response to the SSE hub (`hub/hub.ts`, `docs/hub.md`). No HEAD route: a HEAD
 * request would hold a stream open that can carry no body.
 */
export async function registerHubRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  app.get('/hub', { exposeHeadRoute: false }, (_request, reply) => {
    reply.hijack();
    context.hub.attach(reply.raw);
  });
}
