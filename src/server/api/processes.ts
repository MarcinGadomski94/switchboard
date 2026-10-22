import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ProcessesOverview, SessionProcesses } from '../../core/api.ts';
import { type SessionMachine, remoteId } from '../../core/peers.ts';
import { AGENT_SESSION_HEADER } from '../../core/todos.ts';
import { PROCESS_KEEP_REASON_MAX } from '../../core/process-keep.ts';
import { ProcessError } from '../processes/service.ts';
import type { ApiContext } from '../routes.ts';
import { isPeerRequest } from './machines.ts';

/** How long the Processes page waits for each paired machine. */
const PEER_PROCESSES_TIMEOUT_MS = 5_000;

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ProcessError) return reply.code(error.status).send({ error: error.code, message: error.message });
  throw error;
}

/** The session the agent token was checked for (`security.ts` refused the request without a valid one). */
function agentSession(request: FastifyRequest): string {
  const value = request.headers[AGENT_SESSION_HEADER];
  return typeof value === 'string' ? value : '';
}

function pidOf(value: string): number | null {
  return /^[1-9]\d{0,9}$/.test(value) ? Number(value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * D127 · the processes sessions leave running (`docs/processes.md`; contract → *Session
 * processes (D127)* in `docs/handoff/contracts/local-api.md`):
 *
 * - `GET /api/processes[?fresh=1]` → `ProcessesOverview`: every session's processes on this
 *   machine and (not for a peer's own request) each online paired machine's, namespaced.
 * - `GET /api/sessions/{id}/processes[?fresh=1]` → `SessionProcesses`.
 * - `POST /api/sessions/{id}/processes/{pid}/stop` → `SessionProcesses`: Stop (the process
 *   and what runs under it; noted on the session's timeline).
 * - `PUT /api/sessions/{id}/processes/{pid}/keep` `{ keep, reason? }` → `SessionProcesses`.
 * - `POST /agent/v1/processes/keep` `{ pid | match, keep, reason? }` → `{ processes, keep }`: the
 *   agent's `process_keep`, for its own session only.
 *
 * A paired machine's session id is forwarded to its machine like every session route (its
 * processes are listed and stopped there). 404 `not-found`, 422 `invalid`, 503 `unavailable`.
 */
export async function registerProcessRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const service = context.processes;

  app.get<{ Querystring: { fresh?: string } }>('/api/processes', async (request): Promise<ProcessesOverview> => {
    const fresh = request.query.fresh === '1';
    const local = await service.overview({ fresh });
    const sessions: SessionProcesses[] = [...local];
    const unavailable: Array<{ machine: SessionMachine; reason: string }> = [];
    if (!isPeerRequest(request)) {
      for (const answer of await context.peers.fanOutGet(`/api/processes${fresh ? '?fresh=1' : ''}`, { timeoutMs: PEER_PROCESSES_TIMEOUT_MS })) {
        const body = answer.body;
        if (answer.reason !== null || !isRecord(body) || !Array.isArray(body['sessions'])) {
          if (answer.machine.state === 'online') unavailable.push({ machine: answer.machine, reason: answer.reason ?? 'answered something else' });
          continue;
        }
        for (const item of body['sessions']) {
          if (!isRecord(item) || typeof item['sessionId'] !== 'string') continue;
          sessions.push({ ...(item as unknown as SessionProcesses), sessionId: remoteId(answer.machine.id, item['sessionId']), machine: answer.machine });
        }
      }
    }
    sessions.sort((a, b) => b.rssBytes - a.rssBytes);
    return {
      sessions,
      count: sessions.reduce((sum, session) => sum + session.processes.length, 0),
      rssBytes: sessions.reduce((sum, session) => sum + session.rssBytes, 0),
      idleStopMinutes: await service.idleStopMinutes(),
      sampledAt: service.sampledAt,
      ...(unavailable.length > 0 ? { unavailable } : {}),
    };
  });

  app.get<{ Params: { id: string }; Querystring: { fresh?: string } }>('/api/sessions/:id/processes', async (request, reply) => {
    try {
      return await service.forSession(request.params.id, { fresh: request.query.fresh === '1' });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string; pid: string } }>('/api/sessions/:id/processes/:pid/stop', async (request, reply) => {
    const pid = pidOf(request.params.pid);
    if (pid === null) return reply.code(422).send({ error: 'invalid', message: 'not a process id' });
    try {
      return await service.stopOne(request.params.id, pid);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put<{ Params: { id: string; pid: string } }>('/api/sessions/:id/processes/:pid/keep', async (request, reply) => {
    const pid = pidOf(request.params.pid);
    const body = isRecord(request.body) ? request.body : {};
    if (pid === null) return reply.code(422).send({ error: 'invalid', message: 'not a process id' });
    if (typeof body['keep'] !== 'boolean') return reply.code(422).send({ error: 'invalid', message: 'keep must be true or false' });
    const reason = typeof body['reason'] === 'string' ? body['reason'].replace(/\s+/g, ' ').trim() : '';
    if (reason.length > PROCESS_KEEP_REASON_MAX) return reply.code(422).send({ error: 'invalid', message: `reason must be at most ${PROCESS_KEEP_REASON_MAX} characters` });
    try {
      return await service.setKeep(request.params.id, pid, body['keep'], reason || null);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/agent/v1/processes/keep', async (request, reply) => {
    try {
      return await service.agentKeep(agentSession(request), request.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
