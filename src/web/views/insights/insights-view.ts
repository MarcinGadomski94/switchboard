import {
  INSIGHTS_PERIODS,
  type InsightsPeriodKey,
  type InsightsQuery,
  type RoutingSuggestion,
  type TrendPoint,
  type WindowForecast,
  addDays,
  insightsQueryString,
  utcDay,
} from '../../../core/insights.ts';
import { formatTokens } from '../../../core/todo-actuals.ts';

/**
 * D108 · the Insights page's pure parts (`docs/insights.md` → *The page*): the filters in
 * the address, the number formats, the trend chart's geometry, the forecast's sentence and
 * the suggestion's link into Settings → Sessions → Model by task. The React side is
 * `InsightsView.tsx`.
 */

/** The period picker's options. */
export const PERIOD_LABELS: Readonly<Record<InsightsPeriodKey, string>> = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', custom: 'Custom…' };

/** What the page's address holds: the API query's fields, as typed, and the machine (`null` = this one). */
export interface PageFilters {
  readonly period: InsightsPeriodKey;
  readonly from: string;
  readonly to: string;
  readonly folder: string | null;
  readonly cli: string | null;
  readonly model: string | null;
  readonly account: string | null;
  readonly machine: string | null;
}

/** The filters from the address's query (`?period=…`); anything unusable is the default (30 days, everything). */
export function filtersFromSearch(search: string, now: Date): PageFilters {
  const params = new URLSearchParams(search);
  const raw = params.get('period');
  const period: InsightsPeriodKey = (INSIGHTS_PERIODS as readonly string[]).includes(raw ?? '') ? (raw as InsightsPeriodKey) : '30d';
  const today = utcDay(now);
  const day = (value: string | null, fallback: string): string => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback);
  const none = (value: string | null): string | null => (value === null || value === '' ? null : value === 'none' ? '' : value);
  return {
    period,
    from: day(params.get('from'), addDays(today, -29)),
    to: day(params.get('to'), today),
    folder: none(params.get('folder')),
    cli: params.get('cli') || null,
    model: none(params.get('model')),
    account: params.get('account') || null,
    machine: params.get('machine') || null,
  };
}

/** The page's address for `filters`. */
export function insightsPath(filters: PageFilters): string {
  const query = insightsQueryString(filters);
  const machine = filters.machine ? `&machine=${encodeURIComponent(filters.machine)}` : '';
  return `/insights?${query}${machine}`;
}

/** The API query string for `filters` (without the machine: that is the path). */
export function apiQuery(filters: PageFilters): string {
  return insightsQueryString(filters as Pick<InsightsQuery, 'period' | 'from' | 'to' | 'folder' | 'cli' | 'model' | 'account'>);
}

/** Tokens as the page shows them (`850`, `41k`, `1.2M`). */
export function tokensText(n: number): string {
  return formatTokens(n);
}

/** A duration: `<1m`, `42m`, `3h 05m`, `2d 4h`. */
export function durationText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** A share as a percentage: `25%`, `—` when unknown. */
export function percentText(value: number | null): string {
  if (value === null) return '—';
  const pct = value * 100;
  return `${pct < 10 && pct !== Math.round(pct) ? pct.toFixed(1) : Math.round(pct)}%`;
}

/** A ratio: `0.8×`, `—`. */
export function ratioText(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(value < 10 ? 2 : 1).replace(/0$/, '')}×`;
}

/** Money with enough decimals for small amounts: `$0.0096`, `$0.34`, `$12.40`. */
export function costText(amount: number | null, currency: string): string {
  if (amount === null) return '—';
  const digits = amount !== 0 && Math.abs(amount) < 0.1 ? 4 : 2;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
  } catch {
    return `${amount.toFixed(digits)} ${currency}`;
  }
}

/** A day as the axis shows it: `14 Oct`. */
export function dayText(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** A time in this browser's zone: `Thu 14:00`. */
export function whenText(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const sameDay = at.toDateString() === now.toDateString();
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `today ${time}` : `${at.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
}

/** The window's name. */
export const WINDOW_LABELS = { five_hour: '5-hour window', seven_day: 'Weekly window' } as const;

/** The forecast's sentence for one window. */
export function forecastText(forecast: WindowForecast, now: Date = new Date()): string {
  const window = forecast.window === 'five_hour' ? 'the 5-hour window' : 'the weekly window';
  switch (forecast.verdict) {
    case 'full':
      return `Full now${forecast.resetsAt ? `, until it resets ${whenText(forecast.resetsAt, now)}` : ''}.`;
    case 'fills':
      return `At this pace ${window} is full ${whenText(forecast.fullAt ?? '', now)}${forecast.resetsAt ? ` (it resets ${whenText(forecast.resetsAt, now)})` : ''}.`;
    case 'holds':
      return `At this pace ${window} reaches ~${Math.round(forecast.atReset ?? 0)}% by its reset ${whenText(forecast.resetsAt ?? '', now)}.`;
    case 'flat':
      return `Not rising: ${window} stays at ${Math.round(forecast.pct ?? 0)}%${forecast.resetsAt ? ` until it resets ${whenText(forecast.resetsAt, now)}` : ''}.`;
    default:
      return forecast.pct === null ? 'No current reading.' : `${Math.round(forecast.pct)}% now; too few readings for a pace.`;
  }
}

/** The pace text: `+4.2%/h`. */
export function paceText(forecast: WindowForecast): string {
  if (forecast.pctPerHour === null) return '';
  const value = forecast.pctPerHour;
  return `${value >= 0 ? '+' : ''}${Math.abs(value) < 10 ? value.toFixed(1) : Math.round(value)}%/h`;
}

/** The query that opens Settings → Sessions → Model by task with a suggested rule pre-filled (never saved by itself). */
export function suggestionPath(suggestion: Pick<RoutingSuggestion, 'rule'>): string {
  return `/settings/sessions?suggestRule=${encodeURIComponent(JSON.stringify(suggestion.rule))}`;
}

/** The trend chart's geometry: the plot's points (days with turns) and the y axis' ticks. */
export interface TrendGeometry {
  readonly points: ReadonlyArray<{ readonly x: number; readonly y: number; readonly point: TrendPoint }>;
  /** Every day's x (the hover snaps to them). */
  readonly days: ReadonlyArray<{ readonly x: number; readonly point: TrendPoint }>;
  readonly ticks: ReadonlyArray<{ readonly y: number; readonly label: string }>;
  /** Line segments (a day without turns breaks the line). */
  readonly segments: readonly string[];
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const steps = [1, 2, 2.5, 5, 10];
  const step = steps.find((s) => value <= s * magnitude) ?? 10;
  return step * magnitude;
}

/** Lays the trend out in a `width × height` plot (y from 0 to a round maximum of tokens per turn). */
export function trendGeometry(trend: readonly TrendPoint[], width: number, height: number): TrendGeometry {
  const max = niceMax(Math.max(0, ...trend.map((p) => p.tokensPerTurn ?? 0)));
  const step = trend.length > 1 ? width / (trend.length - 1) : 0;
  const xOf = (i: number): number => (trend.length > 1 ? i * step : width / 2);
  const yOf = (v: number): number => height - (v / max) * height;
  const days = trend.map((point, i) => ({ x: xOf(i), point }));
  const points = days.filter((d) => d.point.tokensPerTurn !== null).map((d) => ({ x: d.x, y: yOf(d.point.tokensPerTurn as number), point: d.point }));
  const segments: string[] = [];
  let current: string[] = [];
  trend.forEach((p, i) => {
    if (p.tokensPerTurn === null) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
      return;
    }
    current.push(`${current.length === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(p.tokensPerTurn).toFixed(1)}`);
  });
  if (current.length > 1) segments.push(current.join(' '));
  const ticks = [0, 0.5, 1].map((f) => ({ y: yOf(max * f), label: tokensText(max * f) }));
  return { points, days, ticks, segments };
}
