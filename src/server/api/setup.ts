import type { FastifyInstance, FastifyReply } from 'fastify';
import type { FolderListing, SetupState } from '../../core/api.ts';
import type { ApiContext } from '../routes.ts';
import { SetupError } from '../setup/service.ts';

interface PathQuery {
  readonly path?: string;
}

function sendSetupError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof SetupError) return reply.code(error.status).send({ error: error.code, message: error.message });
  throw error;
}

/**
 * The first-run wizard's routes (M5.3, additive to the contract; `docs/setup.md`
 * → *API*), all behind the usual Host/Origin guard and `sb_token` cookie:
 * - `GET /api/setup` → `SetupState` (D14: with the saved folders instead of a workspace root)
 * - `GET /api/setup/folders?path=` → `FolderListing` (Browse…: the wizard, Settings → Folders, the New-session form); 404 / 422
 * - `POST /api/setup/complete` → `SetupState` (Finish)
 *
 * D14: the workspace-root routes (`GET/PUT /api/setup/root`) are gone; folders are
 * checked and saved through `/api/folders` (`docs/folders.md`).
 */
export async function registerSetupRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { setup } = context;

  app.get('/api/setup', async (): Promise<SetupState> => setup.state());

  app.get<{ Querystring: PathQuery }>('/api/setup/folders', async (request, reply): Promise<FolderListing | FastifyReply> => {
    try {
      return await setup.folders(typeof request.query.path === 'string' ? request.query.path : undefined);
    } catch (error) {
      return sendSetupError(reply, error);
    }
  });

  app.post('/api/setup/complete', async (): Promise<SetupState> => setup.complete());
}
