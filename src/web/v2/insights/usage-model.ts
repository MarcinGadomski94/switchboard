import {
  USAGE_GROUPS,
  USAGE_PERIODS,
  type UsageAnswer,
  type UsageChart,
  type UsageEstimate,
  type UsageGroupBy,
  type UsagePeriod,
  type UsageSpan,
  usageQueryString,
} from '../../../core/usage-breakdown.ts';
import { USAGE_WORDS } from '../glossary.ts';
import { tokensShort } from './insights-model.ts';

/**
 * D134 · lane R · the pure part of Insights → Usage (`/insights?view=usage`): the filters in
 * the address, the API query (`GET /api/insights/usage`), the stacked chart's geometry and the
 * words of shares and estimates. No DOM.
 */

/** The Usage view's filters. `computer`: `null` all computers (merged), `local` this one, else a paired machine's id. */
export interface UsageFilters {
  readonly period: UsagePeriod;
  readonly account: string | null;
  readonly groupBy: UsageGroupBy;
  /** The log shows only this group's replies. */
  readonly group: string | null;
  /** The log's page (0-based). */
  readonly page: number;
  readonly computer: string | null;
}

/** `true` when the Insights address shows the Usage view. */
export function isUsageView(search: string): boolean {
  return new URLSearchParams(search).get('view') === 'usage';
}

/** The Usage view's filters from an address (`?view=usage&period=week&account=…`); anything unknown is the default (current 5-hour window, everything, by agent). */
export function parseUsageAddress(search: string): UsageFilters {
  const params = new URLSearchParams(search);
  const value = (key: string): string | null => {
    const raw = params.get(key);
    return raw === null || raw === '' || raw === 'all' ? null : raw;
  };
  const period = params.get('period');
  const groupBy = params.get('groupBy');
  const page = Number(params.get('page') ?? '0');
  return {
    period: (USAGE_PERIODS as readonly string[]).includes(period ?? '') ? (period as UsagePeriod) : '5h',
    account: value('account'),
    groupBy: (USAGE_GROUPS as readonly string[]).includes(groupBy ?? '') ? (groupBy as UsageGroupBy) : 'session',
    group: params.get('group'),
    page: Number.isInteger(page) && page > 0 ? page : 0,
    computer: value('computer'),
  };
}

/** The Usage view's address for `filters` (defaults left out). */
export function usageAddress(filters: UsageFilters): string {
  const params = new URLSearchParams();
  params.set('view', 'usage');
  if (filters.period !== '5h') params.set('period', filters.period);
  if (filters.account !== null) params.set('account', filters.account);
  if (filters.groupBy !== 'session') params.set('groupBy', filters.groupBy);
  if (filters.group !== null) params.set('group', filters.group);
  if (filters.page > 0) params.set('page', String(filters.page));
  if (filters.computer !== null) params.set('computer', filters.computer);
  return `/insights?${params.toString()}`;
}

/** The browser's midnight today (ISO): Today counts from it. */
export function localMidnight(now: Date): string {
  const at = new Date(now);
  at.setHours(0, 0, 0, 0);
  return at.toISOString();
}

/** The API query of `filters` (the machine is the request's path). */
export function usageApiQuery(filters: UsageFilters, now: Date): string {
  return usageQueryString({ period: filters.period, account: filters.account, groupBy: filters.groupBy, from: filters.period === 'today' ? localMidnight(now) : null, group: filters.group, page: filters.page });
}

/** The CSV download of the log (every page) for `filters`. */
export function usageCsvHref(filters: UsageFilters, now: Date): string {
  const query = `${usageApiQuery({ ...filters, page: 0 }, now)}&format=csv`;
  const remote = filters.computer !== null && filters.computer !== 'local';
  if (remote) return `/api/machines/${encodeURIComponent(filters.computer as string)}/api/insights/usage?${query}&machine=local`;
  return `/api/insights/usage?${query}&machine=${filters.computer === 'local' ? 'local' : 'all'}&peers=wait`;
}

/**
 * The status pill's "See what used it" for an account of the usage grid (its key is the
 * profile id, or `cli:<id>` for a CLI whose account is not known: its built-in Default).
 */
export function pillUsageHref(accountKey: string): string {
  const cli = /^cli:(.+)$/.exec(accountKey);
  return usageAddress({ period: '5h', account: cli ? `default-${cli[1] as string}` : accountKey, groupBy: 'session', group: null, page: 0, computer: null });
}

/** A share: `34%`, `<1%`, `0%`. */
export function shareText(share: number): string {
  if (share <= 0) return '0%';
  if (share < 0.01) return '<1%';
  return `${Math.round(share * 100)}%`;
}

/** "≈ 12% of the 5-hour limit" (an estimate, always labelled so by the caller). */
export function estimateText(estimate: UsageEstimate): string {
  const pct = estimate.pct > 0 && estimate.pct < 1 ? '<1%' : `${Math.round(estimate.pct)}%`;
  return USAGE_WORDS.estimate(pct, USAGE_WORDS.windowWords[estimate.window]);
}

/** A time for the window lines: `14:05`, or `Mon 14:05` when it is not today. */
export function clockText(iso: string, now: Date): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
}

/** One account's window line: `Acme Max: 14:00 – 17:42 · 62% used`. */
export function spanText(span: UsageSpan, now: Date, fallbackName: string): string {
  return USAGE_WORDS.windowLine(span.name || fallbackName, clockText(span.start, now), clockText(span.end, now), span.pct === null ? '' : USAGE_WORDS.pctUsed(span.pct));
}

/** The token split's line: `12k input · 40k output · 3k cache writes`. */
export function splitText(total: { readonly input: number; readonly output: number; readonly cacheWrite: number; readonly unsplit: number }): string {
  const parts = [`${tokensShort(total.input + total.unsplit)} ${USAGE_WORDS.input}`, `${tokensShort(total.output)} ${USAGE_WORDS.output}`, `${tokensShort(total.cacheWrite)} ${USAGE_WORDS.cacheWrite}`];
  return parts.join(' · ');
}

/** One stacked segment (in % of the plot's height). */
export interface StackSegment {
  readonly series: number;
  readonly y: number;
  readonly h: number;
  readonly value: number;
}

/** One column of the stacked chart. */
export interface StackColumn {
  readonly key: string;
  readonly label: string;
  readonly total: number;
  readonly segments: readonly StackSegment[];
}

/** A bucket's label: `14:30` for buckets under a day, the weekday for whole days. */
export function bucketLabel(iso: string, bucketMs: number): string {
  const at = new Date(iso);
  if (bucketMs >= 86_400_000) return at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
  if (bucketMs >= 43_200_000) return `${at.toLocaleDateString('en-GB', { weekday: 'short' })} ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  return at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/**
 * The stacked columns: per bucket, the series' tokens bottom-up (the biggest series first,
 * "everything else" on top), heights relative to the tallest column.
 */
export function stackColumns(chart: UsageChart): { readonly columns: readonly StackColumn[]; readonly max: number } {
  const totals = chart.buckets.map((_, i) => chart.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const max = Math.max(0, ...totals);
  const columns = chart.buckets.map((start, i): StackColumn => {
    let y = 100;
    const segments: StackSegment[] = [];
    chart.series.forEach((s, index) => {
      const value = s.values[i] ?? 0;
      if (value <= 0 || max === 0) return;
      const h = (value / max) * 100;
      y -= h;
      segments.push({ series: index, y, h, value });
    });
    return { key: start, label: bucketLabel(start, chart.bucketMs), total: totals[i] ?? 0, segments };
  });
  return { columns, max };
}

/** The chart's text alternative: each series with its tokens. */
export function chartLabel(chart: UsageChart): string {
  return `${USAGE_WORDS.chartTitle}: ${chart.series.map((s) => `${s.label} ${tokensShort(s.values.reduce((a, b) => a + b, 0))}`).join(', ')}`;
}

/** Log pages: `{ page (1-based), pages }`. */
export function logPages(log: UsageAnswer['log']): { readonly page: number; readonly pages: number } {
  return { page: log.page + 1, pages: Math.max(1, Math.ceil(log.total / log.pageSize)) };
}

/** A log row's time: `14:05` today, else `Mon 14:05`. */
export function logTime(iso: string, now: Date): string {
  return clockText(iso, now);
}
