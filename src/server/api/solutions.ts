import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Worktree } from '../../core/api.ts';
import type { ApiContext } from '../routes.ts';
import { SupervisorError } from '../supervisor/supervisor.ts';
import { toWorktree } from '../worktrees/wire.ts';
import { type PendingRoute, registerPending } from './not-implemented.ts';
import { sendWorktreeError } from './worktree-errors.ts';

/** Solutions routes (contract → REST) not implemented yet. */
export const SOLUTION_ROUTES_PENDING: readonly PendingRoute[] = [{ method: 'GET', url: '/api/solutions', item: 'M6.2' }];

interface IsolateParams {
  readonly repo: string;
}

/**
 * Registers the Solutions routes. `POST /api/solutions/{repo}/isolate` is the
 * gap #2 "Move … to worktree" operation of the worktree manager (M2.2); M6.3
 * decides when the UI offers it.
 */
export async function registerSolutionRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { worktrees } = context;

  app.post<{ Params: IsolateParams }>('/api/solutions/:repo/isolate', async (request, reply): Promise<Worktree | FastifyReply> => {
    const body = request.body as { sessionId?: unknown } | undefined;
    const sessionId = body?.sessionId;
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return reply.code(422).send({ error: 'invalid', errors: [{ field: 'sessionId', message: 'sessionId must be a session id' }] });
    }
    try {
      const result = await worktrees.isolate(request.params.repo, sessionId);
      return reply.code(result.created ? 201 : 200).send(toWorktree(result.worktree));
    } catch (error) {
      if (error instanceof SupervisorError) {
        return reply.code(error.code === 'closing' ? 503 : 409).send({ error: error.code, message: error.message });
      }
      return sendWorktreeError(reply, error, 'repo');
    }
  });

  registerPending(app, SOLUTION_ROUTES_PENDING);
}
