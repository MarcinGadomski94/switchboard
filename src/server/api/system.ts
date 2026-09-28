import type { FastifyInstance, FastifyReply } from 'fastify';
import type { SystemInfo } from '../../core/api.ts';
import type { ApiContext } from '../routes.ts';
import type { PendingRoute } from './not-implemented.ts';

/** System routes (contract → REST) not implemented yet: none since M5.3 (`usagePct` is added by M9.2). */
export const SYSTEM_ROUTES_PENDING: readonly PendingRoute[] = [];

interface SystemQuery {
  readonly fresh?: string;
}

/**
 * `GET /api/system` (contract): `providers.system`, the real `SystemProbe`
 * (M5.3, `system/probe.ts`, `docs/setup.md` → *System*) or the demo's.
 * `?fresh=1` (additive) checks the CLI and gh again instead of answering from a
 * recent check. Without a provider (an app built without one, e.g. in tests)
 * the route answers 503 `system-unavailable`: it never runs a CLI of its own.
 */
export async function registerSystemRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  app.get<{ Querystring: SystemQuery }>('/api/system', async (request, reply): Promise<SystemInfo | FastifyReply> => {
    const system = context.providers.system;
    if (!system) return reply.code(503).send({ error: 'system-unavailable', message: 'no system provider' });
    return system.system({ fresh: request.query.fresh === '1' });
  });
}
