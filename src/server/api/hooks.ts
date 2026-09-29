import type { FastifyInstance, FastifyReply } from 'fastify';
import { HookError } from '../hooks/service.ts';
import type { ApiContext } from '../routes.ts';

/** Largest hook input (a Write tool's input can be large). */
const HOOK_BODY_LIMIT = 16 * 1024 * 1024;

function sendHookError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof HookError) return reply.code(error.status).send({ error: error.code, message: error.message });
  throw error;
}

/**
 * D48 P4 (`docs/peers.md` → *Hooked terminal sessions*):
 *
 * - The hook script's endpoints, `POST /hook/v1/event | permission | waiter`: only
 *   with the hook token (`security.ts`), never from a page. `event` answers 204 at
 *   once; `permission` and `waiter` are held until the developer answers, a message
 *   is released, or they are superseded (204 = no decision / no message).
 * - `GET /api/terminal-sessions`, `POST /api/terminal-sessions/{id}/hook` (201 a new
 *   hooked session, 200 one that existed; 404, 409 `already-in-switchboard`, 502
 *   `agents-unavailable`).
 * - `GET /api/hooks`, `POST /api/hooks/install`, `POST /api/hooks/remove` → HooksStatus
 *   (409 `settings-unreadable`).
 */
export async function registerHookRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { hooks } = context;

  app.post('/hook/v1/event', { bodyLimit: HOOK_BODY_LIMIT }, async (request, reply) => {
    await hooks.onEvent(request.body);
    return reply.code(204).send();
  });

  const held = (handle: typeof hooks.onPermission) => async (request: { body: unknown }, reply: FastifyReply) => {
    const answer = await handle.call(hooks, request.body, (abort) => {
      reply.raw.once('close', () => {
        if (!reply.raw.writableEnded) abort();
      });
    });
    if (answer.status === 204) return reply.code(204).send();
    return reply.code(answer.status).send(answer.body);
  };
  app.post('/hook/v1/permission', { bodyLimit: HOOK_BODY_LIMIT }, held(hooks.onPermission));
  app.post('/hook/v1/waiter', { bodyLimit: HOOK_BODY_LIMIT }, held(hooks.onWaiter));

  app.get('/api/terminal-sessions', async (_request, reply) => {
    try {
      return await hooks.listTerminals();
    } catch (error) {
      return sendHookError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/terminal-sessions/:id/hook', async (request, reply) => {
    try {
      const { session, created } = await hooks.hook(request.params.id);
      return reply.code(created ? 201 : 200).send(session);
    } catch (error) {
      return sendHookError(reply, error);
    }
  });

  app.get('/api/hooks', async () => hooks.status());
  app.post('/api/hooks/install', async (_request, reply) => {
    try {
      return await hooks.install();
    } catch (error) {
      return sendHookError(reply, error);
    }
  });
  app.post('/api/hooks/remove', async (_request, reply) => {
    try {
      return await hooks.remove();
    } catch (error) {
      return sendHookError(reply, error);
    }
  });
}
