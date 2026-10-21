import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AGENT_SESSION_HEADER } from '../../core/todos.ts';
import { TurnStatusError } from '../sessions/turn-status.ts';
import { toSession } from '../sessions/wire.ts';
import type { ApiContext } from '../routes.ts';

/** The session the agent token was checked for (`security.ts` refused the request without a valid one). */
function agentSession(request: FastifyRequest): string {
  const value = request.headers[AGENT_SESSION_HEADER];
  return typeof value === 'string' ? value : '';
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof TurnStatusError) return reply.code(error.status).send({ error: error.code, message: error.message });
  throw error;
}

/**
 * D124 · how a turn ended (`docs/derivations.md` → *Session status* → *Waiting for you at a turn's
 * end*; contract: *Turn status (D124)* in `docs/handoff/contracts/local-api.md`):
 *
 * - `POST /agent/v1/turn-status` `{ status: 'done' | 'waiting_for_you' | 'blocked', ask? }` → 200
 *   `TurnWait`: the agent's `turn_status` MCP tool, for the session its agent token belongs to
 *   (never one named in the path); 404 `not-found`, 409 `closed`, 422 `invalid`.
 * - `POST /api/sessions/{id}/not-waiting` `{ at? }` → 200 `Session`: the session's **Not waiting**
 *   (a false "needs you" for that turn is cleared; `at` = only that episode's); a peer's session id
 *   is forwarded to its machine like every session route; 404 `not-found`.
 */
export async function registerTurnStatusRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const service = context.supervisor.turnStatus;

  app.post('/agent/v1/turn-status', async (request, reply) => {
    try {
      return await service.declare(agentSession(request), request.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/not-waiting', async (request, reply) => {
    const body = request.body !== null && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    const at = typeof body['at'] === 'string' ? body['at'] : null;
    try {
      const record = await service.notWaiting(request.params.id, at);
      return await toSession(context.store, record, context.supervisor.activity(record.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
