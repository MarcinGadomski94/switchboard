import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TodoGroup } from '../../core/api.ts';
import { AGENT_SESSION_HEADER } from '../../core/todos.ts';
import { TodoError, type TodoService } from '../todos/service.ts';
import { isPeerRequest } from './machines.ts';
import type { ApiContext } from '../routes.ts';

function sendTodoError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof TodoError) return reply.code(error.status).send({ error: error.code, message: error.message });
  throw error;
}

function field(body: unknown, name: string): unknown {
  return fields(body)[name];
}

/** The JSON object body, `{}` for anything else. */
function fields(body: unknown): Readonly<Record<string, unknown>> {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** The session the agent token was checked for (`security.ts` refused the request without a valid one). */
function agentSession(request: FastifyRequest): string {
  const value = request.headers[AGENT_SESSION_HEADER];
  return typeof value === 'string' ? value : '';
}

/**
 * D68 (`docs/todos.md`, contract → *Session todos (D68)*):
 *
 * - The UI's routes (the `sb_token` cookie; a peer's session id `r~<machine>~<id>`
 *   is forwarded to its machine like every session route):
 *   `GET /api/sessions/{id}/todos`, `POST …/todos` `{ title, description?, plan? }`
 *   (201; D69, `text` is accepted for `title`), `PUT …/todos/order` `{ ids }`,
 *   `PUT …/todos/{todoId}` `{ title?, description?, plan?, state? }`,
 *   `DELETE …/todos/{todoId}`, `POST …/todos/clear-done`: each answers the
 *   session's whole list (`SessionTodoList`). 404 `not-found` (no session, or no
 *   such item in it), 422 `invalid`, 409 `too-many`.
 * - `GET /api/todos`: every open session's items, grouped (`TodoGroup[]`), this
 *   machine's first, then the paired machines' as last known (a peer's request
 *   gets this machine's own only).
 * - The agent's routes, `/agent/v1/todos[/{todoId}]` (GET, POST, PUT, DELETE; D69: GET of one item):
 *   only with the session's agent token (`security.ts`); the session is the one
 *   the token belongs to, never one named in the path.
 */
export async function registerTodoRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const todos: TodoService = context.todos;

  app.get<{ Params: { id: string } }>('/api/sessions/:id/todos', async (request, reply) => {
    try {
      return await todos.list(request.params.id);
    } catch (error) {
      return sendTodoError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/todos', async (request, reply) => {
    try {
      const { list } = await todos.add(request.params.id, fields(request.body), 'developer');
      return reply.code(201).send(list);
    } catch (error) {
      return sendTodoError(reply, error);
    }
  });

  app.put<{ Params: { id: string } }>('/api/sessions/:id/todos/order', async (request, reply) => {
    try {
      return await todos.reorder(request.params.id, field(request.body, 'ids'));
    } catch (error) {
      return sendTodoError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/todos/clear-done', async (request, reply) => {
    try {
      return await todos.clearDone(request.params.id);
    } catch (error) {
      return sendTodoError(reply, error);
    }
  });

  app.put<{ Params: { id: string; todoId: string } }>('/api/sessions/:id/todos/:todoId', async (request, reply) => {
    try {
      const { list } = await todos.update(request.params.id, request.params.todoId, fields(request.body));
      return list;
    } catch (error) {
      return sendTodoError(reply, error);
    }
  });

  app.delete<{ Params: { id: string; todoId: string } }>('/api/sessions/:id/todos/:todoId', async (request, reply) => {
    try {
      return await todos.remove(request.params.id, request.params.todoId);
    } catch (error) {
      return sendTodoError(reply, error);
    }
  });

  app.get('/api/todos', async (request): Promise<TodoGroup[]> => [...(await todos.groups()), ...(isPeerRequest(request) ? [] : context.peers.remoteTodos())]);

  // ── the agent's routes (the `switchboard` MCP helper) ──────────────────

  app.get('/agent/v1/todos', async (request, reply) => {
    try {
      return await todos.list(agentSession(request));
    } catch (error) {
      return sendTodoError(reply, error);
    }
  });

  app.post('/agent/v1/todos', async (request, reply) => {
    try {
      return reply.code(201).send(await todos.add(agentSession(request), fields(request.body), 'agent'));
    } catch (error) {
      return sendTodoError(reply, error);
    }
  });

  // D69: one item in full (the agent's `todo_get`).
  app.get<{ Params: { todoId: string } }>('/agent/v1/todos/:todoId', async (request, reply) => {
    try {
      return await todos.get(agentSession(request), request.params.todoId);
    } catch (error) {
      return sendTodoError(reply, error);
    }
  });

  app.put<{ Params: { todoId: string } }>('/agent/v1/todos/:todoId', async (request, reply) => {
    try {
      return await todos.update(agentSession(request), request.params.todoId, fields(request.body));
    } catch (error) {
      return sendTodoError(reply, error);
    }
  });

  app.delete<{ Params: { todoId: string } }>('/agent/v1/todos/:todoId', async (request, reply) => {
    try {
      return await todos.remove(agentSession(request), request.params.todoId);
    } catch (error) {
      return sendTodoError(reply, error);
    }
  });
}
