import { type InsightAccount, type InsightsAnswer, type InsightsQuery, type PlanOutcomeRow, addDays, buildInsights, insightsQueryString } from '../../core/insights.ts';
import { creditsInUse, creditsMoneyText } from '../../core/credits.ts';
import type { AccountService } from '../accounts/service.ts';
import type { Store } from '../db/store.ts';
import { priceTableOf } from '../settings/settings.ts';
import type { InsightsBackfill } from './backfill.ts';
// Plans (D99) hook: the plan items' outcomes while Plans is on (docs/plans-removal.md).
import { plansInsightOutcomes } from '../plans/hooks.ts';

/** An answer is reused for this long while nothing was rolled up (ms). */
export const INSIGHTS_CACHE_MS = 30_000;

/** The forecast reads the readings of this many hours (the weekly pace's lookback). */
const READINGS_LOOKBACK_MS = 24 * 60 * 60_000;

/** Options of {@link InsightsService}. */
export interface InsightsServiceOptions {
  readonly store: Store;
  readonly backfill: InsightsBackfill;
  readonly accounts: Pick<AccountService, 'usageOf'>;
  readonly now?: () => Date;
  readonly cacheMs?: number;
}

/**
 * D108 (`docs/insights.md`): answers `GET /api/insights` from indexed reads only: the daily
 * rollup of the period's days, `todo_actuals` of the period (by `completed_at`), the D102
 * Merge-step decisions of the period, the last 24 h of usage readings (per account), the
 * account list and, while Plans is on, its items' outcomes. An answer is cached per query
 * for {@link INSIGHTS_CACHE_MS} and dropped as soon as the rollup or a todo's actuals change.
 */
export class InsightsService {
  readonly #store: Store;
  readonly #backfill: InsightsBackfill;
  readonly #accounts: Pick<AccountService, 'usageOf'>;
  readonly #now: () => Date;
  readonly #cacheMs: number;
  readonly #cache = new Map<string, { readonly at: number; readonly stamp: string; readonly answer: InsightsAnswer }>();

  constructor(options: InsightsServiceOptions) {
    this.#store = options.store;
    this.#backfill = options.backfill;
    this.#accounts = options.accounts;
    this.#now = options.now ?? (() => new Date());
    this.#cacheMs = options.cacheMs ?? INSIGHTS_CACHE_MS;
  }

  /** What changes the answer (with the prices): the rollup's writes, the completed todos and their reopens, the backfill's state. */
  #stamp(): string {
    const todos = this.#store.db.prepare('SELECT COUNT(*) AS n, MAX(completed_at) AS m, (SELECT COUNT(*) FROM todo_reopens) AS r FROM todo_actuals').get();
    return `${this.#store.insights.revision}|${String(todos?.['n'])}|${String(todos?.['m'])}|${String(todos?.['r'])}|${this.#backfill.progress().percent}`;
  }

  /** The page's answer for `query`. */
  async answer(query: InsightsQuery): Promise<InsightsAnswer> {
    const now = this.#now();
    const key = insightsQueryString(query);
    const prices = await priceTableOf(this.#store.settings);
    const stamp = `${this.#stamp()}|${JSON.stringify(prices)}`;
    const cached = this.#cache.get(key);
    if (cached && cached.stamp === stamp && now.getTime() - cached.at < this.#cacheMs && cached.answer.query.to === query.to) return cached.answer;

    const insights = this.#store.insights;
    const fromIso = `${query.from}T00:00:00.000Z`;
    const toIso = `${addDays(query.to, 1)}T00:00:00.000Z`;
    const turns = insights.rollup(query.from, query.to);
    const todos = insights.todoActuals(fromIso, toIso);
    const mergeDecisions = insights.mergeDecisions(fromIso, toIso);
    const readings = insights.readings(new Date(now.getTime() - READINGS_LOOKBACK_MS).toISOString());

    // Plans (D99) hook: its items, with their run sessions' dimensions; null while Plans is off.
    const outcomes = await plansInsightOutcomes(this.#store).catch(() => null);
    let plans: PlanOutcomeRow[] | null = null;
    if (outcomes) {
      const dims = insights.sessionDims(outcomes.map((o) => o.runSessionId).filter((id): id is string => id !== null));
      plans = outcomes.map((o) => ({ itemId: o.itemId, outcome: o.outcome, at: o.at, ...(dims.get(o.runSessionId ?? '') ?? { provider: '', model: '', profileId: '', folder: '' }) }));
    }

    const profiles = await this.#store.profiles.list();
    const accounts: InsightAccount[] = [];
    for (const record of profiles) {
      if (record.cli !== 'claude') continue;
      const usage = await this.#accounts.usageOf(record).catch(() => null);
      const credits = usage?.credits ?? null;
      accounts.push({ id: record.id, cli: record.cli, name: record.name, credits: creditsMoneyText(credits), onCredits: creditsInUse(credits, now.getTime()) });
    }

    const answer = buildInsights({
      query,
      now,
      turns,
      todos,
      plans,
      mergeDecisions,
      readings,
      accounts,
      sessionTitles: insights.sessionTitles([...new Set(turns.map((row) => row.sessionId))]),
      prices,
      accountNames: new Map(profiles.map((record) => [record.id, record.name])),
      backfill: this.#backfill.progress(),
    });
    this.#cache.set(key, { at: now.getTime(), stamp, answer });
    if (this.#cache.size > 50) this.#cache.delete(this.#cache.keys().next().value as string);
    return answer;
  }
}
