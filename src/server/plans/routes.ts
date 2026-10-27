import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Plan } from '../../core/plans.ts';
import { AGENT_SESSION_HEADER } from '../../core/todos.ts';
import { PEER_REQUEST_HEADER } from '../peers/service.ts';
import type { ApiContext } from '../routes.ts';
import { PlanError, type PlanService } from './service.ts';

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
 *   `POST /api/plans` → 201 `Plan` (a draft); `GET|PUT|DELETE /api/plans/{id}` (D117 follow-up: `DELETE …?stop=1`
 *   cancels a running or paused plan and stops its running item sessions first, → 200 `{ cancelled, stopped }`);
 * - `POST /api/plans/{id}/items` → 201 `{ plan, itemId }`; `PUT|DELETE /api/plans/{id}/items/{itemId}`;
 *   `POST /api/plans/{id}/items/{itemId}/retry | done | reopen` (D121) | `restart` (D139); `POST /api/plans/{id}/restart-stopped` (D139); D102, the Merge step of a ready-to-merge item:
 *   `POST /api/plans/{id}/items/{itemId}/merge | open-pr | send-back` (`{ comment }`);
 * - `POST /api/plans/{id}/edges` `{ from, to }`; `DELETE /api/plans/{id}/edges/{from}/{to}`;
 * - `POST /api/plans/{id}/start` `{ mergeMode }` (required), `…/pause`, `…/resume`, `…/cancel`;
 *   `PUT /api/plans/{id}/mode` `{ mergeMode }`, `PUT /api/plans/{id}/holds` `{ holds }`.
 *
 * The agent's (the `plan_*` MCP tools), only with the session's agent token, over the plans
 * whose source is that session: `GET|POST /agent/v1/plans`, `GET /agent/v1/plans/{planId}`,
 * `POST /agent/v1/plans/{planId}/items | edges | start`; D115: `POST /agent/v1/plans/{planId}/solutions`
 * `{ items: [{ item, solutions }] }` → `{ plan, set }`. D129: `PUT|DELETE /agent/v1/plans/{planId}/items/{item}`
 * (`item` an id or a key), `DELETE /agent/v1/plans/{planId}/edges/{from}/{to}`, `PUT /agent/v1/plans/{planId}/mode`:
 * the developer's `updateItem` (as the agent), `removeItem`, `removeEdge` and `setMode`. D115 follow-ups: in a plan whose repositories
 * are picked per item, `POST /agent/v1/plans` and an item added without solutions also answer
 * `solutionChoices` (the workspace's writable solutions).
 *
 * D132: always on since 2.0 (no switch; `GET /api/plans/state` answers `enabled: true`); while
 * `plans.db` is broken, every route but the state answers 503 `plans-unavailable`. Registered by `installPlans` (`install.ts`), the one hook in `app.ts`.
 */
export async function registerPlanRoutes(app: FastifyInstance, plans: PlanService, context: Pick<ApiContext, 'peers'>): Promise<void> {
  // The state (always answered: the Plans page reads it; `enabled` is always true since D132).
  app.get('/api/plans/state', async () => plans.state());

  app.get('/api/plans', async (request, reply) => {
    try {
      const own: Plan[] = await plans.list();
      return [...own, ...(request.headers[PEER_REQUEST_HEADER] !== undefined ? [] : context.peers.remotePlans())];
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });

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

  // D117 follow-up: `?stop=1` cancels a running or paused plan, stops its running item sessions, then deletes (200 `PlanDeleteResult`); plain DELETE is unchanged (204).
  app.delete<{ Params: { id: string }; Querystring: { stop?: string } }>('/api/plans/:id', async (request, reply) => {
    try {
      const stop = request.query.stop === '1' || request.query.stop === 'true';
      const result = await plans.remove(request.params.id, { stop });
      if (stop) return reply.code(200).send(result);
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

  // D121: reopen a done item (a running or paused plan). D139: restart a stopped item (its run session failed).
  for (const action of ['retry', 'restart', 'done', 'reopen'] as const) {
    app.post<{ Params: { id: string; itemId: string } }>(`/api/plans/:id/items/:itemId/${action}`, async (request, reply) => {
      try {
        if (action === 'reopen') return await plans.reopenItem(request.params.id, request.params.itemId);
        if (action === 'restart') return await plans.restartItem(request.params.id, request.params.itemId);
        return action === 'retry' ? await plans.retryItem(request.params.id, request.params.itemId) : await plans.markItemDone(request.params.id, request.params.itemId);
      } catch (error) {
        return sendPlanError(reply, error);
      }
    });
  }

  // D139: every stopped step of a plan starts again → `{ plan, restarted, waiting }`.
  app.post<{ Params: { id: string } }>('/api/plans/:id/restart-stopped', async (request, reply) => {
    try {
      return await plans.restartStopped(request.params.id);
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });

  // D102: the developer's Merge step (merge locally into the target, open a PR, send it back).
  for (const action of ['merge', 'open-pr', 'send-back'] as const) {
    app.post<{ Params: { id: string; itemId: string } }>(`/api/plans/:id/items/:itemId/${action}`, async (request, reply) => {
      const { id, itemId } = request.params;
      try {
        if (action === 'merge') return await plans.mergeItem(id, itemId);
        if (action === 'open-pr') return await plans.openItemPullRequest(id, itemId);
        return await plans.sendBackItem(id, itemId, body(request));
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

  app.get('/agent/v1/plans', async (request, reply) => {
    try {
      return await plans.listOf(agentSession(request));
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });

  app.post('/agent/v1/plans', async (request, reply) => {
    try {
      const plan = await plans.create({ ...body(request), sourceSessionId: agentSession(request) });
      // D115 follow-ups: a plan whose agent picks each item's repositories names the workspace's solutions (the tool's answer tells the agent).
      return reply.code(201).send(plan.reposPerItem === true ? { ...plan, solutionChoices: await plans.solutionChoices(plan.id) } : plan);
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
      const added = await plans.addItem(request.params.planId, request.body, 'agent');
      // D115 follow-ups: an item added without repositories in such a plan: the answer names the solutions to pick from.
      const item = added.plan.items.find((candidate) => candidate.id === added.itemId);
      const waits = added.plan.reposPerItem === true && item !== undefined && item.solutions.length === 0;
      return reply.code(201).send(waits ? { ...added, solutionChoices: await plans.solutionChoices(request.params.planId) } : added);
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

  // D115: the plan's agent picks its items' repositories (the `plan_set_solutions` tool), applied at once.
  app.post<{ Params: { planId: string } }>('/agent/v1/plans/:planId/solutions', async (request, reply) => {
    try {
      await plans.agentPlan(agentSession(request), request.params.planId);
      return await plans.setSolutions(request.params.planId, request.body);
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

  // D129: the agent edits items already in its plan through the developer's service methods (the same checks and refusals).
  app.put<{ Params: { planId: string; item: string } }>('/agent/v1/plans/:planId/items/:item', async (request, reply) => {
    try {
      await plans.agentPlan(agentSession(request), request.params.planId);
      const itemId = await plans.resolveItem(request.params.planId, request.params.item);
      return await plans.updateItem(request.params.planId, itemId, request.body, 'agent');
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });

  app.delete<{ Params: { planId: string; item: string } }>('/agent/v1/plans/:planId/items/:item', async (request, reply) => {
    try {
      await plans.agentPlan(agentSession(request), request.params.planId);
      return await plans.removeItem(request.params.planId, await plans.resolveItem(request.params.planId, request.params.item));
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });

  app.delete<{ Params: { planId: string; from: string; to: string } }>('/agent/v1/plans/:planId/edges/:from/:to', async (request, reply) => {
    try {
      await plans.agentPlan(agentSession(request), request.params.planId);
      return await plans.removeEdge(request.params.planId, request.params.from, request.params.to);
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });

  app.put<{ Params: { planId: string } }>('/agent/v1/plans/:planId/mode', async (request, reply) => {
    try {
      await plans.agentPlan(agentSession(request), request.params.planId);
      return await plans.setMode(request.params.planId, request.body);
    } catch (error) {
      return sendPlanError(reply, error);
    }
  });
}
