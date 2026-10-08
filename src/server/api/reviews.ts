import type { FastifyInstance, FastifyReply } from 'fastify';
import { REVIEW_ACTIONS } from '../../core/reviews.ts';
import { ReviewError } from '../reviews/service.ts';
import type { ApiContext } from '../routes.ts';
import { isPeerRequest } from './machines.ts';

/** Sends a {@link ReviewError} as `{ error, message }` (`conflicts` with a refused Merge); rethrows anything else. */
export function sendReviewError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ReviewError) {
    return reply.code(error.status).send({ error: error.code, message: error.message, ...(error.conflicts.length > 0 ? { conflicts: error.conflicts } : {}) });
  }
  throw error;
}

/**
 * D79 (`docs/reviews.md`, contract → *Review queue (D79)*):
 * - `GET /api/reviews`: `Review[]`: the open cards (pending, then those offering Clean
 *   up), each read from git again, then the newest resolved ones; the paired machines'
 *   follow (remote ids, tagged; a peer asking gets this machine's own only).
 * - `POST /api/reviews/{id}/merge|open-pr|commit|send-back|discard|cleanup|dismiss`: the
 *   card's action; answers the card afterwards. Bodies: `commit` `{ message }`,
 *   `send-back` `{ comment }`, `discard` / `cleanup` `{ confirm: true }`. A peer's card
 *   (`r~<machine>~<id>`) is acted on on its machine (the peer forwarding).
 */
export async function registerReviewRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { reviews } = context;

  app.get('/api/reviews', async (request) => {
    const local = await reviews.list();
    return isPeerRequest(request) ? local : [...local, ...context.peers.remoteReviews()];
  });

  for (const action of REVIEW_ACTIONS) {
    app.post<{ Params: { id: string } }>(`/api/reviews/:id/${action}`, async (request, reply) => {
      try {
        return await reviews.act(request.params.id, action, request.body);
      } catch (error) {
        return sendReviewError(reply, error);
      }
    });
  }
}
