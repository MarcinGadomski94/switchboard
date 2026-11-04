import { LogController, type FastifyReply, type FastifyRequest } from 'fastify';

/**
 * Fastify's per-request log lines without the routine ones (`docs/service.md` →
 * *The service log*): no `incoming request` and no `request completed` for a
 * request that ended without an error. Those two lines per request were most of
 * the service log (about 240 000 lines per 50 MB). Everything else Fastify logs
 * stays as it was: `request errored`, the default error handler's lines (5xx at
 * `error`), stream and serializer errors, unknown routes.
 * `SWITCHBOARD_REQUEST_LOGS=on` brings the per-request lines back.
 */
export class QuietRequestLogs extends LogController {
  override incomingRequest(): void {
    // Routine: not logged.
  }

  override requestCompleted(error: Error | null | undefined, request: FastifyRequest, reply: FastifyReply, metadata?: Record<string, unknown>): void {
    if (error) super.requestCompleted(error, request, reply, metadata);
  }
}
