import type { FastifyInstance } from 'fastify';
import { type InsightsAnswer, type InsightsRows, parseInsightsQuery } from '../../core/insights.ts';
import { USAGE_MAX_SPAN_MS, type UsageAnswer, type UsageRows, parseUsageQuery } from '../../core/usage-breakdown.ts';
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
 * - D134 `GET /api/insights/usage?period=5h|week|today|7d&account=&groupBy=session|folder|model|account|kind&from=&group=&page=&pageSize=&machine=all|local&peers=cached|wait`
 *   → {@link UsageAnswer} ("Where your usage went", `docs/insights.md` → *Usage breakdown*);
 *   `format=csv` answers the whole log as a CSV download instead.
 * - D134 `GET /api/insights/usage/rows?from=&to=` (ISO times, at most 8 days apart) →
 *   {@link UsageRows}: this machine's turns, accounts and sessions (the peer API's pull).
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

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/insights/usage', async (request, reply): Promise<UsageAnswer | string | undefined> => {
    const parsed = parseUsageQuery(request.query, new Date());
    const machine = request.query['machine'] ?? 'all';
    const peers = request.query['peers'] ?? 'cached';
    const format = request.query['format'] ?? 'json';
    const errors = parsed.ok ? [] : [...parsed.errors];
    if (machine !== 'all' && machine !== 'local') errors.push({ field: 'machine', message: 'machine must be all or local (a paired machine: through /api/machines/{id}/api/insights/usage)' });
    if (peers !== 'cached' && peers !== 'wait') errors.push({ field: 'peers', message: 'peers must be cached or wait' });
    if (format !== 'json' && format !== 'csv') errors.push({ field: 'format', message: 'format must be json or csv' });
    if (!parsed.ok || errors.length > 0) {
      await reply.code(422).send({ error: 'invalid', errors });
      return undefined;
    }
    const scope = isPeerRequest(request) || machine === 'local' ? 'local' : 'all';
    if (format === 'csv') {
      const csv = await context.usage.csv(parsed.query, { scope });
      await reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="switchboard-usage-${parsed.query.period}.csv"`)
        .send(csv);
      return undefined;
    }
    return context.usage.answer(parsed.query, { scope, peers: peers === 'wait' ? 'wait' : 'cached' });
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/insights/usage/rows', async (request, reply): Promise<UsageRows | undefined> => {
    const from = Date.parse(request.query['from'] ?? '');
    const to = Date.parse(request.query['to'] ?? '');
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to - from > USAGE_MAX_SPAN_MS) {
      await reply.code(422).send({ error: 'invalid', errors: [{ field: 'from', message: 'from and to must be ISO times, from ≤ to, at most 8 days apart' }] });
      return undefined;
    }
    return context.usage.rows(new Date(from).toISOString(), new Date(to).toISOString());
  });
}
