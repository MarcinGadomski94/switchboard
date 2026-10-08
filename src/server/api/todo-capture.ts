import type { FastifyInstance } from 'fastify';
import { isDeviceRequest } from '../devices/mark.ts';
import { SHARE_TARGET_ACTION, sharePagePath } from '../devices/share-target.ts';
import { todoEnrichEnabled } from '../settings/settings.ts';
import { TodoError } from '../todos/service.ts';
import type { ApiContext } from '../routes.ts';

/** The share target's form body (urlencoded, no files) is at most this big. */
const SHARE_BODY_LIMIT = 64 * 1024;

/**
 * D81 (`docs/todos.md` → *Quick capture (D81)*, contract → *Quick capture (D81)*):
 * - `POST /api/sessions/{id}/todos/capture` `{ title, note?, from }` (201, the session's list):
 *   the item is saved bare (plan `No plan`, medium, no estimate) and, with Settings → Sessions →
 *   *Let the agent fill in captured todos* on, marked as waiting for its agent (`TodoEnricher`
 *   asks it when it is next idle). 404 `not-found`, 422 `invalid`, 409 `too-many`. A paired
 *   machine's session is forwarded by the peer proxy (its machine asks its agent).
 * - `POST /share-target` (the device origin only; 404 elsewhere): the share sheet's form
 *   (`title`, `text`, `url`) → 303 to `/share?…`, the page that asks which session it goes to.
 *   Normally the service worker answers this itself; the route covers a page without it.
 */
export async function registerTodoCaptureRoutes(app: FastifyInstance, context: Pick<ApiContext, 'todos' | 'store'>): Promise<void> {
  app.post<{ Params: { id: string } }>('/api/sessions/:id/todos/capture', async (request, reply) => {
    const body = request.body !== null && typeof request.body === 'object' && !Array.isArray(request.body) ? (request.body as Record<string, unknown>) : {};
    try {
      const { list } = await context.todos.capture(request.params.id, body, await todoEnrichEnabled(context.store.settings));
      return reply.code(201).send(list);
    } catch (error) {
      if (error instanceof TodoError) return reply.code(error.status).send({ error: error.code, message: error.message });
      throw error;
    }
  });

  await app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: SHARE_BODY_LIMIT }, (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(typeof body === 'string' ? body : body.toString('utf8'))));
    });
    scope.post(SHARE_TARGET_ACTION, async (request, reply) => {
      if (!isDeviceRequest(request.raw)) return reply.callNotFound();
      const fields = request.body !== null && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
      return reply.code(303).header('location', sharePagePath(fields)).header('cache-control', 'no-store').send();
    });
  });
}
