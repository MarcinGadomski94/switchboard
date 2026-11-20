import type { FastifyInstance, FastifyReply } from 'fastify';
import { isRemoteId } from '../../core/peers.ts';
import type { TurnChangesErrorCode } from '../../core/turn-changes.ts';
import { TURN_CHANGES_STATUS, TurnChangesError, TurnChangesService } from '../checkpoints/turn-changes.ts';
import type { ApiContext } from '../routes.ts';

interface IdParams {
  readonly id: string;
}

interface DiffQuery {
  readonly from?: unknown;
  readonly to?: unknown;
}

function refuse(reply: FastifyReply, code: TurnChangesErrorCode, message: string): FastifyReply {
  return reply.code(TURN_CHANGES_STATUS[code]).send({ error: code, message });
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof TurnChangesError) return refuse(reply, error.code, error.message);
  throw error;
}

/** A turn number from a query value (a positive whole number), else `null`. */
function turnOf(value: unknown): number | null {
  return typeof value === 'string' && /^[1-9]\d{0,8}$/.test(value) ? Number(value) : null;
}

/**
 * D180 · side panel: what each turn changed (`src/core/turn-changes.ts` is the
 * contract). The loopback UI only: the device and the peer listeners serve
 * allow-lists these routes are not on (`src/server/devices/local-only.ts`,
 * `src/server/peers/service.ts`), and an agent of a paired computer answers 409
 * `remote` (its save points are in that computer's repos).
 */
export async function registerTurnChangesRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const service = new TurnChangesService({ store: context.store, env: context.supervisor.environment, ends: context.worktrees.touched });

  app.get<{ Params: IdParams }>('/api/sessions/:id/turn-changes', async (request, reply) => {
    if (isRemoteId(request.params.id)) return refuse(reply, 'remote', 'This agent runs on another computer: see its changes there.');
    try {
      return await service.list(request.params.id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: IdParams; Querystring: DiffQuery }>('/api/sessions/:id/turn-changes/diff', async (request, reply) => {
    if (isRemoteId(request.params.id)) return refuse(reply, 'remote', 'This agent runs on another computer: see its changes there.');
    const from = turnOf(request.query.from);
    const to = request.query.to === undefined ? null : turnOf(request.query.to);
    if (from === null || (request.query.to !== undefined && to === null)) return refuse(reply, 'invalid', 'from (and to, when given) must be a positive whole number');
    try {
      return await service.diff(request.params.id, from, to);
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
