import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../routes.ts';
import { type PendingRoute, registerPending } from './not-implemented.ts';

/** Inbox and question routes (contract → REST) not implemented yet. */
export const INBOX_ROUTES_PENDING: readonly PendingRoute[] = [
  { method: 'GET', url: '/api/inbox', item: 'M3.2' },
  { method: 'POST', url: '/api/questions/batch/:batchId/answers', item: 'M3.1' },
  { method: 'POST', url: '/api/inbox/:id/actions/:action', item: 'M3.1' },
];

/** Registers the Inbox and question routes. */
export async function registerInboxRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  void context;
  registerPending(app, INBOX_ROUTES_PENDING);
}
