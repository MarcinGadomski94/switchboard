import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../routes.ts';
import { type PendingRoute, registerPending } from './not-implemented.ts';

/** Solutions routes (contract → REST) not implemented yet. */
export const SOLUTION_ROUTES_PENDING: readonly PendingRoute[] = [
  { method: 'GET', url: '/api/solutions', item: 'M6.2' },
  { method: 'POST', url: '/api/solutions/:repo/isolate', item: 'M6.3' },
];

/** Registers the Solutions routes. */
export async function registerSolutionRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  void context;
  registerPending(app, SOLUTION_ROUTES_PENDING);
}
