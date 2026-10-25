import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AGENT_SESSION_HEADER } from '../../../core/todos.ts';
import { PlanError } from '../service.ts';
import { JiraError } from './client.ts';
import { JiraCredentialError, type JiraCredentialSource } from './credentials.ts';
import { PlanJiraError, fromJiraError, plansOff, type PlanJiraService } from './service.ts';

/** Maps the lane's errors to their answers (anything else is a 500 the app logs). */
function send(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PlanJiraError || error instanceof PlanError) return reply.code(error.status).send(error.body());
  if (error instanceof JiraCredentialError) return reply.code(error.status).send(error.field !== null ? { error: error.code, message: error.message, errors: [{ field: error.field, message: error.message }] } : { error: error.code, message: error.message });
  if (error instanceof JiraError) {
    const mapped = fromJiraError(error);
    return reply.code(mapped.status).send(mapped.body());
  }
  throw error;
}

/** Every route of the lane, `[method, url]` (the device and peer classification tests read it). */
export const PLAN_JIRA_ROUTES: ReadonlyArray<readonly [method: string, url: string]> = [
  ['GET', '/api/integrations/jira'],
  ['PUT', '/api/integrations/jira'],
  ['DELETE', '/api/integrations/jira'],
  ['POST', '/api/sessions/:id/plans/jira/preview'],
  ['POST', '/api/sessions/:id/plans/jira/import'],
  ['POST', '/api/plans/jira/preview'],
  ['POST', '/api/plans/jira/import'],
  ['GET', '/api/plans/:id/jira'],
  ['PUT', '/api/plans/:id/jira'],
  ['POST', '/api/plans/:id/jira/refresh'],
  ['POST', '/api/plans/:id/jira/dependencies'],
  ['GET', '/api/plans/:id/proposals'],
  ['POST', '/api/plans/:id/proposals/ask'],
  ['POST', '/api/plans/:id/solutions/ask'],
  ['POST', '/api/plans/:id/proposals/accept-all'],
  ['POST', '/api/plans/:id/proposals/reject-all'],
  ['POST', '/api/plans/:id/proposals/:proposalId/accept'],
  ['POST', '/api/plans/:id/proposals/:proposalId/reject'],
];

/** The agent's route (the `plan_propose_dependencies` tool; the session's agent token, checked by `security.ts`). */
export const PLAN_PROPOSE_AGENT_ROUTE = '/agent/v1/plans/:planId/proposals';

/** D118: the agent's routes of the `plan_jira_context` tool (read-only; the session's agent token). */
export const PLAN_JIRA_CONTEXT_AGENT_ROUTE = '/agent/v1/plans/:planId/jira/context';
/** D118: the same without a plan id: the run session's own plan and item. */
export const PLAN_JIRA_CONTEXT_OWN_ROUTE = '/agent/v1/plans/jira/context';

function agentSession(request: FastifyRequest): string {
  const value = request.headers[AGENT_SESSION_HEADER];
  return typeof value === 'string' ? value : '';
}

/**
 * D99 · Plans · Jira (contract → *Plans · Jira (D99)*). Every route answers 503
 * `plans-unavailable` while `plans.db` is broken (D132: no off-switch since 2.0).
 *
 * - `GET|PUT|DELETE /api/integrations/jira`: Settings → Integrations → Jira (status; save
 *   base URL, email and API token to the OS keychain; remove them). **This machine's UI only**:
 *   refused to phones (D73) and not on the peer allow-list. The token is never answered.
 * - `POST /api/sessions/{id}/plans/jira/preview` `{ epic }` → {@link JiraPreview}; nothing is created.
 * - `POST /api/sessions/{id}/plans/jira/import` `{ epic, targetBranch, title?, baseBranch?, repos?,
 *   maxConcurrency?, sync?, transitions?, doneOnMerge? }` → 201 `{ plan, jira, preview }` (a draft plan).
 * - D112: `POST /api/plans/jira/preview` `{ epic }` (no session: an import from a folder) and
 *   `POST /api/plans/jira/import` (the import's body plus `folder`, `provider?`, `model?`,
 *   `effort?`, `profileId?`, `repos?`) → 201 `{ plan, jira, preview, askedForOrder, askedForRepos, session }`:
 *   a new session "Plan · <plan title>" (the epic summary when the plan
 *   title is empty) in that folder owns the plan. D115: a workspace's `repos` are optional;
 *   without them the plan's agent is asked to pick each item's repositories (`askedForRepos`). On a paired machine both go
 *   through `/api/machines/{id}/api/plans/jira/…` and run there.
 * - `GET|PUT /api/plans/{id}/jira` (`{ sync?, transitions?, doneOnMerge? }`) → `PlanJiraState`;
 *   `POST /api/plans/{id}/jira/refresh` → `PlanJiraState`.
 * - D117: `POST /api/plans/{id}/jira/dependencies` `{ apply?, fingerprint? }` → `JiraRelinkDiff`
 *   (Re-read dependencies from Jira on a draft: the change, then `apply: true` makes it; 409
 *   `not-draft` once started, 409 `changed` for a stale fingerprint).
 *
 * - Proposed order (D99-Jira-q1): `GET /api/plans/{id}/proposals` → `PlanEdgeProposal[]`;
 *   `POST /api/plans/{id}/proposals/ask` (Propose order: the source session is asked; a draft);
 *   `POST /api/plans/{id}/proposals/{proposalId}/accept | reject`, `…/proposals/accept-all | reject-all`
 *   → `{ proposals, refused }` (a single refused Accept: 409 `cycle`); the agent's
 *   `POST /agent/v1/plans/{planId}/proposals` `{ proposals: [{ from, to, reason }] }` → 201 `{ added, skipped }`.
 * - D118: the agent's `GET /agent/v1/plans/{planId}/jira/context?item=&part=` and
 *   `GET /agent/v1/plans/jira/context?item=&part=` (a run session's own plan) → `{ planId, epicKey, item, text }`
 *   (the `plan_jira_context` tool: read from Jira now; the plan's source or item run sessions only).
 * - D115: `POST /api/plans/{id}/solutions/ask` (Ask again: the plan's agent picks the repositories
 *   of the items without any) → `{ asked, sessionId, items }`; 409 `nothing-to-pick` / `not-sent`.
 *
 * A session's or a plan's remote id (`r~<machine>~<id>`) is forwarded to that machine by the
 * peers' proxy like every `:id` route: import and sync run on the machine that owns the plan,
 * with that machine's credentials.
 */
export async function registerPlanJiraRoutes(
  app: FastifyInstance,
  jira: PlanJiraService,
  credentials: JiraCredentialSource,
  enabled: () => boolean | Promise<boolean>,
  /** D112: the API's `Session` of the session an import from a folder created (`null` when it is gone). */
  sessionView: (sessionId: string) => Promise<unknown> = async () => null,
): Promise<void> {
  const gate = async (): Promise<void> => {
    if (!(await enabled())) throw plansOff();
  };

  app.get('/api/integrations/jira', async (_request, reply) => {
    try {
      await gate();
      return await credentials.status();
    } catch (error) {
      return send(reply, error);
    }
  });

  app.put('/api/integrations/jira', async (request, reply) => {
    try {
      await gate();
      return await credentials.save(request.body);
    } catch (error) {
      return send(reply, error);
    }
  });

  app.delete('/api/integrations/jira', async (_request, reply) => {
    try {
      await gate();
      return await credentials.clear();
    } catch (error) {
      return send(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/plans/jira/preview', async (request, reply) => {
    try {
      return await jira.preview(request.params.id, request.body);
    } catch (error) {
      return send(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/plans/jira/import', async (request, reply) => {
    try {
      return reply.code(201).send(await jira.importPlan(request.params.id, request.body));
    } catch (error) {
      return send(reply, error);
    }
  });

  // D112: an import from a folder (no session yet); the new session's view comes from `sessionView`.
  app.post('/api/plans/jira/preview', async (request, reply) => {
    try {
      return await jira.preview(null, request.body);
    } catch (error) {
      return send(reply, error);
    }
  });

  app.post('/api/plans/jira/import', async (request, reply) => {
    try {
      const { sessionId, ...result } = await jira.importIntoNewSession(request.body);
      return reply.code(201).send({ ...result, session: await sessionView(sessionId) });
    } catch (error) {
      return send(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/api/plans/:id/jira', async (request, reply) => {
    try {
      return await jira.state(request.params.id);
    } catch (error) {
      return send(reply, error);
    }
  });

  app.put<{ Params: { id: string } }>('/api/plans/:id/jira', async (request, reply) => {
    try {
      return await jira.update(request.params.id, request.body);
    } catch (error) {
      return send(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/plans/:id/jira/refresh', async (request, reply) => {
    try {
      return await jira.refreshNow(request.params.id);
    } catch (error) {
      return send(reply, error);
    }
  });

  // D117: Re-read dependencies from Jira (a draft; a read of Jira).
  app.post<{ Params: { id: string } }>('/api/plans/:id/jira/dependencies', async (request, reply) => {
    try {
      return await jira.rereadDependencies(request.params.id, request.body);
    } catch (error) {
      return send(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/api/plans/:id/proposals', async (request, reply) => {
    try {
      return await jira.proposals(request.params.id);
    } catch (error) {
      return send(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/plans/:id/proposals/ask', async (request, reply) => {
    try {
      return await jira.askForOrder(request.params.id);
    } catch (error) {
      return send(reply, error);
    }
  });

  // D115: Ask again: the plan's agent picks the repositories of the items that have none.
  app.post<{ Params: { id: string } }>('/api/plans/:id/solutions/ask', async (request, reply) => {
    try {
      return await jira.askForRepos(request.params.id);
    } catch (error) {
      return send(reply, error);
    }
  });

  for (const action of ['accept', 'reject'] as const) {
    app.post<{ Params: { id: string } }>(`/api/plans/:id/proposals/${action}-all`, async (request, reply) => {
      try {
        return await jira.decide(request.params.id, null, action);
      } catch (error) {
        return send(reply, error);
      }
    });
    app.post<{ Params: { id: string; proposalId: string } }>(`/api/plans/:id/proposals/:proposalId/${action}`, async (request, reply) => {
      try {
        return await jira.decide(request.params.id, request.params.proposalId, action);
      } catch (error) {
        return send(reply, error);
      }
    });
  }

  // D131 lane P: the v2 project page's "From Jira": the same D118 context, read now, for the developer (a read of Jira).
  app.get<{ Params: { id: string }; Querystring: { item?: string; part?: string } }>('/api/plans/:id/jira/context', async (request, reply) => {
    try {
      return await jira.developerContext(request.params.id, request.query ?? {});
    } catch (error) {
      return send(reply, error);
    }
  });

  // D118: the plan_jira_context tool: the plan's source session or one of its item run sessions.
  app.get<{ Querystring: { item?: string; part?: string } }>(PLAN_JIRA_CONTEXT_OWN_ROUTE, async (request, reply) => {
    try {
      return await jira.agentContext(agentSession(request), null, request.query ?? {});
    } catch (error) {
      return send(reply, error);
    }
  });
  app.get<{ Params: { planId: string }; Querystring: { item?: string; part?: string } }>(PLAN_JIRA_CONTEXT_AGENT_ROUTE, async (request, reply) => {
    try {
      return await jira.agentContext(agentSession(request), request.params.planId, request.query ?? {});
    } catch (error) {
      return send(reply, error);
    }
  });

  app.post<{ Params: { planId: string } }>(PLAN_PROPOSE_AGENT_ROUTE, async (request, reply) => {
    try {
      return reply.code(201).send(await jira.propose(agentSession(request), request.params.planId, request.body));
    } catch (error) {
      return send(reply, error);
    }
  });
}
