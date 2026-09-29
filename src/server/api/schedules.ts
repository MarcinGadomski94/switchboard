import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Schedule } from '../../core/api.ts';
import type { ApiContext } from '../routes.ts';
import { SchedulerError, type SchedulerErrorCode } from '../schedules/scheduler.ts';
import { isPeerRequest } from './machines.ts';
import { type PendingRoute, registerPending } from './not-implemented.ts';

/** Schedule routes (contract → REST; D8 "Save schedule" = POST /api/schedules) not implemented yet (none since M7.1). */
export const SCHEDULE_ROUTES_PENDING: readonly PendingRoute[] = [];

/** HTTP status of each scheduler refusal. */
const ERROR_STATUS: Record<SchedulerErrorCode, number> = {
  'not-found': 404,
  running: 409,
  invalid: 422,
  closing: 503,
};

interface IdParams {
  readonly id: string;
}

/** Sends a scheduler refusal (`invalid` as the usual `{ error: "invalid", errors }`), rethrows anything else. */
function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (!(error instanceof SchedulerError)) throw error;
  if (error.code === 'invalid') return reply.code(422).send({ error: 'invalid', errors: error.errors });
  return reply.code(ERROR_STATUS[error.code]).send({ error: error.code, message: error.message });
}

/**
 * Registers the schedule routes (M7.1, `docs/schedules.md`): the list, "Save
 * schedule" (create, or replace with `id` = Edit), Run now, Pause and Resume, each
 * answering the contract's `Schedule`; D52: Delete, and the paired machines'
 * schedules in the list.
 */
export async function registerScheduleRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { scheduler } = context;

  // D52: plus the paired machines' schedules as last known (tagged, remote ids); a peer's request gets this machine's own only.
  app.get('/api/schedules', async (request): Promise<Schedule[]> => [...(await scheduler.list()), ...(isPeerRequest(request) ? [] : context.peers.remoteSchedules())]);

  // D8: the New-session modal's "Save schedule" (ScheduleInput); 201 for a new schedule, 200 for an Edit.
  app.post('/api/schedules', async (request, reply) => {
    const body = request.body as { id?: unknown } | null | undefined;
    const editing = typeof body === 'object' && body !== null && body.id !== undefined && body.id !== null;
    try {
      const schedule = await scheduler.save(request.body);
      return reply.code(editing ? 200 : 201).send(schedule);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Run now: the run's first result is in the schedule's last run (`running`, or `fail` when its session could not start).
  app.post<{ Params: IdParams }>('/api/schedules/:id/run', async (request, reply) => {
    try {
      await scheduler.runNow(request.params.id);
      return await scheduler.get(request.params.id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: IdParams }>('/api/schedules/:id/pause', async (request, reply) => {
    try {
      return await scheduler.pause(request.params.id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: IdParams }>('/api/schedules/:id/resume', async (request, reply) => {
    try {
      return await scheduler.resume(request.params.id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // D52: Delete (the schedule editor's "Delete schedule"; also a peer's schedule, through the peer proxy). 204; 409 while a run is in progress.
  app.delete<{ Params: IdParams }>('/api/schedules/:id', async (request, reply) => {
    try {
      await scheduler.delete(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  registerPending(app, SCHEDULE_ROUTES_PENDING);
}
