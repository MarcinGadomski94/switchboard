import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Folder, FolderBindPreview, FolderCheck, FolderInUse } from '../../core/api.ts';
import type { ProfileScope } from '../../core/user-profiles.ts';
import { FolderError } from '../folders/service.ts';
import type { ApiContext } from '../routes.ts';
import { toSession } from '../sessions/wire.ts';
import { UserProfileError } from '../user-profiles/service.ts';

interface IdParams {
  readonly id: string;
}

/** The 422 of a `label` that is neither a string nor `null` (D18). */
const LABEL_TYPE_MESSAGE = 'label must be a folder name (a string) or null';

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
 *   `422 { error: "invalid", message, check }` when it is not an existing folder (D59: a plain folder, neither workspace nor repo, is saved);
 * - `DELETE /api/folders/{id}` → `200 Folder[]` (the list left); 404; `409 folder-in-use` (`FolderInUse`) while schedules run there;
 * - `PUT /api/folders/{id}/default` → `200 Folder[]`; 404.
 *
 * D18 (additive): `POST /api/folders` takes an optional `label` (the folder's custom
 * name), and `PUT /api/folders/{id}/label` `{ label: string | null }` renames a
 * folder (`null` or empty = its own name again) → `200 Folder[]`; 404; `409
 * label-taken` (another saved folder has that name, ignoring case); `422
 * invalid-label` (over 40 characters, or not a string / `null`).
 *
 * D169 (additive): a folder bound to a profile is invisible to the others (every route above answers
 * 404 for it, as if it did not exist; `GET` lists leave it out). `GET /api/folders/{id}/user-profile/preview?to=`
 * → `FolderBindPreview` (the agents and schedules that move); `PUT /api/folders/{id}/user-profile`
 * `{ userProfileId | null, password?, currentPassword? }` binds it (the target's password; a re-bind also
 * the present owner's) or shares it again (`null`: the owner's password) → `{ folderId, userProfileId,
 * moved, schedules }`; 401 / 429 / 404 / 422. Refused to paired phones (`devices/local-only.ts`).
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
    const body = request.body as { path?: unknown; label?: unknown } | null | undefined;
    if (typeof body?.path !== 'string' || body.path.trim() === '') {
      return reply.code(422).send({ error: 'invalid', message: 'path must be a folder path' });
    }
    const label = body.label;
    if (label !== undefined && label !== null && typeof label !== 'string') {
      return reply.code(422).send({ error: 'invalid-label', message: LABEL_TYPE_MESSAGE });
    }
    try {
      const { folder, created } = await folders.add(body.path, label);
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

  app.put<{ Params: IdParams }>('/api/folders/:id/label', async (request, reply): Promise<Folder[] | FastifyReply> => {
    const body = request.body as { label?: unknown } | null | undefined;
    const label = body?.label;
    if (label !== null && typeof label !== 'string') return reply.code(422).send({ error: 'invalid-label', message: LABEL_TYPE_MESSAGE });
    try {
      return await folders.rename(request.params.id, label);
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

  // D169: a folder bound to a profile (docs/profiles.md → *A folder bound to a profile*). Local only (not a phone's).
  const profiles = context.userProfiles;
  if (!profiles) return;
  const refuse = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof UserProfileError) return reply.code(error.status).header('cache-control', 'no-store').send({ error: error.code, message: error.message });
    throw error;
  };
  const chosen = (scope: ProfileScope): boolean => scope !== null;

  app.get<{ Params: IdParams; Querystring: { to?: string } }>('/api/folders/:id/user-profile/preview', async (request, reply): Promise<FolderBindPreview | FastifyReply> => {
    if (!chosen(request.userProfileScope)) return reply.code(404).send({ error: 'not-found', message: `no saved folder ${request.params.id}` });
    const to = request.query.to;
    if (typeof to !== 'string' || to === '') return reply.code(422).send({ error: 'invalid', message: 'to must be a profile id' });
    try {
      return await profiles.folderBindPreview(request.params.id, to);
    } catch (error) {
      return refuse(reply, error);
    }
  });

  app.put<{ Params: IdParams }>('/api/folders/:id/user-profile', async (request, reply) => {
    if (!chosen(request.userProfileScope)) return reply.code(404).send({ error: 'not-found', message: `no saved folder ${request.params.id}` });
    try {
      const result = await profiles.bindFolder(request.params.id, request.body);
      for (const sessionId of result.moved) {
        const record = await context.store.sessions.get(sessionId);
        if (record) context.bus.publish('sessionUpdated', await toSession(context.store, record, context.supervisor.activity(record.id)));
      }
      return result;
    } catch (error) {
      return refuse(reply, error);
    }
  });
}
