import type { FastifyInstance, FastifyReply } from 'fastify';
import type { SolutionGroup, Worktree } from '../../core/api.ts';
import type { ApiContext } from '../routes.ts';
import { LiveSolutions } from '../solutions/live.ts';
import { ScanError } from '../solutions/scanner.ts';
import { sendFolderError } from './folders.ts';
import { SupervisorError } from '../supervisor/supervisor.ts';
import { toWorktree } from '../worktrees/wire.ts';
import { type PendingRoute, registerPending } from './not-implemented.ts';
import { sendWorktreeError } from './worktree-errors.ts';

/** Solutions routes (contract → REST) not implemented yet. */
export const SOLUTION_ROUTES_PENDING: readonly PendingRoute[] = [];

interface IsolateParams {
  readonly repo: string;
}

/**
 * Registers the Solutions routes. `GET /api/solutions?folder=` is one folder's
 * scan (D14: `folder` = a saved folder's id, or the folder path of a saved folder
 * or of a session; the default folder when omitted; M6.1, `docs/solutions.md`)
 * with its live fields (M6.2, `LiveSolutions`) from `providers.solutions`, or
 * live solutions over the store, the session diff and the worktree manager's
 * resolution when none is passed. A repo folder is one group with its one
 * solution. `409 no-folder` when no folder is saved, `404 not-found` for an
 * unknown folder, `409 folder-missing` when the folder is gone from disk.
 * `POST /api/solutions/{repo}/isolate` is the gap #2 "Move … to worktree"
 * operation of the worktree manager (M2.2); M6.3 decides when the UI offers it.
 */
export async function registerSolutionRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { worktrees, folders } = context;
  const solutions =
    context.providers.solutions ??
    new LiveSolutions({
      store: context.store,
      diff: context.providers.diff ?? worktrees,
      resolveRepo: (solution, folder) => worktrees.resolveRepo(solution, folder),
    });

  app.get<{ Querystring: { folder?: string } }>('/api/solutions', async (request, reply): Promise<SolutionGroup[] | FastifyReply> => {
    let folder;
    try {
      folder = await folders.resolveForView(request.query.folder);
    } catch (error) {
      return sendFolderError(reply, error);
    }
    try {
      return await solutions.solutions(folder);
    } catch (error) {
      if (error instanceof ScanError) return reply.code(409).send({ error: error.code, message: error.message });
      throw error;
    }
  });

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
