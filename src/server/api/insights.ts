import type { FastifyInstance } from 'fastify';
import { type InsightsAnswer, type InsightsRows, parseInsightsQuery } from '../../core/insights.ts';
import type { ApiContext } from '../routes.ts';
import { isPeerRequest } from './machines.ts';

/**
 * D108 (`docs/insights.md`, contract → *Insights (D108)*):
 * - `GET /api/insights?period=7d|30d|90d|custom&from=&to=&folder=&cli=&model=&account=&machine=all|local&peers=cached|wait`
 *   → {@link InsightsAnswer}, the whole page in one answer. `machine` (ruling: default `all`)
 *   merges the paired machines' rows; `peers=cached` (default) never waits for them, `wait`
 *   waits up to 2.5 s each. A paired machine's request always answers that machine alone.
 * - `GET /api/insights/rows?from=&to=` → {@link InsightsRows}: this machine's rows of those
 *   days, what a paired machine merges (the peer API).
 * 422 `invalid` with `errors` for a bad parameter.
 */
export async function registerInsightsRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  app.get<{ Querystring: Record<string, string | undefined> }>('/api/insights', async (request, reply): Promise<InsightsAnswer | undefined> => {
    const parsed = parseInsightsQuery(request.query, new Date());
    const machine = request.query['machine'] ?? 'all';
    const peers = request.query['peers'] ?? 'cached';
    const errors = parsed.ok ? [] : [...parsed.errors];
    if (machine !== 'all' && machine !== 'local') errors.push({ field: 'machine', message: 'machine must be all or local (a paired machine: through /api/machines/{id}/api/insights)' });
    if (peers !== 'cached' && peers !== 'wait') errors.push({ field: 'peers', message: 'peers must be cached or wait' });
    if (!parsed.ok || errors.length > 0) {
      await reply.code(422).send({ error: 'invalid', errors });
      return undefined;
    }
    return context.insights.answer(parsed.query, { scope: isPeerRequest(request) || machine === 'local' ? 'local' : 'all', peers: peers === 'wait' ? 'wait' : 'cached' });
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/insights/rows', async (request, reply): Promise<InsightsRows | undefined> => {
    const parsed = parseInsightsQuery({ period: 'custom', from: request.query['from'], to: request.query['to'] }, new Date());
    if (!parsed.ok) {
      await reply.code(422).send({ error: 'invalid', errors: parsed.errors });
      return undefined;
    }
    return context.insights.rows(parsed.query.from, parsed.query.to);
  });
}
