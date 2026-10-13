import type { FastifyInstance, FastifyReply } from 'fastify';
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
  ['GET', '/api/plans/:id/jira'],
  ['PUT', '/api/plans/:id/jira'],
  ['POST', '/api/plans/:id/jira/refresh'],
];

/**
 * D99 · Plans · Jira (contract → *Plans · Jira (D99)*). Every route answers 404 `plans-off`
 * while Plans is off.
 *
 * - `GET|PUT|DELETE /api/integrations/jira`: Settings → Integrations → Jira (status; save
 *   base URL, email and API token to the OS keychain; remove them). **This machine's UI only**:
 *   refused to phones (D73) and not on the peer allow-list. The token is never answered.
 * - `POST /api/sessions/{id}/plans/jira/preview` `{ epic }` → {@link JiraPreview}; nothing is created.
 * - `POST /api/sessions/{id}/plans/jira/import` `{ epic, targetBranch, title?, baseBranch?, repos?,
 *   maxConcurrency?, sync?, transitions? }` → 201 `{ plan, jira, preview }` (a draft plan).
 * - `GET|PUT /api/plans/{id}/jira` (`{ sync?, transitions? }`) → `PlanJiraState`;
 *   `POST /api/plans/{id}/jira/refresh` → `PlanJiraState`.
 *
 * A session's or a plan's remote id (`r~<machine>~<id>`) is forwarded to that machine by the
 * peers' proxy like every `:id` route: import and sync run on the machine that owns the plan,
 * with that machine's credentials.
 */
export async function registerPlanJiraRoutes(app: FastifyInstance, jira: PlanJiraService, credentials: JiraCredentialSource, enabled: () => boolean | Promise<boolean>): Promise<void> {
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
}
