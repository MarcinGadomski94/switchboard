import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.ts';

/** What API route modules receive when they register. Later items add their services here. */
export interface ApiContext {
  readonly config: ServerConfig;
}

/**
 * Registry of the REST routes (`/api/*`, contracts/local-api.md) and the `/hub`
 * SSE endpoint. Each feature registers from its own file with a one-line call
 * added here. The security guard (security.ts) already covers every route
 * registered here: none of them may be marked `config.public`.
 */
export async function registerApiRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  // No API routes yet (M1.1 is the skeleton). Keep additions one line each.
  void app;
  void context;
}
