import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ArtifactListItem } from '../../core/api.ts';
import { matchesArtifactQuery, parseTypeParam } from '../../core/artifacts-view.ts';
import type { ArtifactRecord } from '../db/repos/artifacts.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import type { ApiContext } from '../routes.ts';
import { toArtifact } from '../sessions/wire.ts';
import type { PendingRoute } from './not-implemented.ts';

/** Artifact routes (contract → REST) not implemented yet: none since M7.3. */
export const ARTIFACT_ROUTES_PENDING: readonly PendingRoute[] = [];

interface ArtifactQueryString {
  readonly type?: string | string[];
  readonly q?: string | string[];
}

/** A stored artifact as a row of the global list (session name, its folder (D14), last update). */
function toListItem(record: ArtifactRecord, sessions: ReadonlyMap<string, SessionRecord>): ArtifactListItem {
  const session = record.sessionId ? (sessions.get(record.sessionId) ?? null) : null;
  return {
    ...toArtifact(record),
    sessionName: session?.name ?? null,
    updatedAt: record.updatedAt,
    folder: session?.folderId ?? null,
    folderPath: session?.root ?? null,
  };
}

/**
 * The global artifact list: every stored artifact (gap #9, derived by the
 * recorder) of the given types, matching `q` over what the view shows (type,
 * name, "Solution · branch", session name, status), most recently updated first;
 * each row tagged with its session's folder (D14).
 */
export async function listArtifacts(store: Store, query: { readonly types: readonly ArtifactListItem['type'][] | null; readonly q: string }): Promise<ArtifactListItem[]> {
  const records = await store.artifacts.list(query.types ? { types: query.types } : {});
  const sessions = new Map((await store.sessions.list()).map((session) => [session.id, session]));
  return records.map((record) => toListItem(record, sessions)).filter((item) => matchesArtifactQuery(item, query.q));
}

/**
 * Registers the artifact routes (M7.3, `docs/derivations.md` → *Artifacts view*):
 * `GET /api/artifacts?type=&q=` → {@link ArtifactListItem}[]. `type` = artifact
 * types separated by commas (`PR,BRANCH`), case-insensitive, blank = all; an
 * unknown type answers `400 {error:"invalid", message}`. `q` is a
 * case-insensitive substring (the last value when repeated).
 */
export async function registerArtifactRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { store } = context;

  app.get<{ Querystring: ArtifactQueryString }>('/api/artifacts', async (request, reply): Promise<ArtifactListItem[] | FastifyReply> => {
    const types = parseTypeParam(request.query.type);
    if (!types.ok) {
      return reply.code(400).send({ error: 'invalid', message: `unknown artifact type: ${types.unknown.join(', ')}` });
    }
    const rawQ = request.query.q;
    const q = Array.isArray(rawQ) ? (rawQ.at(-1) ?? '') : (rawQ ?? '');
    return listArtifacts(store, { types: types.types, q });
  });
}
