import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DraftError } from '../drafts/service.ts';
import type { ApiContext } from '../routes.ts';
import { isPeerRequest } from './machines.ts';

function sendDraftError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof DraftError) return reply.code(error.status).send({ error: error.code, message: error.message });
  throw error;
}

/** Who saves a draft: a paired device (`device:<id>`), a paired machine's UI through the peer API (`peer`), or this machine's UI (`local`). */
function originOf(request: FastifyRequest): string {
  if (request.device) return `device:${request.device.id}`;
  if (isPeerRequest(request)) return 'peer';
  return 'local';
}

/**
 * D88 · drafts follow you (`docs/chat.md` → *Drafts*, contract → *Drafts (D88)*):
 * - `GET /api/sessions/{id}/drafts` → `SessionDraft[]`.
 * - `PUT /api/sessions/{id}/drafts/{field}` `{ value, client? }` → the `SessionDraft`
 *   (200), or 204 when the value is empty (the draft is cleared). 413 `too-large`
 *   past 64 KB, 422 `invalid`, 409 `too-many`, 404 `not-found`.
 * - `DELETE /api/sessions/{id}/drafts/{field}[?client=<page>]` → 204 (also when there was none).
 * A paired machine's session (`r~<machine>~<id>`) is forwarded to its machine like
 * every session route, so its drafts live there and follow the session.
 *
 * Ruling 2026-10-09, this machine's own drafts (no session: the New-session form;
 * paired devices yes, the peer API no):
 * - `GET /api/drafts` → `SessionDraft[]`;
 * - `PUT /api/drafts/{field}` `{ value, client? }` → the `SessionDraft`, 204 when empty;
 * - `DELETE /api/drafts/{field}[?client=<page>]` → 204.
 */
export async function registerDraftRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { drafts } = context;

  app.get<{ Params: { id: string } }>('/api/sessions/:id/drafts', async (request, reply) => {
    try {
      return await drafts.list(request.params.id);
    } catch (error) {
      return sendDraftError(reply, error);
    }
  });

  app.put<{ Params: { id: string; field: string } }>('/api/sessions/:id/drafts/:field', async (request, reply) => {
    try {
      const saved = await drafts.put(request.params.id, request.params.field, request.body, originOf(request));
      return saved === null ? reply.code(204).send() : saved;
    } catch (error) {
      return sendDraftError(reply, error);
    }
  });

  app.delete<{ Params: { id: string; field: string }; Querystring: { client?: string } }>('/api/sessions/:id/drafts/:field', async (request, reply) => {
    try {
      await drafts.delete(request.params.id, request.params.field, request.query.client);
      return reply.code(204).send();
    } catch (error) {
      return sendDraftError(reply, error);
    }
  });

  app.get('/api/drafts', async () => drafts.listMachine());

  app.put<{ Params: { field: string } }>('/api/drafts/:field', async (request, reply) => {
    try {
      const saved = await drafts.putMachine(request.params.field, request.body, originOf(request));
      return saved === null ? reply.code(204).send() : saved;
    } catch (error) {
      return sendDraftError(reply, error);
    }
  });

  app.delete<{ Params: { field: string }; Querystring: { client?: string } }>('/api/drafts/:field', async (request, reply) => {
    try {
      await drafts.deleteMachine(request.params.field, request.query.client);
      return reply.code(204).send();
    } catch (error) {
      return sendDraftError(reply, error);
    }
  });
}
