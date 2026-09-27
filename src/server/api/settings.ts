import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../routes.ts';
import { type PendingRoute, registerPending } from './not-implemented.ts';

/** Settings routes (contract → REST) not implemented yet. */
export const SETTINGS_ROUTES_PENDING: readonly PendingRoute[] = [
  { method: 'GET', url: '/api/settings', item: 'M8.2' },
  { method: 'PUT', url: '/api/settings', item: 'M8.2' },
];

/** Registers the settings routes. */
export async function registerSettingsRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  void context;
  registerPending(app, SETTINGS_ROUTES_PENDING);
}
