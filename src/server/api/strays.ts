import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type StrayCleanResult, type StrayRestorable, type StrayScan, readStrayCleanRequest, readStrayRestoreRequest } from '../../core/strays.ts';
import { StrayError, type StrayService } from '../cleanup/strays.ts';
import { isPeerRequest } from './machines.ts';

/**
 * D191 · stray worktrees and leftovers (`docs/worktrees.md` → *Stray worktrees*). This computer
 * only: a paired computer's request is refused here, a paired phone by the device allow-list
 * (`/api/cleanup/*` is local-only).
 * - `GET /api/cleanup/strays` → `{ scan: StrayScan, restorable }` (read-only: nothing changes).
 * - `POST /api/cleanup/strays/clean` `{ ids, force }` → `StrayCleanResult` (409 `busy`).
 * - `POST /api/cleanup/strays/restore` `{ repo, branch, sha }` → `{ restorable }` (404 when not one it deleted).
 */
export async function registerStrayRoutes(app: FastifyInstance, strays: StrayService): Promise<void> {
  const refusePeer = (request: FastifyRequest, reply: FastifyReply): FastifyReply | null =>
    isPeerRequest(request) ? reply.code(403).send({ error: 'peer-forbidden', message: 'clean-up runs on the machine whose screen you are on' }) : null;

  app.get('/api/cleanup/strays', async (request, reply): Promise<{ scan: StrayScan; restorable: StrayRestorable[] } | FastifyReply> => {
    const refused = refusePeer(request, reply);
    if (refused) return refused;
    return { scan: await strays.scan(), restorable: await strays.restorable() };
  });

  app.post('/api/cleanup/strays/clean', async (request, reply): Promise<StrayCleanResult | FastifyReply> => {
    const refused = refusePeer(request, reply);
    if (refused) return refused;
    const parsed = readStrayCleanRequest(request.body);
    if (!parsed) return reply.code(422).send({ error: 'invalid', message: 'the body must be { ids: [item ids], force?: boolean }' });
    try {
      return await strays.clean(parsed);
    } catch (error) {
      if (error instanceof StrayError) return reply.code(error.status).send({ error: error.code, message: error.message });
      throw error;
    }
  });

  app.post('/api/cleanup/strays/restore', async (request, reply): Promise<{ restorable: StrayRestorable[] } | FastifyReply> => {
    const refused = refusePeer(request, reply);
    if (refused) return refused;
    const parsed = readStrayRestoreRequest(request.body);
    if (!parsed) return reply.code(422).send({ error: 'invalid', message: 'the body must be { repo, branch, sha }' });
    try {
      return { restorable: await strays.restore(parsed) };
    } catch (error) {
      if (error instanceof StrayError) return reply.code(error.status).send({ error: error.code, message: error.message });
      throw error;
    }
  });
}
