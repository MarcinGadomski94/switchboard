import type { FastifyInstance, FastifyReply } from 'fastify';
import { CheckpointError } from '../checkpoints/service.ts';
import type { ApiContext } from '../routes.ts';

function sendCheckpointError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof CheckpointError) return reply.code(error.status).send(error.body());
  throw error;
}

/** A turn number from the path (a positive whole number), else `null`. */
function turnOf(raw: string): number | null {
  return /^[1-9]\d{0,8}$/.test(raw) ? Number(raw) : null;
}

/** The body's `filesOnly` (`undefined` = false), or `null` when the body is not `{ filesOnly?: boolean }`. */
function filesOnlyOf(body: unknown): boolean | null {
  if (body === undefined || body === null) return false;
  if (typeof body !== 'object' || Array.isArray(body)) return null;
  const value = (body as { filesOnly?: unknown }).filesOnly;
  if (value === undefined) return false;
  return typeof value === 'boolean' ? value : null;
}

function invalidTurn(reply: FastifyReply): FastifyReply {
  return reply.code(422).send({ error: 'invalid', errors: [{ field: 'turn', message: 'turn must be a positive whole number' }] });
}

/**
 * D80 · Undo a turn (`docs/undo.md`, contract → *Undo a turn (D80)*). A paired
 * machine's session id (`r~<machine>~<id>`) is forwarded to its machine like every
 * session route (the revert runs there); phones may call all of them.
 *
 * - `GET /api/sessions/{id}/checkpoints` → `SessionCheckpoints`: the turns with a
 *   checkpoint, why there are none, whether a turn runs, what Redo would undo.
 * - `GET /api/sessions/{id}/checkpoints/{turn}` → `CheckpointPlan`: the confirm
 *   dialog (the files that change per working tree, what happens to the branch).
 * - `POST /api/sessions/{id}/checkpoints/{turn}/revert` `{ filesOnly? }` → `CheckpointPlan`
 *   (`filesOnly: true` when the branch was left alone). 409 `turn-running`, 409
 *   `files-only-needed` (with `plan`; send again with `filesOnly: true`), 404
 *   `no-checkpoint`, 409 `hooked-unavailable`, 500 `revert-failed`.
 * - `POST /api/sessions/{id}/checkpoints/redo` → `CheckpointPlan`: undoes the newest
 *   revert. 409 `nothing-to-redo`, `turn-running`.
 */
export async function registerCheckpointRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { checkpoints } = context;

  app.get<{ Params: { id: string } }>('/api/sessions/:id/checkpoints', async (request, reply) => {
    try {
      return await checkpoints.list(request.params.id);
    } catch (error) {
      return sendCheckpointError(reply, error);
    }
  });

  app.get<{ Params: { id: string; turn: string } }>('/api/sessions/:id/checkpoints/:turn', async (request, reply) => {
    const turn = turnOf(request.params.turn);
    if (turn === null) return invalidTurn(reply);
    try {
      return await checkpoints.preview(request.params.id, turn);
    } catch (error) {
      return sendCheckpointError(reply, error);
    }
  });

  app.post<{ Params: { id: string; turn: string } }>('/api/sessions/:id/checkpoints/:turn/revert', async (request, reply) => {
    const turn = turnOf(request.params.turn);
    if (turn === null) return invalidTurn(reply);
    const filesOnly = filesOnlyOf(request.body);
    if (filesOnly === null) return reply.code(422).send({ error: 'invalid', errors: [{ field: 'filesOnly', message: 'filesOnly must be true or false' }] });
    try {
      return await checkpoints.revert(request.params.id, turn, { filesOnly });
    } catch (error) {
      return sendCheckpointError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/checkpoints/redo', async (request, reply) => {
    try {
      return await checkpoints.redo(request.params.id);
    } catch (error) {
      return sendCheckpointError(reply, error);
    }
  });
}
