import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type CleanupRun, type CleanupScan, type CleanupSettings, parseClosedSessionDays, parseRunRequest, CLOSED_SESSION_DAYS_MAX, CLOSED_SESSION_DAYS_MIN } from '../../core/cleanup.ts';
import { CleanupError, CleanupService } from '../cleanup/service.ts';
import type { ApiContext } from '../routes.ts';
import { isPeerRequest } from './machines.ts';

/**
 * D84 · Clean-up (`docs/cleanup.md`, `contracts/local-api.md` → *Clean-up (D84)*).
 * This machine only (a peer request is refused; a paired device is refused by
 * the device allow-list):
 * - `GET /api/cleanup` → `CleanupScan` (the dry run; nothing changes).
 * - `PUT /api/cleanup/settings` `{ closedSessionDays }` → `CleanupSettings`.
 * - `POST /api/cleanup/runs` `{ items: [{ id, fingerprint, confirm? }] }` → 202 `CleanupRun`
 *   (422 `invalid` / `confirmation-required`, 409 `busy`).
 * - `GET /api/cleanup/runs/{runId}` → `CleanupRun` (poll it).
 */
export async function registerCleanupRoutes(app: FastifyInstance, context: ApiContext, service?: CleanupService): Promise<void> {
  const cleanup =
    service ??
    new CleanupService({
      store: context.store,
      dataDir: context.config.dataDir,
      isLive: (sessionId) => context.supervisor.isLive(sessionId),
      takeover: context.takeover,
    });

  const refusePeer = (request: FastifyRequest, reply: FastifyReply): FastifyReply | null =>
    isPeerRequest(request) ? reply.code(403).send({ error: 'peer-forbidden', message: 'clean-up runs on the machine whose screen you are on' }) : null;

  app.get('/api/cleanup', async (request, reply): Promise<CleanupScan | FastifyReply> => refusePeer(request, reply) ?? cleanup.scan());

  app.put('/api/cleanup/settings', async (request, reply): Promise<CleanupSettings | FastifyReply> => {
    const refused = refusePeer(request, reply);
    if (refused) return refused;
    const body = request.body as Record<string, unknown> | null;
    const days = parseClosedSessionDays(body && typeof body === 'object' ? body['closedSessionDays'] : undefined);
    if (days === null) {
      return reply.code(422).send({ error: 'invalid', errors: [{ field: 'closedSessionDays', message: `a whole number of days from ${CLOSED_SESSION_DAYS_MIN} to ${CLOSED_SESSION_DAYS_MAX}` }] });
    }
    return { closedSessionDays: await cleanup.setClosedSessionDays(days) };
  });

  app.post('/api/cleanup/runs', async (request, reply): Promise<CleanupRun | FastifyReply> => {
    const refused = refusePeer(request, reply);
    if (refused) return refused;
    const parsed = parseRunRequest(request.body);
    if (!parsed.ok) return reply.code(422).send({ error: 'invalid', errors: [{ field: parsed.field, message: parsed.message }] });
    try {
      return reply.code(202).send(await cleanup.start(parsed.value));
    } catch (error) {
      if (error instanceof CleanupError) return reply.code(error.status).send({ error: error.code, message: error.message, ...(error.items.length > 0 ? { items: error.items } : {}) });
      throw error;
    }
  });

  app.get<{ Params: { runId: string } }>('/api/cleanup/runs/:runId', async (request, reply): Promise<CleanupRun | FastifyReply> => {
    const refused = refusePeer(request, reply);
    if (refused) return refused;
    const run = cleanup.get(request.params.runId);
    return run ?? reply.code(404).send({ error: 'not-found', message: `no clean-up run ${request.params.runId}` });
  });
}
