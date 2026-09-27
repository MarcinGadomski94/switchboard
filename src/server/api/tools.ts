import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../routes.ts';
import { type PendingRoute, registerPending } from './not-implemented.ts';

/** Embedded-tool routes (contract → REST) not implemented yet. */
export const TOOL_ROUTES_PENDING: readonly PendingRoute[] = [
  { method: 'GET', url: '/api/tools', item: 'M8.1' },
  { method: 'PUT', url: '/api/tools', item: 'M8.1' },
  { method: 'POST', url: '/api/tools/:id/probe', item: 'M8.1' },
];

/** Registers the embedded-tool routes. */
export async function registerToolRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  void context;
  registerPending(app, TOOL_ROUTES_PENDING);
}
