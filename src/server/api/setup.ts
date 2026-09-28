import type { FastifyInstance, FastifyReply } from 'fastify';
import type { FolderListing, SetupState, WorkspaceRootCheck } from '../../core/api.ts';
import type { ApiContext } from '../routes.ts';
import { SetupError } from '../setup/service.ts';

interface PathQuery {
  readonly path?: string;
}

function sendSetupError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof SetupError) {
    return reply.code(error.status).send({ error: error.code, message: error.message, ...(error.check ? { check: error.check } : {}) });
  }
  throw error;
}

/**
 * The first-run wizard's routes (M5.3, additive to the contract; `docs/setup.md`
 * → *API*), all behind the usual Host/Origin guard and `sb_token` cookie:
 * - `GET /api/setup` → `SetupState`
 * - `GET /api/setup/root?path=` → `WorkspaceRootCheck` (400 without `path`)
 * - `PUT /api/setup/root` `{ path }` → `SetupState`; 409 `root-from-env` /
 *   `sessions-live`, 422 `invalid` (+ `check`)
 * - `GET /api/setup/folders?path=` → `FolderListing` (Browse…); 404 / 422
 * - `POST /api/setup/complete` → `SetupState` (Finish)
 */
export async function registerSetupRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { setup, supervisor } = context;

  app.get('/api/setup', async (): Promise<SetupState> => setup.state());

  app.get<{ Querystring: PathQuery }>('/api/setup/root', async (request, reply): Promise<WorkspaceRootCheck | FastifyReply> => {
    const typed = request.query.path;
    if (typeof typed !== 'string' || typed.trim() === '') return reply.code(400).send({ error: 'invalid', message: 'path is required' });
    return setup.checkRoot(typed);
  });

  app.put('/api/setup/root', async (request, reply): Promise<SetupState | FastifyReply> => {
    const body = request.body as { path?: unknown } | undefined;
    if (typeof body?.path !== 'string' || body.path.trim() === '') {
      return reply.code(422).send({ error: 'invalid', message: 'path must be a folder path' });
    }
    try {
      return await setup.saveRoot(body.path, { liveProcesses: supervisor.liveCount });
    } catch (error) {
      return sendSetupError(reply, error);
    }
  });

  app.get<{ Querystring: PathQuery }>('/api/setup/folders', async (request, reply): Promise<FolderListing | FastifyReply> => {
    try {
      return await setup.folders(typeof request.query.path === 'string' ? request.query.path : undefined);
    } catch (error) {
      return sendSetupError(reply, error);
    }
  });

  app.post('/api/setup/complete', async (): Promise<SetupState> => setup.complete());
}
