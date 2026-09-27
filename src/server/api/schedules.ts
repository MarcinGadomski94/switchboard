import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../routes.ts';
import { type PendingRoute, registerPending } from './not-implemented.ts';

/** Schedule routes (contract → REST; D8 "Save schedule" = POST /api/schedules) not implemented yet. */
export const SCHEDULE_ROUTES_PENDING: readonly PendingRoute[] = [
  { method: 'GET', url: '/api/schedules', item: 'M7.1' },
  { method: 'POST', url: '/api/schedules', item: 'M7.1' },
  { method: 'POST', url: '/api/schedules/:id/run', item: 'M7.1' },
  { method: 'POST', url: '/api/schedules/:id/pause', item: 'M7.1' },
  { method: 'POST', url: '/api/schedules/:id/resume', item: 'M7.1' },
];

/** Registers the schedule routes. */
export async function registerScheduleRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  void context;
  registerPending(app, SCHEDULE_ROUTES_PENDING);
}
