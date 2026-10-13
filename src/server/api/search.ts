import type { FastifyInstance } from 'fastify';
import { SEARCH_LIMIT_MAX, SEARCH_QUERY_MAX, type SearchAnswer, decodeSearchCursor, isSearchScope } from '../../core/search.ts';
import type { ApiContext } from '../routes.ts';
import { isPeerRequest } from './machines.ts';

interface SearchQueryString {
  readonly q?: string;
  readonly scope?: string;
  readonly session?: string;
  readonly machine?: string;
  readonly limit?: string;
  readonly cursor?: string;
}

/**
 * D97 (`docs/search.md`, contract → *Search (D97)*): `GET /api/search?q=&scope=&session=&machine=&limit=&cursor=`
 * → {@link SearchAnswer}. `scope` = `all` (default) or one of `conversations`, `artifacts`,
 * `todos`, `history`; `session` = only that session (a paired machine's remote id:
 * only there); `machine` = `all` (default), `local` or a paired machine's id; `limit`
 * 1–50 (default 5 per group for `all`, 20 for one scope); `cursor` = a group's
 * `nextCursor` (one scope only). 422 `invalid` with `errors` for a bad parameter. A
 * paired machine's request (the peer API) answers this machine's index only.
 */
export async function registerSearchRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  app.get<{ Querystring: SearchQueryString }>('/api/search', async (request, reply): Promise<SearchAnswer | undefined> => {
    const { q = '', scope = 'all', session, machine = 'all', limit, cursor } = request.query;
    const errors: Array<{ field: string; message: string }> = [];
    if (typeof q !== 'string' || q.length > SEARCH_QUERY_MAX * 5) errors.push({ field: 'q', message: `q must be text of at most ${SEARCH_QUERY_MAX * 5} characters` });
    if (scope !== 'all' && !isSearchScope(scope)) errors.push({ field: 'scope', message: 'scope must be all, conversations, artifacts, todos or history' });
    if (session !== undefined && (typeof session !== 'string' || session === '' || session.length > 200)) errors.push({ field: 'session', message: 'session must be a session id' });
    if (typeof machine !== 'string' || machine === '' || machine.length > 100) errors.push({ field: 'machine', message: 'machine must be all, local or a paired machine id' });
    if (limit !== undefined && !(/^[1-9][0-9]?$/.test(limit) && Number(limit) <= SEARCH_LIMIT_MAX)) errors.push({ field: 'limit', message: `limit must be a whole number from 1 to ${SEARCH_LIMIT_MAX}` });
    const parsedCursor = cursor === undefined ? null : decodeSearchCursor(cursor);
    if (cursor !== undefined && parsedCursor === null) errors.push({ field: 'cursor', message: 'cursor must be a nextCursor of an earlier answer' });
    if (cursor !== undefined && scope === 'all') errors.push({ field: 'cursor', message: 'cursor pages one scope: pass scope too' });
    if (errors.length > 0) {
      await reply.code(422).send({ error: 'invalid', errors });
      return undefined;
    }
    return context.search.search({
      q,
      scope: isSearchScope(scope) ? scope : 'all',
      session: session ?? null,
      machine,
      limit: limit === undefined ? null : Number(limit),
      cursor: parsedCursor,
      fromPeer: isPeerRequest(request),
    });
  });
}
