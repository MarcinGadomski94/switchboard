import type { FastifyInstance, FastifyReply } from 'fastify';
import { type TutorialState, parseTourOutcome } from '../../core/tutorial.ts';
import type { ApiContext } from '../routes.ts';
import { UnknownTourError } from '../tutorial/service.ts';

/**
 * D85 · the tutorial (`docs/tutorial.md`, `contracts/local-api.md` → *Tutorial (D85)*).
 * One state per machine; a paired device reads and marks the same one (normal use):
 * - `GET /api/tutorial` → `TutorialState` (the first read after a start queues what is new).
 * - `PUT /api/tutorial/tours/{id}` `{ status: "completed" | "skipped" }` → `TutorialState`
 *   (`id` = `main` or a What's-new feature id; 404 `not-found` for another, 422 `invalid` for a bad body).
 */
export async function registerTutorialRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { tutorial } = context;

  app.get('/api/tutorial', async (): Promise<TutorialState> => tutorial.state());

  app.put<{ Params: { id: string } }>('/api/tutorial/tours/:id', async (request, reply): Promise<TutorialState | FastifyReply> => {
    const outcome = parseTourOutcome(request.body);
    if (!outcome) return reply.code(422).send({ error: 'invalid', errors: [{ field: 'status', message: 'completed or skipped' }] });
    try {
      return await tutorial.record(request.params.id, outcome);
    } catch (error) {
      if (error instanceof UnknownTourError) return reply.code(404).send({ error: 'not-found', message: error.message });
      throw error;
    }
  });
}
