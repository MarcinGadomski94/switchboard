import type { FastifyInstance, FastifyReply } from 'fastify';
import { CiGh } from '../ci/gh.ts';
import type { ApiContext } from '../routes.ts';
import { TodoError } from '../todos/service.ts';
import { TodoImportError, TodoImportService } from '../todos/import.ts';

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof TodoImportError) return reply.code(error.status).send({ error: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) });
  if (error instanceof TodoError) return reply.code(error.status).send({ error: error.code, message: error.message });
  throw error;
}

/**
 * D109 (`docs/ci.md`, `docs/todos.md` → *Import issues (D109)*; contract → *CI and pull
 * requests (D109)*). A peer's session id is forwarded to its machine like every session
 * route (its gh, its Jira connection; no credential travels).
 *
 * - `GET /api/sessions/{id}/ci` → `SessionCi` (the watched PRs; 404 for an unknown session).
 * - `GET /api/sessions/{id}/todos/import/sources` → `IssueImportSources`.
 * - `POST /api/sessions/{id}/todos/import/preview` `IssueImportQuery` → `IssueImportPreview`.
 * - `POST /api/sessions/{id}/todos/import` `{ query, keys }` → the session's `SessionTodoList`
 *   (201); 422 `invalid`, 409 `jira-unavailable` / `too-many`, 502 `source-failed`.
 *
 * Merge PR and Try again are the Inbox items' actions (`POST /api/inbox/{id}/actions/{action}`).
 */
export async function registerCiRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const imports = new TodoImportService({
    store: context.store,
    todos: context.todos,
    gh: new CiGh({ gh: context.config.ghCommand }),
    cwd: context.config.dataDir,
    sessionDirs: async (sessionId) => {
      const session = await context.store.sessions.get(sessionId);
      if (!session) return [];
      const { worktrees, inPlace } = await context.worktrees.repos.of(session);
      return [...worktrees.map((worktree) => worktree.path), ...inPlace.map((repo) => repo.top)];
    },
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/ci', async (request, reply) => {
    if (!(await context.store.sessions.get(request.params.id))) return reply.code(404).send({ error: 'not-found', message: `no session ${request.params.id}` });
    return context.ci.status(request.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/todos/import/sources', async (request, reply) => {
    try {
      return await imports.sources(request.params.id);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/todos/import/preview', async (request, reply) => {
    try {
      return await imports.preview(request.params.id, request.body);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/todos/import', async (request, reply) => {
    try {
      return reply.code(201).send(await imports.import(request.params.id, request.body));
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
