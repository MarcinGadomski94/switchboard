import type { FastifyInstance, FastifyReply } from 'fastify';
import { InboxError, type InboxErrorCode } from '../inbox/pipeline.ts';
import { SystemItemError, type SystemItemErrorCode } from '../inbox/system-items.ts';
import { listInbox } from '../inbox/wire.ts';
import type { ApiContext } from '../routes.ts';
import { isPeerRequest } from './machines.ts';
import { WorktreeError } from '../worktrees/manager.ts';
import { type PendingRoute, registerPending } from './not-implemented.ts';
import { sendWorktreeError } from './worktree-errors.ts';
import { sendReviewError } from './reviews.ts';

/** Inbox and question routes (contract → REST) not implemented yet (none since M3.2). */
export const INBOX_ROUTES_PENDING: readonly PendingRoute[] = [];

/** HTTP status of each pipeline refusal. */
const ERROR_STATUS: Record<InboxErrorCode, number> = {
  'not-found': 404,
  invalid: 400,
  'invalid-answer': 422,
  'unknown-action': 400,
  'already-answered': 409,
  'not-open': 409,
  busy: 409,
};

/** HTTP status of each system-item refusal (M3.3, `docs/system-items.md`). */
const SYSTEM_ERROR_STATUS: Record<SystemItemErrorCode, number> = {
  'not-found': 404,
  'unknown-action': 400,
  'not-open': 409,
  busy: 409,
  gone: 409,
  unavailable: 501,
};

/**
 * Sends a pipeline or system-item refusal as `{ error: <code>, message }` (D39: a
 * refused answer as 422 `{ error: "invalid", message, errors: [{ questionId, field,
 * message }] }`, the API's usual 422 shape; a missing service as 501 `{ error:
 * "not-implemented", item, message }`), a worktree manager refusal as
 * `worktree-errors.ts` does; rethrows anything else.
 */
function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof InboxError && error.code === 'invalid-answer') {
    return reply.code(422).send({ error: 'invalid', message: error.message, errors: error.errors });
  }
  if (error instanceof InboxError) return reply.code(ERROR_STATUS[error.code]).send({ error: error.code, message: error.message });
  if (error instanceof SystemItemError) {
    if (error.code === 'unavailable') return reply.code(501).send({ error: 'not-implemented', item: error.item ?? '', message: error.message });
    return reply.code(SYSTEM_ERROR_STATUS[error.code]).send({ error: error.code, message: error.message });
  }
  if (error instanceof WorktreeError) return sendWorktreeError(reply, error, 'worktreeId');
  throw error;
}

/**
 * Registers the Inbox and question routes. M3.1: the answers route and the
 * permission-item actions (`docs/questions.md`); M3.2: `GET /api/inbox`
 * (`docs/inbox.md`); M3.3: the system-item actions on the same actions route
 * (`docs/system-items.md`).
 */
export async function registerInboxRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { questions, store, systemItems } = context;

  // Contract: InboxItem[] (question batches, permission items, system items).
  // D48: the reachable paired machines' items follow (tagged, namespaced); a peer asking gets this machine's only.
  app.get('/api/inbox', async (request) => {
    const local = await listInbox(store);
    return isPeerRequest(request) ? local : [...local, ...context.peers.remoteInbox()];
  });

  // Contract: 204, 400 unless every question is answered; D39: 422 for an entry with both / neither or a bad own answer.
  app.post<{ Params: { batchId: string } }>('/api/questions/batch/:batchId/answers', async (request, reply) => {
    try {
      await questions.answerBatch(request.params.batchId, request.body);
      return reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Contract: 204. Permission items (D6): allow-once / deny. System items (M3.3): their listed actions.
  app.post<{ Params: { id: string; action: string } }>('/api/inbox/:id/actions/:action', async (request, reply) => {
    const { id, action } = request.params;
    try {
      if (await questions.isPermissionItem(id)) {
        // D48 P4: a hooked session's Deny may carry `{ message }`.
        await questions.decide(id, action, request.body);
        return reply.code(204).send();
      }
      if (await systemItems.isSystemItem(id)) {
        await systemItems.act(id, action);
        return reply.code(204).send();
      }
      // D79: a review card's action (as `POST /api/reviews/{id}/<action>`).
      if (await context.reviews.isReview(id)) {
        try {
          await context.reviews.act(id, action, request.body);
        } catch (error) {
          return sendReviewError(reply, error);
        }
        return reply.code(204).send();
      }
      return reply.code(404).send({ error: 'not-found', message: `no Inbox item ${id}` });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  registerPending(app, INBOX_ROUTES_PENDING);
}
