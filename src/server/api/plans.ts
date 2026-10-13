import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Plan } from '../../core/plans.ts';
import { AGENT_SESSION_HEADER } from '../../core/todos.ts';
import { PlanError } from '../plans/service.ts';
import { PEER_REQUEST_HEADER } from '../peers/service.ts';
import type { ApiContext } from '../routes.ts';

function sendPlanError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PlanError) return reply.code(error.status).send(error.body());
  throw error;
}

/** The session the agent token was checked for (`security.ts` refused the request without a valid one). */
function agentSession(request: FastifyRequest): string {
  const value = request.headers[AGENT_SESSION_HEADER];
  return typeof value === 'string' ? value : '';
}

function body(request: FastifyRequest): Record<string, unknown> {
  const value = request.body;
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

type Control = 'start' | 'pause' | 'resume' | 'cancel';

/**
 * D99 · Plans (`docs/plans.md`; contract → *Plans (D99)* in `docs/handoff/contracts/local-api.md`).
 *
 * The UI's routes (the `sb_token` cookie; a paired machine's plan id `r~<machine>~<id>` is
 * forwarded to its machine like every `:id` route; item ids stay raw):
 * - `GET /api/plans` → `Plan[]` (this machine's, then the paired machines' as last known);
 *   `POST /api/plans` → 201 `Plan` (a draft); `GET|PUT|DELETE /api/plans/{id}`;
 * - `POST /api/plans/{id}/items` → 201 `{ plan, itemId }`; `PUT|DELETE /api/plans/{id}/items/{itemId}`;
 *   `POST /api/plans/{id}/items/{itemId}/retry | done`;
 * - `POST /api/plans/{id}/edges` `{ from, to }`; `DELETE /api/plans/{id}/edges/{from}/{to}`;
 * - `POST /api/plans/{id}/start` `{ mergeMode }` (required), `…/pause`, `…/resume`, `…/cancel`;
 *   `PUT /api/plans/{id}/mode` `{ mergeMode }`, `PUT /api/plans/{id}/holds` `{ holds }`.
 *
 * The agent's (the `plan_*` MCP tools), only with the session's agent token, over the plans
 * whose source is that session: `GET|POST /agent/v1/plans`, `GET /agent/v1/plans/{planId}`,
 * `POST /agent/v1/plans/{planId}/items | edges | start`.
 */
export async function registerPlanRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const plans = context.plans;

  app.get('/api/plans', async (request): Promise<Plan[]> => [...(await plans.list()), ...(request.headers[PEER_REQUEST_HEADER] !== undefined ? [] : context.peers.remotePlans())]);

  app.post('/api/plans', async (request, reply) => {
    try {
      return reply.code(201).send(await plans.create(request.body));
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/api/plans/:id', async (request, reply) => {
    try {
      return await plans.get(request.params.id);
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });

  app.put<{ Params: { id: string } }>('/api/plans/:id', async (request, reply) => {
    try {
      return await plans.update(request.params.id, request.body);
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/plans/:id', async (request, reply) => {
    try {
      await plans.remove(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/plans/:id/items', async (request, reply) => {
    try {
      return reply.code(201).send(await plans.addItem(request.params.id, request.body, 'developer'));
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });

  app.put<{ Params: { id: string; itemId: string } }>('/api/plans/:id/items/:itemId', async (request, reply) => {
    try {
      return await plans.updateItem(request.params.id, request.params.itemId, request.body);
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });

  app.delete<{ Params: { id: string; itemId: string } }>('/api/plans/:id/items/:itemId', async (request, reply) => {
    try {
      return await plans.removeItem(request.params.id, request.params.itemId);
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });

  for (const action of ['retry', 'done'] as const) {
    app.post<{ Params: { id: string; itemId: string } }>(`/api/plans/:id/items/:itemId/${action}`, async (request, reply) => {
      try {
        return action === 'retry' ? await plans.retryItem(request.params.id, request.params.itemId) : await plans.markItemDone(request.params.id, request.params.itemId);
      } catch (error) {
        return sendPlanError(reply, error);
      }
    });
  }

  app.post<{ Params: { id: string } }>('/api/plans/:id/edges', async (request, reply) => {
    try {
      return await plans.addEdge(request.params.id, request.body);
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });

  app.delete<{ Params: { id: string; from: string; to: string } }>('/api/plans/:id/edges/:from/:to', async (request, reply) => {
    try {
      return await plans.removeEdge(request.params.id, request.params.from, request.params.to);
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });

  const control = (action: Control, planId: string, payload: unknown): Promise<Plan> =>
    action === 'start' ? plans.startPlan(planId, payload) : action === 'pause' ? plans.pause(planId) : action === 'resume' ? plans.resume(planId) : plans.cancel(planId);
  for (const action of ['start', 'pause', 'resume', 'cancel'] as const) {
    app.post<{ Params: { id: string } }>(`/api/plans/:id/${action}`, async (request, reply) => {
      try {
        return await control(action, request.params.id, request.body);
      } catch (error) {
        return sendPlanError(reply, error);
      }
    });
  }

  app.put<{ Params: { id: string } }>('/api/plans/:id/mode', async (request, reply) => {
    try {
      return await plans.setMode(request.params.id, request.body);
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });

  app.put<{ Params: { id: string } }>('/api/plans/:id/holds', async (request, reply) => {
    try {
      return await plans.setHolds(request.params.id, request.body);
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });

  // ── the agent's routes (the `switchboard` MCP helper) ──────────────────

  app.get('/agent/v1/plans', async (request) => plans.listOf(agentSession(request)));

  app.post('/agent/v1/plans', async (request, reply) => {
    try {
      return reply.code(201).send(await plans.create({ ...body(request), sourceSessionId: agentSession(request) }));
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });

  app.get<{ Params: { planId: string } }>('/agent/v1/plans/:planId', async (request, reply) => {
    try {
      await plans.agentPlan(agentSession(request), request.params.planId);
      return await plans.get(request.params.planId);
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });

  app.post<{ Params: { planId: string } }>('/agent/v1/plans/:planId/items', async (request, reply) => {
    try {
      await plans.agentPlan(agentSession(request), request.params.planId);
      return reply.code(201).send(await plans.addItem(request.params.planId, request.body, 'agent'));
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });

  app.post<{ Params: { planId: string } }>('/agent/v1/plans/:planId/edges', async (request, reply) => {
    try {
      await plans.agentPlan(agentSession(request), request.params.planId);
      return await plans.addEdge(request.params.planId, request.body);
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });

  app.post<{ Params: { planId: string } }>('/agent/v1/plans/:planId/start', async (request, reply) => {
    try {
      await plans.agentPlan(agentSession(request), request.params.planId);
      return await plans.startPlan(request.params.planId, request.body);
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });
}
