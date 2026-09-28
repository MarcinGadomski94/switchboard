import type { FastifyInstance } from 'fastify';
import type { HistoryItem } from '../../core/api.ts';
import { TranscriptHistory, claudeConfigDir } from '../history/transcripts.ts';
import type { ApiContext } from '../routes.ts';
import type { PendingRoute } from './not-implemented.ts';

/** History routes (contract → REST) not implemented yet: none since M7.4. */
export const HISTORY_ROUTES_PENDING: readonly PendingRoute[] = [];

interface HistoryQueryString {
  readonly q?: string | string[];
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
}
