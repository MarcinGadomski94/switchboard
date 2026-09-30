import type { FastifyInstance, FastifyReply } from 'fastify';
import type { UpdateVersionInput } from '../../core/updates.ts';
import type { ApiContext } from '../routes.ts';
import { UpdateError } from '../updates/service.ts';
import { sendNotImplemented } from './not-implemented.ts';

/** The decision the routes answer 501 with while no updater is wired. */
const ITEM = 'D55';

function versionOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const version = (body as Partial<UpdateVersionInput>).version;
  return typeof version === 'string' && version.trim() !== '' ? version.trim() : null;
}

function invalid(reply: FastifyReply): FastifyReply {
  return reply.code(422).send({ error: 'invalid', errors: [{ field: 'version', message: 'version must be a non-empty string' }] });
}

function refusal(reply: FastifyReply, error: unknown): FastifyReply {
  if (!(error instanceof UpdateError)) throw error;
  return reply.code(error.code === 'invalid' ? 422 : 409).send({ error: error.code, message: error.message });
}

/**
 * D55 updates (`docs/updates.md`), additive to the contract:
 * - `GET /api/updates` → `UpdateStatus`;
 * - `POST /api/updates/check` → `UpdateStatus` after a check of GitHub releases;
 * - `POST /api/updates/install { version }` → `202 UpdateStatus` (the update runs
 *   in the background; its progress comes as `updateChanged`), refused with
 *   `409 { error: "git-checkout" | "busy" | "checking" | "no-update" | "stale-version", message }`;
 * - `POST /api/updates/dismiss { version }` → `UpdateStatus` (hides the banner of that version).
 * A body without a `version` → 422. Without an updater (the demo, tests that
 * build the app bare, `SWITCHBOARD_UPDATES=off`) every route answers 501.
 * This machine's only: none is on the peer API.
 */
export async function registerUpdateRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const updates = context.providers.updates;

  app.get('/api/updates', async (_request, reply) => {
    if (!updates) return sendNotImplemented(reply, ITEM);
    return reply.send(updates.status());
  });

  app.post('/api/updates/check', async (_request, reply) => {
    if (!updates) return sendNotImplemented(reply, ITEM);
    return reply.send(await updates.check());
  });

  app.post('/api/updates/install', async (request, reply) => {
    if (!updates) return sendNotImplemented(reply, ITEM);
    const version = versionOf(request.body);
    if (!version) return invalid(reply);
    try {
      return reply.code(202).send(updates.install(version));
    } catch (error) {
      return refusal(reply, error);
    }
  });

  app.post('/api/updates/dismiss', async (request, reply) => {
    if (!updates) return sendNotImplemented(reply, ITEM);
    const version = versionOf(request.body);
    if (!version) return invalid(reply);
    try {
      return reply.send(await updates.dismiss(version));
    } catch (error) {
      return refusal(reply, error);
    }
  });
}
