import type { FastifyInstance } from 'fastify';
import { type InsightsAnswer, parseInsightsQuery } from '../../core/insights.ts';
import type { ApiContext } from '../routes.ts';

/**
 * D108 (`docs/insights.md`, contract → *Insights (D108)*):
 * `GET /api/insights?period=7d|30d|90d|custom&from=&to=&folder=&cli=&model=&account=` →
 * {@link InsightsAnswer}, the whole page in one answer, computed from this machine's data only
 * (a paired machine's Insights are read through `/api/machines/{id}/api/insights`). 422
 * `invalid` with `errors` for a bad parameter.
 */
export async function registerInsightsRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  app.get<{ Querystring: Record<string, string | undefined> }>('/api/insights', async (request, reply): Promise<InsightsAnswer | undefined> => {
    const parsed = parseInsightsQuery(request.query, new Date());
    if (!parsed.ok) {
      await reply.code(422).send({ error: 'invalid', errors: parsed.errors });
      return undefined;
    }
    return context.insights.answer(parsed.query);
  });
}
