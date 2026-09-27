import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../routes.ts';
import { type PendingRoute, registerPending } from './not-implemented.ts';

/** Session routes (contract → REST, `/api/sessions*`) not implemented yet. */
export const SESSION_ROUTES_PENDING: readonly PendingRoute[] = [
  { method: 'GET', url: '/api/sessions', item: 'M4.1' },
  { method: 'POST', url: '/api/sessions', item: 'M5.1' },
  { method: 'GET', url: '/api/sessions/:id', item: 'M4.1' },
  { method: 'POST', url: '/api/sessions/:id/messages', item: 'M4.2' },
  { method: 'POST', url: '/api/sessions/:id/pause', item: 'M4.1' },
  { method: 'POST', url: '/api/sessions/:id/resume', item: 'M4.1' },
  { method: 'POST', url: '/api/sessions/:id/detach', item: 'M4.1' },
  { method: 'POST', url: '/api/sessions/:id/attach', item: 'M4.1' },
  { method: 'GET', url: '/api/sessions/:id/events', item: 'M4.2' },
  { method: 'GET', url: '/api/sessions/:id/diff', item: 'M4.5' },
];

/** Registers the session routes. */
export async function registerSessionRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  void context;
  registerPending(app, SESSION_ROUTES_PENDING);
}
