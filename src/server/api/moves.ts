import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ApiContext } from '../routes.ts';
import { MovesError } from '../takeover/moves.ts';
import { isPeerRequest } from './machines.ts';

/** Sends a moves refusal as `{ error, message }`; rethrows what it does not know. */
function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof MovesError) return reply.code(error.status).send({ error: error.code, message: error.message });
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400) return reply.code(status).send({ error: 'peer-error', message: error instanceof Error ? error.message : String(error) });
  throw error;
}

/**
 * D154 (`docs/peers.md` → *Following a move (D154)*, `contracts/local-api.md` → *Moves*):
 * the moves list. Peer-callable (a paired machine reads this machine's own moves) and
 * allowed to phones (a read and a dismiss):
 * - `GET /api/moves` → `MoveRecord[]`: running moves first, then the finished ones of the
 *   last 24 hours (this machine's and, unless a paired machine asks, the paired machines'
 *   as last known, with remote ids).
 * - `GET /api/moves/{id}` → `MoveDetail` (the move and the git commands both machines ran;
 *   a paired machine's move is asked there).
 * - `POST /api/moves/{id}/dismiss` → 204: a finished move leaves the list (409 `running`).
 */
export async function registerMoveRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { moves } = context;
  app.get('/api/moves', async (request) => moves.list(isPeerRequest(request)));
  app.get<{ Params: { moveId: string } }>('/api/moves/:moveId', async (request, reply) => {
    try {
      return await moves.get(request.params.moveId);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post<{ Params: { moveId: string } }>('/api/moves/:moveId/dismiss', async (request, reply) => {
    try {
      await moves.dismiss(request.params.moveId);
      return reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
