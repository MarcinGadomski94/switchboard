import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../routes.ts';
import { type PendingRoute, registerPending } from './not-implemented.ts';

/** History routes (contract → REST) not implemented yet. */
export const HISTORY_ROUTES_PENDING: readonly PendingRoute[] = [{ method: 'GET', url: '/api/history', item: 'M7.4' }];

/** Registers the History routes. */
export async function registerHistoryRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  void context;
  registerPending(app, HISTORY_ROUTES_PENDING);
}
