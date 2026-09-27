import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ResumeCommand, Session, SessionDetail, SessionEvent } from '../../core/api.ts';
import type { ApiContext } from '../routes.ts';
import { toEvent, toSession, toSessionDetail } from '../sessions/wire.ts';
import { validateNewSession } from '../sessions/validate.ts';
import { SupervisorError, type SupervisorErrorCode } from '../supervisor/supervisor.ts';
import { type PendingRoute, registerPending } from './not-implemented.ts';

/** Session routes (contract → REST, `/api/sessions*`) not implemented yet. */
export const SESSION_ROUTES_PENDING: readonly PendingRoute[] = [{ method: 'GET', url: '/api/sessions/:id/diff', item: 'M4.5' }];

/** HTTP status of each supervisor refusal. */
const ERROR_STATUS: Record<SupervisorErrorCode, number> = {
  'not-found': 404,
  'workspace-not-configured': 409,
  'workspace-missing': 409,
  detached: 409,
  'already-running': 409,
  'request-not-open': 409,
  closing: 503,
};

interface IdParams {
  readonly id: string;
}

/** Sends a supervisor refusal as `{ error: <code>, message }`, rethrows anything else. */
function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof SupervisorError) {
    return reply.code(ERROR_STATUS[error.code]).send({ error: error.code, message: error.message });
  }
  throw error;
}

function notFound(reply: FastifyReply, id: string): FastifyReply {
  return reply.code(404).send({ error: 'not-found', message: `no session ${id}` });
}

/**
 * Registers the session routes (M2.1: the supervisor's layer; M4.x / M5.x add to
 * the UI side, M4.5 the diff). Every route sits behind the security guard.
 */
export async function registerSessionRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { store, supervisor, providers } = context;

  app.get('/api/sessions', async (): Promise<Session[]> => {
    const records = await store.sessions.list();
    return Promise.all(records.map((record) => toSession(store, record)));
  });

  app.post('/api/sessions', async (request, reply) => {
    const readOnly = providers.solutions
      ? async (solution: string): Promise<boolean> => {
          const groups = await providers.solutions?.solutions();
          return (groups ?? []).some((group) => group.solutions.some((s) => s.name === solution && s.rule === 'read-only'));
        }
      : undefined;
    const result = await validateNewSession(request.body, {
      nameTaken: async (name) => (await store.sessions.getByName(name)) !== null,
      ...(readOnly ? { readOnly } : {}),
    });
    if (!result.ok) return reply.code(422).send({ error: 'invalid', errors: result.errors });
    try {
      const record = await supervisor.start(result.value);
      return reply.code(201).send(await toSession(store, record));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: IdParams }>('/api/sessions/:id', async (request, reply): Promise<SessionDetail | FastifyReply> => {
    const record = await store.sessions.get(request.params.id);
    if (!record) return notFound(reply, request.params.id);
    return toSessionDetail(store, providers, record);
  });

  app.post<{ Params: IdParams }>('/api/sessions/:id/messages', async (request, reply) => {
    const body = request.body as { text?: unknown } | undefined;
    const text = body?.text;
    if (typeof text !== 'string' || text.trim() === '') {
      return reply.code(422).send({ error: 'invalid', errors: [{ field: 'text', message: 'the message must be non-empty text' }] });
    }
    try {
      await supervisor.sendMessage(request.params.id, text);
      return reply.code(202).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: IdParams }>('/api/sessions/:id/pause', async (request, reply) => {
    try {
      return await toSession(store, await supervisor.pause(request.params.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: IdParams }>('/api/sessions/:id/resume', async (request, reply) => {
    try {
      return await toSession(store, await supervisor.resume(request.params.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: IdParams }>('/api/sessions/:id/detach', async (request, reply): Promise<ResumeCommand | FastifyReply> => {
    try {
      return await supervisor.detach(request.params.id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: IdParams }>('/api/sessions/:id/attach', async (request, reply): Promise<ResumeCommand | FastifyReply> => {
    try {
      return await supervisor.attach(request.params.id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: IdParams; Querystring: { since?: string } }>(
    '/api/sessions/:id/events',
    async (request, reply): Promise<SessionEvent[] | FastifyReply> => {
      const record = await store.sessions.get(request.params.id);
      if (!record) return notFound(reply, request.params.id);
      const since = request.query.since;
      if (since !== undefined && Number.isNaN(Date.parse(since))) {
        return reply.code(422).send({ error: 'invalid', errors: [{ field: 'since', message: 'since must be an ISO timestamp' }] });
      }
      const events = await store.events.list(record.id, since === undefined ? {} : { sinceTs: new Date(since).toISOString() });
      return events.map(toEvent);
    },
  );

  registerPending(app, SESSION_ROUTES_PENDING);
}
