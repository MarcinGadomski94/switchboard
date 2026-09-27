import type { FastifyInstance, FastifyReply, HTTPMethods } from 'fastify';
import type { NotImplementedBody } from '../../core/api.ts';

/** One contract route that answers 501 until its backlog item replaces it. */
export interface PendingRoute {
  readonly method: HTTPMethods;
  /** Fastify path (`:param` placeholders). */
  readonly url: string;
  /** The backlog item that implements it (`docs/lanes.md`). */
  readonly item: string;
}

/** Sends `501 { error: "not-implemented", item }`. */
export function sendNotImplemented(reply: FastifyReply, item: string): FastifyReply {
  const body: NotImplementedBody = { error: 'not-implemented', item };
  return reply.code(501).send(body);
}

/**
 * Registers `routes` as 501 placeholders. A backlog item implements a route by
 * registering the real handler in its area module and deleting the matching
 * entry from that module's pending list (Fastify refuses a duplicate route).
 */
export function registerPending(app: FastifyInstance, routes: readonly PendingRoute[]): void {
  for (const route of routes) {
    app.route({ method: route.method, url: route.url, handler: async (_request, reply) => sendNotImplemented(reply, route.item) });
  }
}
