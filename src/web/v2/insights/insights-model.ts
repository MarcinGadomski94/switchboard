import {
  type AccuracyDistribution,
  type InsightsAnswer,
  type InsightsPeriodKey,
  type OutcomeRow,
  type PeriodCostRow,
  type RoutingSuggestion,
  insightsQueryString,
  utcDay,
} from '../../../core/insights.ts';
import { INSIGHTS_WORDS } from '../glossary.ts';
import { toV2Path } from '../routes.ts';
import { suggestionPath } from '../../views/insights/insights-view.ts';

/**
 * D131 · lane R · the v2 Insights page's pure part (`/insights`): the range and
 * filters in the address, the D108 API query (`GET /api/insights`), the tiles'
 * numbers, and the plain charts' geometry (inline SVG). No DOM.
 */

/** The prototype's ranges. */
export type InsightsRange = 'today' | 'week' | 'month';

/** The ranges in order. */
export const INSIGHTS_RANGES: readonly InsightsRange[] = ['today', 'week', 'month'];

/** The D108 period of a range: Today = today only (UTC, as the API counts days), This week = the last 7 days, This month = the last 30. */
export const RANGE_PERIOD: Readonly<Record<InsightsRange, InsightsPeriodKey>> = { today: 'custom', week: '7d', month: '30d' };

/** The page's filters (`null` = all). `computer`: `null` all computers (merged), `local` this one, else a paired machine's id. */
export interface InsightsFilters {
  readonly range: InsightsRange;
  readonly folder: string | null;
  readonly cli: string | null;
  readonly model: string | null;
  readonly account: string | null;
  readonly computer: string | null;
}

/** The filters in an address's query (`?range=week&folder=…`); anything unknown is the default (Today, everything). */
export function parseInsightsAddress(search: string): InsightsFilters {
  const params = new URLSearchParams(search);
  const range = params.get('range');
  const value = (key: string): string | null => {
    const raw = params.get(key);
    return raw === null || raw === '' || raw === 'all' ? null : raw;
  };
  return {
    range: (INSIGHTS_RANGES as readonly string[]).includes(range ?? '') ? (range as InsightsRange) : 'today',
    folder: value('folder'),
    cli: value('engine'),
    model: value('model'),
    account: value('account'),
    computer: value('computer'),
  };
}

/** The page's address for `filters` (defaults left out). */
export function insightsAddress(filters: InsightsFilters): string {
  const params = new URLSearchParams();
  if (filters.range !== 'today') params.set('range', filters.range);
  if (filters.folder !== null) params.set('folder', filters.folder);
  if (filters.cli !== null) params.set('engine', filters.cli);
  if (filters.model !== null) params.set('model', filters.model);
  if (filters.account !== null) params.set('account', filters.account);
  if (filters.computer !== null) params.set('computer', filters.computer);
  const text = params.toString();
  return text ? `/insights?${text}` : '/insights';
}

/**
 * The API query string of `filters` for `range` (the machine is the request's
 * path, see `useInsights`). Folder and model values `none` mean "no folder" /
 * "the default model", as the API reads them.
 */
export function insightsApiQuery(filters: InsightsFilters, now: Date, range: InsightsRange = filters.range): string {
  const today = utcDay(now);
  const none = (value: string | null): string | null => (value === 'none' ? '' : value);
  return insightsQueryString({ period: RANGE_PERIOD[range], from: today, to: today, folder: none(filters.folder), cli: filters.cli, model: none(filters.model), account: filters.account });
}

/** The query of the tokens-per-day chart: the range's own, but at least the last 7 days (Today's chart shows the week). */
export function trendApiQuery(filters: InsightsFilters, now: Date): string {
  return insightsApiQuery(filters, now, filters.range === 'today' ? 'week' : filters.range);
}

/** Tokens: `850`, `41k`, `1.2M`. */
export function tokensShort(n: number): string {
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${n < 10_000 ? (n / 1_000).toFixed(1).replace(/\.0$/, '') : Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, '')}M`;
}

/** A duration: `<1m`, `42m`, `6h 40m`. */
export function durationShort(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return ms > 0 ? '<1m' : '0m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

/** Money: `~$8.40` (approximate: the API's prices), `—` unknown; amounts under 0.1 keep 4 decimals. */
export function money(amount: number | null, currency: string, approx = true): string {
  if (amount === null) return '—';
  const digits = amount !== 0 && Math.abs(amount) < 0.1 ? 4 : 2;
  let text: string;
  try {
    text = new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
  } catch {
    text = `${amount.toFixed(digits)} ${currency}`;
  }
  return approx && amount !== 0 ? `~${text}` : text;
}

/** A share as a whole percentage (`82%`), `—` when unknown. */
export function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

/** Estimate accuracy: the share of finished, estimated tasks that took between half and twice their estimate. `null` with none. */
export function estimateAccuracy(estimates: Pick<AccuracyDistribution, 'count' | 'buckets'>): number | null {
  if (estimates.count === 0) return null;
  const within = estimates.buckets.filter((bucket) => bucket.key === 'half-to-one' || bucket.key === 'one-to-two').reduce((sum, bucket) => sum + bucket.count, 0);
  return within / estimates.count;
}

/** Rework: tasks reopened and changes sent back, over the period (`rate` = reopened ÷ done; `null` with none done). */
export function rework(rows: readonly OutcomeRow[]): { readonly rate: number | null; readonly reopened: number; readonly done: number; readonly sentBack: number } {
  let done = 0;
  let reopened = 0;
  let sentBack = 0;
  for (const row of rows) {
    done += row.todos.done;
    reopened += row.todos.reopened;
    sentBack += row.plans?.decisions.sentBack ?? 0;
  }
  return { rate: done > 0 ? reopened / done : null, reopened, done, sentBack };
}

/** One bar of a vertical bar chart (heights in % of the plot). */
export interface Bar {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly valueText: string;
  /** 0–100. */
  readonly height: number;
  /** The last bar (today) is drawn darker. */
  readonly last: boolean;
}

/** Day labels: the weekday (`Mon`), `Today` for today; `14 Oct` for longer ranges. */
export function dayLabel(day: string, today: string, long: boolean): string {
  if (day === today) return 'Today';
  const at = new Date(`${day}T00:00:00.000Z`);
  return long ? at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : at.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
}

/** The tokens-per-day bars (heights relative to the tallest; a zero day keeps a sliver at 0). */
export function tokenBars(trend: ReadonlyArray<{ readonly day: string; readonly tokens: number }>, today: string): Bar[] {
  const max = Math.max(0, ...trend.map((point) => point.tokens));
  const long = trend.length > 7;
  return trend.map((point, index) => ({
    key: point.day,
    label: dayLabel(point.day, today, long),
    value: point.tokens,
    valueText: tokensShort(point.tokens),
    height: max > 0 ? Math.round((point.tokens / max) * 1000) / 10 : 0,
    last: index === trend.length - 1,
  }));
}

/** The chart's text alternative: `Tokens per day: Mon 0.8M, Tue 1.1M, …`. */
export function barsLabel(title: string, bars: readonly Bar[]): string {
  return `${title}: ${bars.map((bar) => `${bar.label} ${bar.valueText}`).join(', ')}`;
}

/** One horizontal bar (width in % of the largest). */
export interface HBar {
  readonly key: string;
  readonly label: string;
  readonly valueText: string;
  readonly width: number;
}

/** Where the cost went: the top `top` folders by cost, then "Everything else" (unpriced rows left out). */
export function costBars(rows: readonly PeriodCostRow[], currency: string, top = 3): HBar[] {
  const priced = rows.filter((row) => row.cost !== null && row.cost > 0).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
  const head = priced.slice(0, top).map((row) => ({ key: row.key, label: row.label || INSIGHTS_WORDS.noFolder, cost: row.cost ?? 0 }));
  const rest = priced.slice(top).reduce((sum, row) => sum + (row.cost ?? 0), 0);
  const all = rest > 0 ? [...head, { key: '__rest', label: INSIGHTS_WORDS.everythingElse, cost: rest }] : head;
  const max = Math.max(0, ...all.map((row) => row.cost));
  return all.map((row) => ({ key: row.key, label: row.label, valueText: money(row.cost, currency, false), width: max > 0 ? Math.round((row.cost / max) * 1000) / 10 : 0 }));
}

/** Estimate vs. actual: one bar per accuracy bucket (`< 0.5×` … `> 2×`) with its count. */
export function accuracyBars(estimates: Pick<AccuracyDistribution, 'buckets'>): HBar[] {
  const max = Math.max(0, ...estimates.buckets.map((bucket) => bucket.count));
  return estimates.buckets.map((bucket) => ({ key: bucket.key, label: `${bucket.label} the estimate`, valueText: String(bucket.count), width: max > 0 ? Math.round((bucket.count / max) * 1000) / 10 : 0 }));
}

/** `true` when the answer has nothing to show (no turns, no finished tasks). */
export function isEmpty(answer: Pick<InsightsAnswer, 'time' | 'estimates'>): boolean {
  return answer.time.totals.turns === 0 && answer.estimates.count === 0 && answer.time.chats.turns === 0;
}

/** Where a suggestion's Switch leads: Settings › Advanced › Sessions & worktrees with the rule pre-filled (Model by task, never saved by itself). */
export function suggestionHref(suggestion: Pick<RoutingSuggestion, 'rule'>): string {
  return toV2Path(suggestionPath(suggestion));
}

/** The range's word for the tiles (`today`, `this week`, `this month`). */
export function rangeWord(range: InsightsRange): string {
  return INSIGHTS_WORDS.ranges[range].toLowerCase();
}
