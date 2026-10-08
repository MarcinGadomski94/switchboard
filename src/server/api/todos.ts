import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TodoGroup } from '../../core/api.ts';
import { AGENT_SESSION_HEADER } from '../../core/todos.ts';
import { HookError } from '../hooks/service.ts';
import { SupervisorError } from '../supervisor/supervisor.ts';
import { TodoError, type TodoMessageSender, type TodoService } from '../todos/service.ts';
import { runTodo } from '../todos/run.ts';
import { WorktreeError } from '../worktrees/manager.ts';
import { worktreeRefusal } from './worktree-errors.ts';
import { isPeerRequest } from './machines.ts';
import type { ApiContext } from '../routes.ts';
import { registerTodoCaptureRoutes } from './todo-capture.ts';

function sendTodoError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof TodoError) return reply.code(error.status).send({ error: error.code, message: error.message });
  // D75 · ▶ Start: the start message could not be sent (as `POST …/messages` answers it).
  if (error instanceof HookError) return reply.code(error.status).send({ error: error.code, message: error.message });
  // D76 · ▸ Run in new session: a worktree refusal of the run's start (as `POST /api/sessions` answers it).
  if (error instanceof WorktreeError) {
    const refusal = worktreeRefusal(error, 'solutions');
    return reply.code(refusal.status).send(refusal.body);
  }
  if (error instanceof SupervisorError) {
    const status = error.code === 'not-found' ? 404 : error.code === 'closing' ? 503 : 409;
    return reply.code(status).send({ error: error.code, message: error.message });
  }
  throw error;
}

/**
 * D75: sends a text to a session as `POST /api/sessions/{id}/messages` does: a normal user
 * message (queued while the agent is busy, D44 / D50; a session without a live process is
 * resumed with it), or, for a hooked terminal session, into its mailbox for its next idle
 * waiter (D48 P4). Its refusals (closed, detached, …) are thrown.
 */
export function sessionMessageSender(context: Pick<ApiContext, 'store' | 'supervisor' | 'hooks'>): TodoMessageSender {
  return async (sessionId, text) => {
    if ((await context.store.sessions.get(sessionId))?.hooked === true) await context.hooks.sendMessage(sessionId, text);
    else await context.supervisor.sendMessage(sessionId, text, 'user');
  };
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
 *   `DELETE …/todos/{todoId}`, `POST …/todos/clear-done`, D75 `POST …/todos/{todoId}/start`
 *   (▶ Start: in progress, and the start message sent to the session): each answers the
 *   session's whole list (`SessionTodoList`). 404 `not-found` (no session, or no
 *   such item in it), 422 `invalid`, 409 `too-many`; ▶ Start also the message route's
 *   refusals (409 `closed` / `detached`, a hooked session's `hooked-unavailable`, …).
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

  // D75 · ▶ Start: the item goes in progress and its start message is sent (never through the composer).
  const send = sessionMessageSender(context);
  app.post<{ Params: { id: string; todoId: string } }>('/api/sessions/:id/todos/:todoId/start', async (request, reply) => {
    try {
      const { list } = await todos.startItem(request.params.id, request.params.todoId, send);
      return list;
    } catch (error) {
      return sendTodoError(reply, error);
    }
  });

  // D76 · ▸ Run in new session: a new supervised session (its own worktree on `todo/<slug>` in a repo folder) works on the item.
  app.post<{ Params: { id: string; todoId: string } }>('/api/sessions/:id/todos/:todoId/run', async (request, reply) => {
    try {
      const outcome = await runTodo(context, request.params.id, request.params.todoId);
      if (!outcome.ok) return reply.code(outcome.status).send(outcome.body);
      return reply.code(201).send(outcome.result);
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

  // D76: a run session's list also names the item it runs (`linked`); D78: the estimate calibration line.
  app.get('/agent/v1/todos', async (request, reply) => {
    try {
      const session = agentSession(request);
      const list = await todos.list(session);
      return { ...list, linked: await todos.linkedTodo(session), calibration: await todos.calibration(session) };
    } catch (error) {
      return sendTodoError(reply, error);
    }
  });

  app.post('/agent/v1/todos', async (request, reply) => {
    try {
      const session = agentSession(request);
      const answer = await todos.add(session, fields(request.body), 'agent');
      return reply.code(201).send({ ...answer, calibration: await todos.calibration(session) });
    } catch (error) {
      return sendTodoError(reply, error);
    }
  });

  // D69: one item in full (the agent's `todo_get`). D76: a run session's linked item too.
  app.get<{ Params: { todoId: string } }>('/agent/v1/todos/:todoId', async (request, reply) => {
    try {
      const scope = await todos.agentScope(agentSession(request), request.params.todoId);
      return await todos.get(scope.sessionId, request.params.todoId);
    } catch (error) {
      return sendTodoError(reply, error);
    }
  });

  app.put<{ Params: { todoId: string } }>('/agent/v1/todos/:todoId', async (request, reply) => {
    try {
      const session = agentSession(request);
      // D76: a run session's agent may change its one linked item (in the source session's list); the answer
      // then carries the item and the agent's own list, never the source's other items.
      const scope = await todos.agentScope(session, request.params.todoId);
      // D75: the agent's writes (todo_start: `state: in_progress`) are the agent's.
      const answer = await todos.update(scope.sessionId, request.params.todoId, fields(request.body), 'agent');
      const list = scope.linked ? await todos.list(session) : answer.list;
      return { todo: answer.todo, list, linked: scope.linked, calibration: await todos.calibration(session) };
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

  // D81: quick capture (⌘K, a chat selection, the share sheet) and the device origin's share target.
  await registerTodoCaptureRoutes(app, context);
}
