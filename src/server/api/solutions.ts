import type { FastifyInstance, FastifyReply } from 'fastify';
import type { RepoBranches, SolutionGroup, Worktree } from '../../core/api.ts';
import { checkTicketBranch } from '../../core/ticket-branch.ts';
import { existingBranchName } from '../../core/worktrees.ts';
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
 * D32: its body `{ sessionId, branch }` (`IsolateRequest`) names the worktree's
 * branch after the ticket: required, a ticket branch (422 on field `branch`);
 * a branch the repo has already is 409 `branch-exists`. D60: the body may name
 * an existing branch instead, `{ sessionId, existingBranch }` (no ticket rule;
 * `branch` and `existingBranch` together are 422 on `existingBranch`), and
 * `GET /api/solutions/{repo}/branches?session=<id>&fetch=1` lists the repo's
 * local and remote branches for the picker (`RepoBranches`; `fetch=1` runs
 * `git fetch --all --prune` first, a failure is `fetchError` in a 200).
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

  app.get<{ Params: IsolateParams; Querystring: { session?: string; fetch?: string } }>(
    '/api/solutions/:repo/branches',
    async (request, reply): Promise<RepoBranches | FastifyReply> => {
      const sessionId = request.query.session;
      if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        return reply.code(422).send({ error: 'invalid', errors: [{ field: 'session', message: 'session must be a session id' }] });
      }
      const fetch = request.query.fetch === '1' || request.query.fetch === 'true';
      try {
        return await worktrees.listBranches(request.params.repo, sessionId, { fetch });
      } catch (error) {
        return sendWorktreeError(reply, error, 'repo');
      }
    },
  );

  app.post<{ Params: IsolateParams }>('/api/solutions/:repo/isolate', async (request, reply): Promise<Worktree | FastifyReply> => {
    const body = request.body as { sessionId?: unknown; branch?: unknown; existingBranch?: unknown } | undefined;
    const sessionId = body?.sessionId;
    const errors: Array<{ field: string; message: string }> = [];
    if (typeof sessionId !== 'string' || sessionId.trim() === '') errors.push({ field: 'sessionId', message: 'sessionId must be a session id' });
    // D60: an existing branch (local or remote) instead of a new one; the ticket rule is for new branches only.
    const wantsExisting = body?.existingBranch !== undefined && body?.existingBranch !== null;
    let options: { branch: string } | { existingBranch: string } | null = null;
    if (wantsExisting) {
      const existing = existingBranchName(body?.existingBranch);
      if (body?.branch !== undefined && body?.branch !== null) errors.push({ field: 'existingBranch', message: 'send either branch (a new branch) or existingBranch, not both' });
      else if (existing === null) errors.push({ field: 'existingBranch', message: 'existingBranch must be the name of one of the repo\'s branches' });
      else options = { existingBranch: existing };
    } else {
      // D32: the new worktree's branch is named after the ticket, like a new session's.
      const branch = checkTicketBranch(body?.branch);
      if (!branch.ok) errors.push({ field: 'branch', message: branch.message });
      else options = { branch: branch.name };
    }
    if (errors.length > 0 || typeof sessionId !== 'string' || options === null) return reply.code(422).send({ error: 'invalid', errors });
    try {
      const result = await worktrees.isolate(request.params.repo, sessionId, options);
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
