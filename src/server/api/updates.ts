import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { UpdateErrorCode, UpdateTrigger, UpdateVersionInput } from '../../core/updates.ts';
import type { Store } from '../db/store.ts';
import { PEER_REQUEST_HEADER } from '../peers/service.ts';
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

/** D140: the HTTP status of a refusal: 422 invalid, 429 rate-limited, else 409. */
export function refusalStatus(code: UpdateErrorCode): number {
  if (code === 'invalid') return 422;
  if (code === 'rate-limited') return 429;
  return 409;
}

function refusal(reply: FastifyReply, error: unknown): FastifyReply {
  if (!(error instanceof UpdateError)) throw error;
  return reply.code(refusalStatus(error.code)).send({ error: error.code, message: error.message });
}

/**
 * D140: who asks: a paired phone (the device guard set `request.device`), a
 * paired computer (the peer API injected the request with its machine id in
 * {@link PEER_REQUEST_HEADER}), else this computer's own UI.
 */
export async function updateTriggerOf(request: FastifyRequest, store: Store): Promise<UpdateTrigger> {
  const device = request.device;
  if (device) return { kind: 'device', id: device.id, name: device.name };
  const peer = request.headers[PEER_REQUEST_HEADER];
  if (typeof peer === 'string' && peer !== '') {
    const machine = await store.machines.get(peer);
    return { kind: 'peer', id: peer, name: machine?.name ?? peer };
  }
  return { kind: 'local' };
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
 *
 * D140 (`docs/updates.md` → *Remote updates*): a paired phone may call all four,
 * a paired computer (the peer API) `GET`, `check` and `install`. An install from
 * either is refused where this Switchboard cannot restart itself (409
 * `git-checkout` / `manual-restart`), limited to one per 10 minutes (429
 * `rate-limited`) and recorded with the device's or the computer's name.
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
    const trigger = await updateTriggerOf(request, context.store);
    try {
      return reply.code(202).send(updates.install(version, trigger));
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
