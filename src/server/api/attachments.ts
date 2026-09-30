import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ATTACHMENT_UPLOAD_BODY_MAX, type Attachment } from '../../core/attachments.ts';
import { AttachmentError } from '../attachments/service.ts';
import type { ApiContext } from '../routes.ts';

/**
 * `Content-Disposition` for a stored name: an ASCII fallback (`"`, `\` and
 * non-ASCII as `_`) plus the exact name as RFC 5987 `filename*`.
 */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * The response headers of a served attachment (D57, `docs/security.md` →
 * *Attachments*): a sniffed image or PDF is shown inline with its own type,
 * anything else (SVG and HTML included: they are never sniffed as images) is a
 * download as `application/octet-stream`; `?download` makes an image or PDF a
 * download too. Always `X-Content-Type-Options: nosniff`; everything but a PDF
 * (the browser's viewer needs it) gets a CSP that runs nothing.
 */
export function attachmentHeaders(attachment: Pick<Attachment, 'kind' | 'mediaType' | 'name'>, download: boolean): Record<string, string> {
  const inline = attachment.kind !== 'file' && !download;
  const headers: Record<string, string> = {
    'content-type': attachment.kind === 'file' ? 'application/octet-stream' : attachment.mediaType,
    'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', attachment.name),
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=3600',
  };
  if (attachment.kind !== 'pdf') headers['content-security-policy'] = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
  return headers;
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AttachmentError) return reply.code(error.status).send(error.body());
  throw error;
}

/**
 * D57 · attachments (`docs/chat.md` → *Attachments*; contract: additive D57 note in
 * `docs/handoff/contracts/local-api.md`):
 * - `POST /api/sessions/{id}/attachments` `{ name, data }` (one file, base64) →
 *   201 {@link Attachment}; 404 unknown session; 413 over 20 MiB; 422 not base64 / empty.
 * - `POST /api/attachments` → the same, staged for a New-session start (its
 *   `attachments` ids move into the new session).
 * - `GET /api/sessions/{id}/attachments/{attachmentId}[?download]` → the file
 *   ({@link attachmentHeaders}); 404 when unknown, another session's, or cleaned up.
 * Behind the cookie guard like every route; a peer's session goes through the proxy.
 */
export async function registerAttachmentRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { store, attachments } = context;

  app.post<{ Params: { id: string } }>('/api/sessions/:id/attachments', { bodyLimit: ATTACHMENT_UPLOAD_BODY_MAX }, async (request, reply) => {
    const session = await store.sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: 'not-found', message: `no session ${request.params.id}` });
    try {
      return reply.code(201).send(await attachments.upload(session.id, request.body));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/attachments', { bodyLimit: ATTACHMENT_UPLOAD_BODY_MAX }, async (request, reply) => {
    try {
      return reply.code(201).send(await attachments.upload(null, request.body));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string; attachmentId: string }; Querystring: { download?: unknown } }>(
    '/api/sessions/:id/attachments/:attachmentId',
    async (request, reply) => {
      const found = await attachments.find(request.params.id, request.params.attachmentId);
      if (!found) return reply.code(404).send({ error: 'not-found', message: `no attachment ${request.params.attachmentId} in session ${request.params.id}` });
      const headers = attachmentHeaders(found.record, request.query.download !== undefined);
      for (const [name, value] of Object.entries(headers)) reply.header(name, value);
      reply.header('content-length', String(found.record.size));
      return reply.send(createReadStream(found.path));
    },
  );
}
