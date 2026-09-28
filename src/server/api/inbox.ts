import type { FastifyInstance, FastifyReply } from 'fastify';
import { InboxError, type InboxErrorCode } from '../inbox/pipeline.ts';
import type { ApiContext } from '../routes.ts';
import { type PendingRoute, registerPending } from './not-implemented.ts';

/** Inbox and question routes (contract → REST) not implemented yet. */
export const INBOX_ROUTES_PENDING: readonly PendingRoute[] = [{ method: 'GET', url: '/api/inbox', item: 'M3.2' }];

/** HTTP status of each pipeline refusal. */
const ERROR_STATUS: Record<InboxErrorCode, number> = {
  'not-found': 404,
  invalid: 400,
  'unknown-action': 400,
  'already-answered': 409,
  'not-open': 409,
  busy: 409,
};

/** Sends a pipeline refusal as `{ error: <code>, message }`, rethrows anything else. */
function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof InboxError) return reply.code(ERROR_STATUS[error.code]).send({ error: error.code, message: error.message });
  throw error;
}

/**
 * Registers the Inbox and question routes. M3.1: the answers route and the
 * permission-item actions (`docs/questions.md`); M3.2 adds `GET /api/inbox`, M3.3
 * the system-item actions on the same actions route.
 */
export async function registerInboxRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { questions } = context;

  // Contract: 204, 400 unless every question is answered.
  app.post<{ Params: { batchId: string } }>('/api/questions/batch/:batchId/answers', async (request, reply) => {
    try {
      await questions.answerBatch(request.params.batchId, request.body);
      return reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Contract: 204. Permission items (D6): allow-once / deny.
  app.post<{ Params: { id: string; action: string } }>('/api/inbox/:id/actions/:action', async (request, reply) => {
    const { id, action } = request.params;
    try {
      if (await questions.isPermissionItem(id)) {
        await questions.decide(id, action);
        return reply.code(204).send();
      }
      return reply.code(404).send({ error: 'not-found', message: `no Inbox item ${id}` });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  registerPending(app, INBOX_ROUTES_PENDING);
}
