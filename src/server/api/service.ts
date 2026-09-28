import type { FastifyInstance } from 'fastify';
import type { LoginServiceError, LoginServiceRequest } from '../../core/login-service.ts';
import type { ApiContext } from '../routes.ts';
import { ServiceError } from '../service/errors.ts';
import { sendNotImplemented } from './not-implemented.ts';

/** The backlog item of these routes (answers 501 while no provider is wired). */
const ITEM = 'M9.1';

function isRequest(body: unknown): body is LoginServiceRequest {
  return typeof body === 'object' && body !== null && !Array.isArray(body) && typeof (body as Record<string, unknown>)['startAtLogin'] === 'boolean';
}

/**
 * "Start at login" (M9.1, `docs/service.md`), additive to the contract:
 * `GET /api/service` → `LoginServiceStatus`; `PUT /api/service
 * { startAtLogin: boolean }` registers or removes the per-user service and
 * answers the new status. A body without a boolean `startAtLogin` → 422; a
 * refusal (unsupported OS, no Node ≥ 24 on PATH, a failed service-manager
 * command) → `409 { error, message }`. Without a `loginService` provider (tests
 * that build the app bare) both answer 501, so nothing can touch the OS by
 * accident.
 */
export async function registerServiceRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const provider = context.providers.loginService;

  app.get('/api/service', async (_request, reply) => {
    if (!provider) return sendNotImplemented(reply, ITEM);
    return reply.send(await provider.status());
  });

  app.put('/api/service', async (request, reply) => {
    if (!provider) return sendNotImplemented(reply, ITEM);
    if (!isRequest(request.body)) {
      return reply.code(422).send({ error: 'invalid', errors: [{ field: 'startAtLogin', message: 'startAtLogin must be true or false' }] });
    }
    try {
      return reply.send(await provider.setStartAtLogin(request.body.startAtLogin));
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      const body: LoginServiceError = { error: error.code, message: error.message };
      return reply.code(409).send(body);
    }
  });
}
