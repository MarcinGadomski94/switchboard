import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Folder, FolderCheck, FolderInUse } from '../../core/api.ts';
import { FolderError } from '../folders/service.ts';
import type { ApiContext } from '../routes.ts';

interface IdParams {
  readonly id: string;
}

/**
 * Sends a folder refusal as `{ error: <code>, message }` (+ `check` for `invalid`,
 * + `schedules` for `folder-in-use`); rethrows anything else.
 */
export function sendFolderError(reply: FastifyReply, error: unknown): FastifyReply {
  if (!(error instanceof FolderError)) throw error;
  if (error.code === 'folder-in-use') {
    const body: FolderInUse = { error: 'folder-in-use', message: error.message, schedules: error.schedules };
    return reply.code(error.status).send(body);
  }
  return reply.code(error.status).send({ error: error.code, message: error.message, ...(error.check ? { check: error.check } : {}) });
}

/**
 * The saved folders (D14, additive to the contract; `docs/folders.md` → *API*),
 * behind the usual Host/Origin guard and `sb_token` cookie:
 * - `GET /api/folders` → `Folder[]` (each with its live `check`), the default first, then most recently used;
 * - `GET /api/folders/check?path=` → `FolderCheck` (the Browse… check line; nothing is saved); 400 without `path`;
 * - `POST /api/folders` `{ path }` → `201 Folder` (added) or `200 Folder` (that folder is saved already);
 *   `422 { error: "invalid", message, check }` when it is not a workspace or a git repo;
 * - `DELETE /api/folders/{id}` → `200 Folder[]` (the list left); 404; `409 folder-in-use` (`FolderInUse`) while schedules run there;
 * - `PUT /api/folders/{id}/default` → `200 Folder[]`; 404.
 */
export async function registerFolderRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { folders } = context;

  app.get('/api/folders', async (): Promise<Folder[]> => folders.list());

  app.get<{ Querystring: { path?: string } }>('/api/folders/check', async (request, reply): Promise<FolderCheck | FastifyReply> => {
    const typed = request.query.path;
    if (typeof typed !== 'string' || typed.trim() === '') return reply.code(400).send({ error: 'invalid', message: 'path is required' });
    return folders.check(typed);
  });

  app.post('/api/folders', async (request, reply): Promise<Folder | FastifyReply> => {
    const body = request.body as { path?: unknown } | null | undefined;
    if (typeof body?.path !== 'string' || body.path.trim() === '') {
      return reply.code(422).send({ error: 'invalid', message: 'path must be a folder path' });
    }
    try {
      const { folder, created } = await folders.add(body.path);
      return reply.code(created ? 201 : 200).send(folder);
    } catch (error) {
      return sendFolderError(reply, error);
    }
  });

  app.delete<{ Params: IdParams }>('/api/folders/:id', async (request, reply): Promise<Folder[] | FastifyReply> => {
    try {
      return await folders.remove(request.params.id);
    } catch (error) {
      return sendFolderError(reply, error);
    }
  });

  app.put<{ Params: IdParams }>('/api/folders/:id/default', async (request, reply): Promise<Folder[] | FastifyReply> => {
    try {
      return await folders.setDefault(request.params.id);
    } catch (error) {
      return sendFolderError(reply, error);
    }
  });
}
