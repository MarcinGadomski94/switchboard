import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../routes.ts';
import { type PendingRoute, registerPending } from './not-implemented.ts';

/**
 * System route (contract → REST) not implemented yet: CLI/gh sign-in + machine
 * metrics (M5.3, gap #11), `usagePct` added by M9.2.
 */
export const SYSTEM_ROUTES_PENDING: readonly PendingRoute[] = [{ method: 'GET', url: '/api/system', item: 'M5.3' }];

/** Registers the system route. */
export async function registerSystemRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  void context;
  registerPending(app, SYSTEM_ROUTES_PENDING);
}
