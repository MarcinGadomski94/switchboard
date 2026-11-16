import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../routes.ts';
import { toSession } from '../sessions/wire.ts';

/**
 * D166 · To review (`docs/inbox.md` → *To review*; contract → *To review (D166)*):
 *
 * - `POST /api/sessions/{id}/reviewed` → 200 `Session`: **Mark reviewed** on the agent page: the
 *   agent's pending review ends (its Needs-you item closes). Nothing pending is fine (200). A paired
 *   computer's agent is forwarded to its computer like every session route (`PEER_API_ALLOW`); a
 *   paired phone may do it (`DEVICE_ALLOWED`); 404 `not-found`.
 *
 * The Needs-you card's own **Mark reviewed** is the Inbox action (`POST /api/inbox/{id}/actions/mark-reviewed`).
 */
export async function registerReviewRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const review = context.review;
  if (!review) return;
  app.post<{ Params: { id: string } }>('/api/sessions/:id/reviewed', async (request, reply) => {
    const record = await context.store.sessions.get(request.params.id);
    if (!record) return reply.code(404).send({ error: 'not-found', message: `no session ${request.params.id}` });
    await review.clear(record.id, 'reviewed');
    const fresh = (await context.store.sessions.get(record.id)) ?? record;
    return toSession(context.store, fresh, context.supervisor.activity(fresh.id));
  });
}
