import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ACCESS_CATALOG } from '../../../core/team-access-catalog.ts';
import { AGENT_SESSION_HEADER } from '../../../core/todos.ts';
import { isDeviceRequest } from '../../devices/mark.ts';
import { isPeerRequest } from '../../api/machines.ts';
import { TeamError, type TeamService } from '../service.ts';
import { TeamAccess } from './service.ts';

/**
 * D100-T2 · the access routes (contract → *Team access (D100-T2)*). Reads answer on
 * every machine (the records are synced); everything that touches a value (setup,
 * test, revoke, the expiry) runs on **this** machine with **its** keychain, is
 * refused for paired phones (D73: "set this up on a computer") and is not on the
 * peer API (values never travel). The agent's side is `request_access` and the
 * access launcher's `…/launch`.
 */

function fields(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function agentSession(request: FastifyRequest): string {
  const value = request.headers[AGENT_SESSION_HEADER];
  return typeof value === 'string' ? value : '';
}

/** Registers the access routes (from `installTeam`). */
export async function registerAccessRoutes(app: FastifyInstance, team: TeamService): Promise<void> {
  const run = async <T>(reply: FastifyReply, work: () => Promise<T>, status = 200): Promise<T | FastifyReply> => {
    try {
      const value = await work();
      return status === 200 ? value : reply.code(status).send(value);
    } catch (error) {
      if (error instanceof TeamError) return reply.code(error.status).send({ ...(error.body ?? {}), error: error.code, message: error.message });
      throw error;
    }
  };

  /** Values are entered and used on a computer only (D73), and never through a paired machine (D48). */
  const computerOnly = (request: FastifyRequest): void => {
    if (isDeviceRequest(request.raw)) throw new TeamError(403, 'local-only', 'Set this up on a computer: secrets are never typed on a phone.');
    if (isPeerRequest(request)) throw new TeamError(403, 'local-only', 'Access values never travel between machines: set it up on that machine.');
  };

  app.get<{ Params: { memberId: string } }>('/api/team/members/:memberId/access', (request, reply) =>
    run(reply, () => team.access.view(request.params.memberId, { device: isDeviceRequest(request.raw) })),
  );
  app.get<{ Params: { memberId: string } }>('/api/team/members/:memberId/access/shareable', (request, reply) =>
    run(reply, () => team.access.shareable(request.params.memberId)),
  );
  app.get('/api/team/access/catalog', (_request, reply) =>
    run(reply, async () => {
      team.access.assertOn();
      return ACCESS_CATALOG;
    }),
  );
  app.post<{ Params: { accessId: string } }>('/api/team/access/:accessId/setup', (request, reply) =>
    run(reply, async () => {
      computerOnly(request);
      return team.access.setUp(request.params.accessId, fields(request.body));
    }),
  );
  app.post<{ Params: { accessId: string } }>('/api/team/access/:accessId/test', (request, reply) =>
    run(reply, async () => {
      computerOnly(request);
      return team.access.test(request.params.accessId);
    }),
  );
  app.post<{ Params: { accessId: string } }>('/api/team/access/:accessId/revoke', (request, reply) =>
    run(reply, async () => {
      computerOnly(request);
      return team.access.revoke(request.params.accessId);
    }),
  );
  app.put<{ Params: { accessId: string } }>('/api/team/access/:accessId', (request, reply) =>
    run(reply, async () => {
      computerOnly(request);
      return team.access.setExpiry(request.params.accessId, fields(request.body));
    }),
  );

  // ── the agent's side ──

  app.post('/agent/v1/team/access', (request, reply) =>
    run(
      reply,
      async () => {
        const outcome = await team.access.request(agentSession(request), request.body);
        return { text: TeamAccess.agentAnswer(outcome), access: { id: outcome.access.id, service: outcome.access.service, host: outcome.access.host, status: outcome.access.status } };
      },
      201,
    ),
  );
  app.get<{ Params: { accessId: string } }>('/agent/v1/team/access/:accessId/launch', (request, reply) =>
    run(reply, () => team.access.launchFor(agentSession(request), request.params.accessId)),
  );
}
