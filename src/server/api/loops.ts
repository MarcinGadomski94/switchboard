import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AGENT_SESSION_HEADER } from '../../core/todos.ts';
import { LoopError } from '../loops/owned.ts';
import type { ApiContext } from '../routes.ts';

function sendLoopError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof LoopError) return reply.code(error.status).send(error.body());
  throw error;
}

/** The session the agent token was checked for (`security.ts` refused the request without a valid one). */
function agentSession(request: FastifyRequest): string {
  const value = request.headers[AGENT_SESSION_HEADER];
  return typeof value === 'string' ? value : '';
}

type Action = 'pause' | 'resume' | 'run';

/**
 * D94 · Switchboard-owned loops (`docs/loops.md`; contract: *Switchboard loops (D94)*
 * in `docs/handoff/contracts/local-api.md`):
 *
 * - The UI's (a peer's session id `r~<machine>~<id>` is forwarded to its machine like
 *   every session route; the loop id stays raw): `GET /api/sessions/{id}/loops` →
 *   `OwnedLoop[]`; `POST …/loops` `OwnedLoopInput` → 201 `OwnedLoop` (made by the
 *   developer); `PUT …/loops/{loopId}` → `OwnedLoop`; `POST …/loops/{loopId}/pause |
 *   resume | run` → `OwnedLoop`; `DELETE …/loops/{loopId}` → 204 (Cancel).
 * - The agent's (the `loop_*` MCP tools), only with the session's agent token: `GET
 *   /agent/v1/loops`, `POST /agent/v1/loops`, `PUT /agent/v1/loops/{loopId}`, `POST
 *   /agent/v1/loops/{loopId}/pause | resume`, `DELETE /agent/v1/loops/{loopId}`: the
 *   session is the one the token belongs to, never one named in the path; a loop of
 *   another session is not found.
 *
 * Refusals: 404 `not-found`, 409 `closed` / `ended` / `pending` / `unavailable` /
 * `too-many`, 422 `invalid` (with `errors`).
 */
export async function registerLoopRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const loops = context.loops;

  app.get<{ Params: { id: string } }>('/api/sessions/:id/loops', async (request, reply) => {
    try {
      return await loops.list(request.params.id);
    } catch (error) {
      return sendLoopError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/loops', async (request, reply) => {
    try {
      return reply.code(201).send(await loops.create(request.params.id, request.body, 'developer'));
    } catch (error) {
      return sendLoopError(reply, error);
    }
  });

  app.put<{ Params: { id: string; loopId: string } }>('/api/sessions/:id/loops/:loopId', async (request, reply) => {
    try {
      return await loops.update(request.params.id, request.params.loopId, request.body);
    } catch (error) {
      return sendLoopError(reply, error);
    }
  });

  const act = (action: Action, sessionId: string, loopId: string) =>
    action === 'pause' ? loops.pause(sessionId, loopId) : action === 'resume' ? loops.resume(sessionId, loopId) : loops.runNow(sessionId, loopId);
  for (const action of ['pause', 'resume', 'run'] as const) {
    app.post<{ Params: { id: string; loopId: string } }>(`/api/sessions/:id/loops/:loopId/${action}`, async (request, reply) => {
      try {
        return await act(action, request.params.id, request.params.loopId);
      } catch (error) {
        return sendLoopError(reply, error);
      }
    });
  }

  app.delete<{ Params: { id: string; loopId: string } }>('/api/sessions/:id/loops/:loopId', async (request, reply) => {
    try {
      await loops.cancel(request.params.id, request.params.loopId);
      return reply.code(204).send();
    } catch (error) {
      return sendLoopError(reply, error);
    }
  });

  // ── the agent's routes (the `switchboard` MCP helper's loop_* tools) ──

  app.get('/agent/v1/loops', async (request, reply) => {
    try {
      return await loops.list(agentSession(request));
    } catch (error) {
      return sendLoopError(reply, error);
    }
  });

  app.post('/agent/v1/loops', async (request, reply) => {
    try {
      return reply.code(201).send(await loops.create(agentSession(request), request.body, 'agent'));
    } catch (error) {
      return sendLoopError(reply, error);
    }
  });

  app.put<{ Params: { loopId: string } }>('/agent/v1/loops/:loopId', async (request, reply) => {
    try {
      return await loops.update(agentSession(request), request.params.loopId, request.body);
    } catch (error) {
      return sendLoopError(reply, error);
    }
  });

  for (const action of ['pause', 'resume'] as const) {
    app.post<{ Params: { loopId: string } }>(`/agent/v1/loops/:loopId/${action}`, async (request, reply) => {
      try {
        return await act(action, agentSession(request), request.params.loopId);
      } catch (error) {
        return sendLoopError(reply, error);
      }
    });
  }

  app.delete<{ Params: { loopId: string } }>('/agent/v1/loops/:loopId', async (request, reply) => {
    try {
      await loops.cancel(agentSession(request), request.params.loopId);
      return reply.code(204).send();
    } catch (error) {
      return sendLoopError(reply, error);
    }
  });
}
