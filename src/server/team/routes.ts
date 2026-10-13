import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AGENT_SESSION_HEADER } from '../../core/todos.ts';
import { isPeerRequest } from '../api/machines.ts';
import { peerCall } from './peer-call.ts';
import { TeamError, type TeamService } from './service.ts';

/**
 * D100 · Team's routes (contract → *Team (D100)*, `docs/team.md`). While Team is off
 * only `GET /api/team/state` answers (the switch); everything else is 404
 * `team-off`. A paired machine's member is acted on through that machine (the
 * service forwards over the peer API); a request that came in through the peer API
 * is never forwarded again (no chains).
 *
 * Every route is classified for devices (`devices/local-only.ts`) and the ones a
 * paired machine calls are on `PEER_API_ALLOW` (`peers/service.ts`).
 */

function fields(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function send(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof TeamError) return reply.code(error.status).send({ ...(error.body ?? {}), error: error.code, message: error.message });
  throw error;
}

function agentSession(request: FastifyRequest): string {
  const value = request.headers[AGENT_SESSION_HEADER];
  return typeof value === 'string' ? value : '';
}

/** Registers the Team routes (one hook in `app.ts`). */
export async function registerTeamRoutes(app: FastifyInstance, team: TeamService): Promise<void> {
  const run = async <T>(request: FastifyRequest, reply: FastifyReply, work: () => Promise<T>, status = 200): Promise<T | FastifyReply> => {
    try {
      const value = await peerCall.run(isPeerRequest(request), work);
      return status === 200 ? value : reply.code(status).send(value);
    } catch (error) {
      return send(reply, error);
    }
  };

  // The switch (always answered: the sidebar's filter reads it).
  app.get('/api/team/state', async () => team.state());

  app.get('/api/team', (request, reply) => run(request, reply, () => team.view()));
  app.put('/api/team', (request, reply) => run(request, reply, () => team.rename(request.body)));
  // D100 follow-up 2026-10-14: the members' order (synced; phones may reorder).
  app.put('/api/team/order', (request, reply) => run(request, reply, () => team.reorder(fields(request.body))));
  app.get('/api/team/templates', (request, reply) => run(request, reply, async () => team.templates()));
  app.get('/api/team/suggestions', (request, reply) => run(request, reply, () => team.suggestions()));
  app.get<{ Querystring: { before?: string; limit?: string } }>('/api/team/activity', (request, reply) =>
    run(request, reply, async () => team.activity(request.query.before, request.query.limit ? Number(request.query.limit) || 100 : 100)),
  );
  app.get('/api/team/needs-you', (request, reply) => run(request, reply, () => team.needsYou()));

  // Members: adopt (`sessionId`) or create (`session`: a NewSession body).
  app.post('/api/team/members', (request, reply) =>
    run(request, reply, () => {
      const body = fields(request.body);
      if (body['session'] !== undefined && body['sessionId'] === undefined) return team.create(body);
      return team.adopt(body);
    }, 201),
  );
  app.get<{ Params: { memberId: string } }>('/api/team/members/:memberId', (request, reply) => run(request, reply, () => team.member(request.params.memberId)));
  app.put<{ Params: { memberId: string } }>('/api/team/members/:memberId', (request, reply) => run(request, reply, () => team.update(request.params.memberId, fields(request.body))));
  app.delete<{ Params: { memberId: string } }>('/api/team/members/:memberId', (request, reply) =>
    run(request, reply, async () => {
      await team.remove(request.params.memberId);
      return { ok: true };
    }),
  );
  app.post<{ Params: { memberId: string } }>('/api/team/members/:memberId/pause', (request, reply) => run(request, reply, () => team.pause(request.params.memberId)));
  app.post<{ Params: { memberId: string } }>('/api/team/members/:memberId/resume', (request, reply) => run(request, reply, () => team.resume(request.params.memberId)));
  app.post<{ Params: { memberId: string } }>('/api/team/members/:memberId/return', (request, reply) => run(request, reply, () => team.returnMember(request.params.memberId)));
  app.post<{ Params: { memberId: string } }>('/api/team/members/:memberId/move/check', (request, reply) => run(request, reply, () => team.moveCheck(request.params.memberId, fields(request.body))));
  app.post<{ Params: { memberId: string } }>('/api/team/members/:memberId/move', (request, reply) => run(request, reply, () => team.move(request.params.memberId, fields(request.body)), 202));
  app.get<{ Params: { runId: string } }>('/api/team/moves/:runId', (request, reply) => run(request, reply, () => team.moveRun(request.params.runId)));

  // Hand-offs from the developer, and their state.
  app.post('/api/team/handoffs', (request, reply) =>
    run(request, reply, () => {
      const body = fields(request.body);
      const from = typeof body['from'] === 'string' && body['from'] !== '' ? body['from'] : null;
      return team.createHandoff({ from, to: String(body['to'] ?? ''), brief: body['brief'], expected: body['expected'], links: body['links'], planRef: body['planRef'] });
    }, 201),
  );
  app.put<{ Params: { handoffId: string } }>('/api/team/handoffs/:handoffId', (request, reply) => run(request, reply, () => team.setHandoffState(request.params.handoffId, fields(request.body))));

  // Needs-you requests: approve (runs the action), decline, dismiss.
  for (const decision of ['approve', 'decline', 'dismiss'] as const) {
    app.post<{ Params: { requestId: string } }>(`/api/team/requests/:requestId/${decision}`, (request, reply) => run(request, reply, () => team.decide(request.params.requestId, decision)));
  }

  // The exchange of a paired machine (its records in, this machine's out).
  app.post('/api/team/sync', (request, reply) =>
    run(request, reply, async () => {
      if (isPeerRequest(request) && !(await team.receive(request.body))) throw new TeamError(422, 'invalid', 'not a team sync message');
      return team.message();
    }),
  );

  // ── the agent's side (the `switchboard` MCP helper; only member sessions, only while Team is on) ──

  const memberOnly = (request: FastifyRequest): string => {
    const session = agentSession(request);
    if (!team.memberOfSession(session)) throw new TeamError(404, 'not-a-member', 'this session is not a team member (or Team is off)');
    return session;
  };

  app.get('/agent/v1/team', (request, reply) =>
    run(request, reply, async () => {
      const member = team.memberOfSession(memberOnly(request));
      return { member: member ? { id: member.id, name: member.name } : null };
    }),
  );
  app.get('/agent/v1/team/members', (request, reply) => run(request, reply, async () => ({ text: await team.membersText(memberOnly(request)) })));
  app.post('/agent/v1/team/handoffs', (request, reply) =>
    run(request, reply, async () => {
      const session = memberOnly(request);
      const me = team.memberOfSession(session);
      const body = fields(request.body);
      return team.createHandoff({ from: me?.id ?? null, to: String(body['to'] ?? ''), brief: body['brief'], expected: body['expected'], links: body['links'] });
    }, 201),
  );
  app.post('/agent/v1/team/reports', (request, reply) =>
    run(request, reply, async () => {
      await team.report(memberOnly(request), fields(request.body)['text']);
      return { ok: true };
    }, 201),
  );
}
