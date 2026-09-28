import type { FastifyInstance } from 'fastify';
import type { HistoryItem } from '../../core/api.ts';
import { ConversationMover } from '../history/continue.ts';
import { TranscriptHistory, claudeConfigDir } from '../history/transcripts.ts';
import type { ApiContext } from '../routes.ts';
import { toSession } from '../sessions/wire.ts';
import type { PendingRoute } from './not-implemented.ts';

/** History routes (contract → REST) not implemented yet: none since M7.4. */
export const HISTORY_ROUTES_PENDING: readonly PendingRoute[] = [];

interface HistoryQueryString {
  readonly q?: string | string[];
}

interface ContinueParams {
  readonly claudeSessionId: string;
}

/**
 * Registers the History routes (M7.4, `docs/derivations.md` → *History*):
 * `GET /api/history?q=` → {@link HistoryItem}[], newest first. `q` is a
 * case-insensitive substring (the last value when repeated) matched against the
 * row, the task, the prompts, the last reply, the folders and the session id.
 * The rows come from `providers.history` (the demo's when `SWITCHBOARD_DEMO=1`),
 * else from the stored sessions + the transcripts under `$CLAUDE_CONFIG_DIR` or
 * `~/.claude` for every saved folder and every session's folder (D14,
 * {@link TranscriptHistory}); each row carries its folder.
 *
 * D16 (additive): `POST /api/history/{claudeSessionId}/continue` `{ name?,
 * title? (D22), addFolder?, confirm? }` moves a terminal conversation into Switchboard as the
 * same conversation ({@link ConversationMover}): `201 Session`, or 404 / 409
 * (`already-in-switchboard`, `folder-not-saved`, `terminal-open`,
 * `folder-missing`) / 422 (`not-in-a-folder`, `not-a-terminal-conversation`,
 * `invalid`) / 503 (`closing`).
 */
export async function registerHistoryRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  const provider =
    context.providers.history ??
    new TranscriptHistory({ store: context.store, configDir: claudeConfigDir() });

  app.get<{ Querystring: HistoryQueryString }>('/api/history', async (request): Promise<HistoryItem[]> => {
    const rawQ = request.query.q;
    const q = Array.isArray(rawQ) ? (rawQ.at(-1) ?? '') : (rawQ ?? '');
    return provider.history(q);
  });

  const mover = new ConversationMover({ store: context.store, supervisor: context.supervisor, folders: context.folders });
  app.post<{ Params: ContinueParams }>('/api/history/:claudeSessionId/continue', async (request, reply) => {
    const outcome = await mover.continue(request.params.claudeSessionId, request.body);
    if (!outcome.ok) return reply.code(outcome.status).send(outcome.body);
    return reply.code(201).send(await toSession(context.store, outcome.record));
  });
}
