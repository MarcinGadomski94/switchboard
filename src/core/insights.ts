/**
 * D108 · Insights (`docs/insights.md`): how the agents spent time and tokens, how
 * good the estimates were, how often work came back, what the todo runs would cost at
 * list prices, when each account's usage windows fill, and routing rules worth trying.
 *
 * Pure: no I/O. The server reads the rows (the daily turn rollup, `todo_actuals`, the
 * Plans outcomes, the usage readings) and {@link buildInsights} turns them into the
 * page's one answer (`GET /api/insights`). Every metric's exact definition is in
 * `docs/insights.md`; nothing here invents a value that was not recorded (unknown stays
 * `null`).
 */
import type { CliProviderId } from './cli-providers.ts';
import type { EstimateMatch, ModelRule } from './model-routing.ts';
import type { TodoPriority } from './api.ts';

// ── Query ─────────────────────────────────────────────────────────────────────

/** The period presets; `custom` takes `from` / `to`. */
export const INSIGHTS_PERIODS = ['7d', '30d', '90d', 'custom'] as const;
export type InsightsPeriodKey = (typeof INSIGHTS_PERIODS)[number];

/** Days of each preset (today, UTC, included). */
export const PERIOD_DAYS: Readonly<Record<Exclude<InsightsPeriodKey, 'custom'>, number>> = { '7d': 7, '30d': 30, '90d': 90 };

/** The longest custom period (days). */
export const INSIGHTS_MAX_DAYS = 366;

/** What the page asks for: a period of whole UTC days and the dimension filters (`null` = all). */
export interface InsightsQuery {
  readonly period: InsightsPeriodKey;
  /** First day, `YYYY-MM-DD` (UTC). */
  readonly from: string;
  /** Last day, `YYYY-MM-DD` (UTC), included. */
  readonly to: string;
  /** A folder (`sessions.root`), `''` for sessions without one. */
  readonly folder: string | null;
  readonly cli: string | null;
  /** A model label as {@link modelKey} gives it (`''` = the CLI's default, model unknown). */
  readonly model: string | null;
  /** An account profile id. */
  readonly account: string | null;
}

/** `YYYY-MM-DD` of a time (UTC). */
export function utcDay(at: Date | number | string): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** `day` plus `n` days (UTC). */
export function addDays(day: string, n: number): string {
  return utcDay(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDay(value: unknown): value is string {
  return typeof value === 'string' && DAY_RE.test(value) && utcDay(Date.parse(`${value}T00:00:00.000Z`)) === value;
}

/** Days from `from` to `to`, both included. */
export function dayCount(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000) + 1;
}

/** A filter value: absent / empty / `all` = no filter; else at most 500 characters. */
function filterValue(raw: unknown, field: string, errors: Array<{ field: string; message: string }>, allowEmpty = false): string | null {
  if (raw === undefined || raw === null || raw === 'all') return null;
  if (typeof raw !== 'string' || raw.length > 500) {
    errors.push({ field, message: `${field} must be text of at most 500 characters` });
    return null;
  }
  if (raw === '') return allowEmpty ? '' : null;
  return raw;
}

/**
 * `GET /api/insights?period=&from=&to=&folder=&cli=&model=&account=` → the query, or the
 * 422 errors. `period` defaults to `30d`; `custom` needs `from` and `to` (`YYYY-MM-DD`,
 * `from ≤ to`, at most {@link INSIGHTS_MAX_DAYS} days). Folder and model accept `none`
 * for "no folder" / "the CLI's default".
 */
export function parseInsightsQuery(raw: Readonly<Record<string, unknown>>, now: Date): { readonly ok: true; readonly query: InsightsQuery } | { readonly ok: false; readonly errors: Array<{ field: string; message: string }> } {
  const errors: Array<{ field: string; message: string }> = [];
  const periodRaw = raw['period'] ?? '30d';
  const period = (INSIGHTS_PERIODS as readonly unknown[]).includes(periodRaw) ? (periodRaw as InsightsPeriodKey) : null;
  if (!period) errors.push({ field: 'period', message: 'period must be 7d, 30d, 90d or custom' });
  const today = utcDay(now);
  let from = today;
  let to = today;
  if (period === 'custom') {
    if (!isDay(raw['from'])) errors.push({ field: 'from', message: 'from must be a day (YYYY-MM-DD)' });
    if (!isDay(raw['to'])) errors.push({ field: 'to', message: 'to must be a day (YYYY-MM-DD)' });
    if (isDay(raw['from']) && isDay(raw['to'])) {
      from = raw['from'];
      to = raw['to'];
      if (from > to) errors.push({ field: 'from', message: 'from must not be after to' });
      else if (dayCount(from, to) > INSIGHTS_MAX_DAYS) errors.push({ field: 'to', message: `a period is at most ${INSIGHTS_MAX_DAYS} days` });
    }
  } else if (period) {
    from = addDays(today, -(PERIOD_DAYS[period] - 1));
  }
  const none = (value: string | null): string | null => (value === 'none' ? '' : value);
  const folder = none(filterValue(raw['folder'], 'folder', errors));
  const cli = filterValue(raw['cli'], 'cli', errors);
  const model = none(filterValue(raw['model'], 'model', errors));
  const account = filterValue(raw['account'], 'account', errors);
  if (errors.length > 0 || !period) return { ok: false, errors };
  return { ok: true, query: { period, from, to, folder, cli, model, account } };
}

/** The query as a URL query string (the page and the cache key). */
export function insightsQueryString(query: Pick<InsightsQuery, 'period' | 'from' | 'to' | 'folder' | 'cli' | 'model' | 'account'>): string {
  const params = new URLSearchParams();
  params.set('period', query.period);
  if (query.period === 'custom') {
    params.set('from', query.from);
    params.set('to', query.to);
  }
  if (query.folder !== null) params.set('folder', query.folder === '' ? 'none' : query.folder);
  if (query.cli !== null) params.set('cli', query.cli);
  if (query.model !== null) params.set('model', query.model === '' ? 'none' : query.model);
  if (query.account !== null) params.set('account', query.account);
  return params.toString();
}

// ── Tokens and models of a turn ────────────────────────────────────────────────

/** A turn's tokens by kind (the `result` line's `usage`). */
export interface TokenSplit {
  readonly input: number;
  readonly output: number;
  /** `cache_creation_input_tokens`. */
  readonly cacheWrite: number;
  /** `cache_read_input_tokens` (left out of D78's "tokens", priced separately). */
  readonly cacheRead: number;
}

/** Token usage where some turns have no split (recorded before 1.20: only D78's total). */
export interface TokenUsage extends TokenSplit {
  /** Tokens known only as D78's total (`input + cache write + output`, split unknown). */
  readonly unsplit: number;
}

export const EMPTY_USAGE: TokenUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, unsplit: 0 };

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The split of a raw `result` line's `usage`; `null` without one (or all zeros). */
export function resultTokenSplit(raw: unknown): TokenSplit | null {
  if (!isRecord(raw) || !isRecord(raw['usage'])) return null;
  const u = raw['usage'];
  const split = { input: count(u['input_tokens']), output: count(u['output_tokens']), cacheWrite: count(u['cache_creation_input_tokens']), cacheRead: count(u['cache_read_input_tokens']) };
  return split.input + split.output + split.cacheWrite + split.cacheRead > 0 ? split : null;
}

/**
 * The model a raw `result` line reports: of its `modelUsage` entries the one with the most
 * output tokens (Claude Code also runs small background calls on another model), named by
 * its `canonicalModel` when given, else its key without a date suffix
 * (`claude-haiku-4-5-20251001` → `claude-haiku-4-5`); `null` without `modelUsage`.
 */
export function resultModel(raw: unknown): string | null {
  if (!isRecord(raw) || !isRecord(raw['modelUsage'])) return null;
  let best: { name: string; output: number } | null = null;
  for (const [key, entry] of Object.entries(raw['modelUsage'])) {
    if (!isRecord(entry)) continue;
    const name = typeof entry['canonicalModel'] === 'string' && entry['canonicalModel'] !== '' ? entry['canonicalModel'] : key.replace(/-\d{8}$/, '');
    const output = count(entry['outputTokens']);
    if (best === null || output > best.output) best = { name, output };
  }
  return best?.name ?? null;
}

/** The split from a stored result payload's `usage` (D108); `null` when it has none. */
export function payloadTokenSplit(value: unknown): TokenSplit | null {
  if (!isRecord(value)) return null;
  const split = { input: count(value['input']), output: count(value['output']), cacheWrite: count(value['cacheWrite']), cacheRead: count(value['cacheRead']) };
  return split.input + split.output + split.cacheWrite + split.cacheRead > 0 ? split : null;
}

/** Adds usages. */
export function addUsage(a: TokenUsage, b: Partial<TokenUsage>): TokenUsage {
  return { input: a.input + (b.input ?? 0), output: a.output + (b.output ?? 0), cacheWrite: a.cacheWrite + (b.cacheWrite ?? 0), cacheRead: a.cacheRead + (b.cacheRead ?? 0), unsplit: a.unsplit + (b.unsplit ?? 0) };
}

/** Reads a stored usage (JSON) defensively; `null` when it is not one. */
export function readTokenUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null;
  return { input: count(value['input']), output: count(value['output']), cacheWrite: count(value['cacheWrite']), cacheRead: count(value['cacheRead']), unsplit: count(value['unsplit']) };
}

/**
 * The model label every section groups by: the model the CLI reported for the turn
 * (D108, from 1.20), else the session's chosen model (`sessions.model`), else `''` (the CLI's
 * default; which model that was is not recorded).
 */
export function modelKey(reported: string | null | undefined, chosen: string | null | undefined): string {
  if (typeof reported === 'string' && reported !== '') return reported;
  if (typeof chosen === 'string' && chosen !== '' && chosen !== 'default') return chosen;
  return '';
}

/** How a model key reads on the page (`''` → "default model"). */
export function modelLabel(key: string): string {
  return key === '' ? 'default model' : key;
}

// ── Prices (Settings → Notifications & usage → Prices, `insights.prices`) ──────

/** One price row: a model (matched by text) and its prices per 1M tokens. */
export interface ModelPrice {
  /** Matches a model whose name contains this text (case-insensitive), e.g. `opus`. The first matching row wins. */
  readonly match: string;
  /** Per 1M input tokens. */
  readonly input: number;
  /** Per 1M output tokens. */
  readonly output: number;
  /** Per 1M cache-write tokens. */
  readonly cacheWrite: number;
  /** Per 1M cache-read tokens. */
  readonly cacheRead: number;
}

/** The price table (`insights.prices`). */
export interface PriceTable {
  /** ISO 4217 code or a short label (`USD`, `EUR`). */
  readonly currency: string;
  /** `true` while the table is Switchboard's example (never saved by the developer): the page says so. */
  readonly example: boolean;
  readonly models: readonly ModelPrice[];
}

/**
 * Example prices (USD per 1M tokens, the Anthropic API's list prices as of October 2026;
 * cache writes at 1.25× input, the 5-minute rate). **Examples only**: prices change and a
 * subscription is not billed per token; the page says "example prices — edit in Settings".
 */
export const EXAMPLE_PRICES: PriceTable = {
  currency: 'USD',
  example: true,
  models: [
    { match: 'fable', input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
    { match: 'opus', input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
    { match: 'sonnet', input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
    { match: 'haiku', input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  ],
};

/** Price rows at most. */
export const PRICE_ROWS_MAX = 40;
/** A price at most (per 1M tokens). */
export const PRICE_MAX = 100_000;

/** A validation problem of a price table (`field` like `models[2].output`). */
export interface PriceProblem {
  readonly field: string;
  readonly message: string;
}

function isPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= PRICE_MAX;
}

/** Validates a `PUT /api/settings` value of `insights.prices`. */
export function parsePriceTable(value: unknown): { readonly ok: true; readonly table: PriceTable } | { readonly ok: false; readonly errors: PriceProblem[] } {
  const errors: PriceProblem[] = [];
  if (!isRecord(value)) return { ok: false, errors: [{ field: 'insights.prices', message: 'insights.prices must be an object { currency, example, models }' }] };
  const currency = typeof value['currency'] === 'string' ? value['currency'].trim() : '';
  if (currency === '' || currency.length > 8) errors.push({ field: 'insights.prices.currency', message: 'currency must be 1–8 characters (e.g. USD, EUR)' });
  if (value['example'] !== undefined && typeof value['example'] !== 'boolean') errors.push({ field: 'insights.prices.example', message: 'example must be true or false' });
  const rows = value['models'];
  const models: ModelPrice[] = [];
  if (!Array.isArray(rows) || rows.length > PRICE_ROWS_MAX) {
    errors.push({ field: 'insights.prices.models', message: `models must be a list of at most ${PRICE_ROWS_MAX} rows` });
  } else {
    rows.forEach((row, index) => {
      const at = `insights.prices.models[${index}]`;
      if (!isRecord(row)) {
        errors.push({ field: at, message: 'a row must be an object' });
        return;
      }
      const match = typeof row['match'] === 'string' ? row['match'].trim() : '';
      if (match === '' || match.length > 100) errors.push({ field: `${at}.match`, message: 'match must be 1–100 characters of a model name' });
      for (const key of ['input', 'output', 'cacheWrite', 'cacheRead'] as const) {
        if (!isPrice(row[key])) errors.push({ field: `${at}.${key}`, message: `${key} must be a price from 0 to ${PRICE_MAX} per 1M tokens` });
      }
      if (errors.length === 0) models.push({ match, input: row['input'] as number, output: row['output'] as number, cacheWrite: row['cacheWrite'] as number, cacheRead: row['cacheRead'] as number });
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, table: { currency, example: value['example'] === true, models } };
}

/** The stored table read defensively: anything unusable reads as {@link EXAMPLE_PRICES}. */
export function readPriceTable(value: unknown): PriceTable {
  const parsed = parsePriceTable(value);
  return parsed.ok ? parsed.table : EXAMPLE_PRICES;
}

/** The price row of a model (the first whose `match` its name contains); `null` = not priced. */
export function priceFor(table: PriceTable, model: string): ModelPrice | null {
  const name = model.toLowerCase();
  if (name === '') return null;
  return table.models.find((row) => name.includes(row.match.toLowerCase())) ?? null;
}

/**
 * The cost of `usage` at `price`: each kind × its price per 1M tokens. Tokens without a
 * split (`unsplit`) are priced at the input rate, so such a cost is a **lower bound**.
 */
export function usageCost(usage: TokenUsage, price: ModelPrice): number {
  return (usage.input * price.input + usage.unsplit * price.input + usage.output * price.output + usage.cacheWrite * price.cacheWrite + usage.cacheRead * price.cacheRead) / 1_000_000;
}

// ── Rows the server reads ──────────────────────────────────────────────────────

/** Where a session (or a todo, a plan item) belongs: the page's filter dimensions. */
export interface InsightDims {
  /** `sessions.root`; `''` without one. */
  readonly folder: string;
  readonly provider: string;
  /** {@link modelKey}. */
  readonly model: string;
  /** The account profile id; `''` when unknown. */
  readonly profileId: string;
}

/** One row of the daily rollup (`insight_turns_daily`, migration 0045). */
export interface TurnRollupRow extends InsightDims {
  /** `YYYY-MM-DD` (UTC) the turns ended. */
  readonly day: string;
  readonly sessionId: string;
  readonly kind: 'session' | 'chat';
  /** Turns that ended (one `result` each). */
  readonly turns: number;
  /** Of them, the error results. */
  readonly errorTurns: number;
  /** D78's tokens: input + cache write + output (cache reads left out). */
  readonly tokens: number;
  readonly usage: TokenUsage;
  /** The CLI's reported turn duration (`duration_ms`), summed. */
  readonly durationMs: number;
  /** D80 reverts ("Revert to before this turn" / Undo last turn) on that day. */
  readonly reverts: number;
  /** D80 Redos (a revert undone). */
  readonly redos: number;
}

/** One completed todo (`todo_actuals` with 0045's columns). */
export interface TodoActualRow extends InsightDims {
  readonly todoId: string;
  readonly sessionId: string;
  /** D76: its run session, `null` when it ran in its own session (or unknown, before 0045). */
  readonly runSessionId: string | null;
  readonly title: string;
  readonly priority: TodoPriority | null;
  readonly estimateMinutes: number | null;
  /** D78's actual time: D147, its open time (in progress → done). */
  readonly actualMs: number;
  /**
   * D147 (`todo_actuals.working_ms`, `measure = working`): its working time, what the estimate
   * accuracy uses; `null` / absent = open time only (finished before D147, or an older peer's row).
   */
  readonly workingMs?: number | null;
  readonly actualTokens: number | null;
  /** Its tokens by kind (`unsplit` = D78's total without a split: items completed before 1.20). */
  readonly usage: TokenUsage;
  readonly completedAt: string;
  /** How often it went from done back to open / in progress (recorded from 1.20; 0 before). */
  readonly reopens: number;
}

/** A Plans (D99) item's outcome (plans.db, only while Plans is on). */
export interface PlanOutcomeRow extends InsightDims {
  readonly itemId: string;
  /** `merged` (done: its work is in the target), `failed`, `blocked` (pending with a reason: a dependency failed). */
  readonly outcome: 'merged' | 'failed' | 'blocked';
  /** When it ended (merged / done / failed / last change). */
  readonly at: string;
}

/** A D102 Merge-step decision: the Inbox's "Ready to merge" item closed by Merge, Send back or a failure. */
export interface MergeDecisionRow extends InsightDims {
  readonly itemId: string;
  readonly decision: 'merged' | 'sent-back' | 'failed';
  readonly at: string;
}

/** A usage reading (D17 / D63) as the forecast reads it. */
export interface InsightReading {
  readonly profileId: string;
  readonly receivedAt: string;
  readonly fiveHourPct: number | null;
  readonly fiveHourResetsAt: string | null;
  readonly sevenDayPct: number | null;
  readonly sevenDayResetsAt: string | null;
}

/** An account the forecast covers. */
export interface InsightAccount {
  readonly id: string;
  readonly cli: CliProviderId;
  readonly name: string;
  /** D103: the credit line ("€12.40 left of €50"), `null` without credit data. */
  readonly credits: string | null;
  /** D103: the account runs on credits now. */
  readonly onCredits: boolean;
  /** D98: the account's identity (`claude:<email>`), when known: the same identity on two machines is one account. */
  readonly identity?: string | null;
}

/** Everything {@link buildInsights} needs. */
export interface InsightsInput {
  readonly query: InsightsQuery;
  readonly now: Date;
  /** Rollup rows of the period (any dimension; filtering happens here). */
  readonly turns: readonly TurnRollupRow[];
  /** Completed todos of the period. */
  readonly todos: readonly TodoActualRow[];
  /** `null` while Plans is off (or plans.db is unavailable). */
  readonly plans: readonly PlanOutcomeRow[] | null;
  readonly mergeDecisions: readonly MergeDecisionRow[];
  /** Readings of the forecast's lookback (the last 24 h is enough). */
  readonly readings: readonly InsightReading[];
  readonly accounts: readonly InsightAccount[];
  /** Session titles (for the per-session table). */
  readonly sessionTitles: ReadonlyMap<string, string>;
  readonly prices: PriceTable;
  /** Account names (for the filter and the tables). */
  readonly accountNames: ReadonlyMap<string, string>;
  readonly backfill: InsightsBackfillState;
  /** Folder labels where they differ from the folder's last segment (merged machines: `acme · Studio` on a collision). */
  readonly folderLabels?: ReadonlyMap<string, string>;
  /** Which machines the rows come from (merged view); absent = this machine only. */
  readonly machines?: InsightsMachines;
}

/** D108 ruling (merged machines): which machines an answer covers. */
export interface InsightsMachines {
  /** `all` (merged) or `local`. */
  readonly scope: 'all' | 'local';
  /** Machines whose rows are in the answer (this one first, `id: null`). */
  readonly included: ReadonlyArray<{ readonly id: string | null; readonly name: string }>;
  /** Paired machines whose rows are being fetched: ask again with `peers=wait` to fill them in. */
  readonly pending: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** Paired machines left out, and why (offline, did not answer in time, an older Switchboard, …). */
  readonly missing: ReadonlyArray<{ readonly id: string; readonly name: string; readonly reason: string }>;
}

/**
 * D108 ruling (merged machines): what one machine contributes to a merged view: its rows of
 * the period (`GET /api/insights/rows`, the peer API), never computed numbers, so medians,
 * buckets and the forecast are exact over both machines.
 */
export interface InsightsRows {
  readonly turns: readonly TurnRollupRow[];
  readonly todos: readonly TodoActualRow[];
  readonly plans: readonly PlanOutcomeRow[] | null;
  readonly mergeDecisions: readonly MergeDecisionRow[];
  readonly readings: readonly InsightReading[];
  readonly accounts: readonly InsightAccount[];
  readonly sessionTitles: Readonly<Record<string, string>>;
  readonly accountNames: Readonly<Record<string, string>>;
}

// ── The answer ─────────────────────────────────────────────────────────────────

/** The rollup's background backfill (events written before 0045). */
export interface InsightsBackfillState {
  readonly done: boolean;
  readonly percent: number;
}

/** A row of a time-and-tokens table. */
export interface TimeTokensRow {
  /** The group's key (folder path, session id, model key). */
  readonly key: string;
  readonly label: string;
  readonly turns: number;
  readonly tokens: number;
  readonly durationMs: number;
  /** `tokens ÷ turns`, `null` with no turns. */
  readonly tokensPerTurn: number | null;
}

/** One day of the trend. */
export interface TrendPoint {
  readonly day: string;
  readonly turns: number;
  readonly tokens: number;
  /** `tokens ÷ turns` of the day, `null` with no turns. */
  readonly tokensPerTurn: number | null;
}

/** The estimate-accuracy buckets of `actual ÷ estimate`. */
export const ACCURACY_BUCKETS = [
  { key: 'under-half', label: '< 0.5×', max: 0.5 },
  { key: 'half-to-one', label: '0.5–1×', max: 1 },
  { key: 'one-to-two', label: '1–2×', max: 2 },
  { key: 'over-two', label: '> 2×', max: Number.POSITIVE_INFINITY },
] as const;
export type AccuracyBucketKey = (typeof ACCURACY_BUCKETS)[number]['key'];

/** A distribution of `actual ÷ estimate`. */
export interface AccuracyDistribution {
  /** Completed estimated todos. */
  readonly count: number;
  /** The median ratio, `null` with none. */
  readonly median: number | null;
  readonly buckets: ReadonlyArray<{ readonly key: AccuracyBucketKey; readonly label: string; readonly count: number }>;
}

/** {@link AccuracyDistribution} of one group. */
export interface AccuracyGroup extends AccuracyDistribution {
  readonly key: string;
  readonly label: string;
}

/** Outcomes and rework of one model. */
export interface OutcomeRow {
  readonly model: string;
  readonly label: string;
  /** Todos completed / of them reopened at least once / the share (`null` with none completed). */
  readonly todos: { readonly done: number; readonly reopened: number; readonly reopenRate: number | null };
  /** Plans items (D99) that ended merged / failed / blocked, and the D102 Merge-step decisions; `null` while Plans is off. */
  readonly plans: {
    readonly merged: number;
    readonly failed: number;
    readonly blocked: number;
    /** `merged ÷ (merged + failed + blocked)`. */
    readonly mergeRate: number | null;
    /** Merge-step decisions: Merge clicked, Send back, failed merges. */
    readonly decisions: { readonly merged: number; readonly sentBack: number; readonly failed: number };
    /** `sentBack ÷ (merged + sentBack + failed)` of the decisions. */
    readonly sendBackRate: number | null;
  } | null;
  /** D80: turns, reverts and Redos; per 100 turns = `(reverts − redos) ÷ turns × 100` (never below 0). */
  readonly reverts: { readonly turns: number; readonly reverts: number; readonly redos: number; readonly per100Turns: number | null };
}

/** One todo's cost. */
export interface TodoCost {
  readonly todoId: string;
  readonly title: string;
  readonly sessionId: string;
  readonly runSessionId: string | null;
  readonly model: string;
  readonly modelLabel: string;
  readonly tokens: number;
  /** Its open time (D78's actual). */
  readonly actualMs: number;
  /** D147 (additive): its working time; `null` = open time only. */
  readonly workingMs?: number | null;
  /** `null` when its model has no price row. */
  readonly cost: number | null;
  /** Part of its tokens has no split: the cost is a lower bound. */
  readonly lowerBound: boolean;
  readonly completedAt: string;
}

/** The cost section. */
export interface CostSection {
  readonly currency: string;
  /** The prices are Switchboard's examples (never edited). */
  readonly example: boolean;
  /** Completed todos / of them priced. */
  readonly todos: number;
  readonly priced: number;
  /** Sum of the priced todos' costs. */
  readonly total: number;
  /** `total ÷ priced`, `null` with none. */
  readonly average: number | null;
  readonly median: number | null;
  /** Some priced todo's cost is a lower bound. */
  readonly lowerBound: boolean;
  readonly byModel: ReadonlyArray<{ readonly model: string; readonly label: string; readonly todos: number; readonly priced: number; readonly total: number; readonly median: number | null }>;
  /** The most expensive runs, at most {@link TOP_COSTS}. */
  readonly top: readonly TodoCost[];
  /** D108 ruling: every turn of the period priced (sessions; chats apart), from the rollup's token split. */
  readonly period: PeriodCost;
}

/** A group's period cost. */
export interface PeriodCostRow {
  readonly key: string;
  readonly label: string;
  /** `null` when none of its tokens has a price row. */
  readonly cost: number | null;
  /** Part of its tokens has no split (turns before 1.20): the cost is a lower bound. */
  readonly lowerBound: boolean;
  /** Tokens (D78's) of its turns whose model has no price row. */
  readonly unpricedTokens: number;
}

/** D108 ruling: the period's cost of every turn. */
export interface PeriodCost {
  readonly total: number;
  readonly lowerBound: boolean;
  /** Tokens (D78's) of turns whose model has no price row (not in the total). */
  readonly unpricedTokens: number;
  readonly byFolder: readonly PeriodCostRow[];
  readonly byModel: readonly PeriodCostRow[];
  /** D106: chats' turns priced apart (never in the total). */
  readonly chats: number;
}

/** One usage window's forecast. */
export interface WindowForecast {
  readonly window: 'five_hour' | 'seven_day';
  /** The newest reading's %, `null` when unknown. */
  readonly pct: number | null;
  readonly resetsAt: string | null;
  /** Least-squares pace over the lookback, % per hour; `null` without enough readings. */
  readonly pctPerHour: number | null;
  /** Readings the pace was computed from. */
  readonly readings: number;
  /**
   * `full` (already at 100 %), `fills` (at this pace it is full at `fullAt`, before the reset),
   * `holds` (it does not fill before the reset: `atReset` %), `flat` (not rising),
   * `unknown` (too few readings, or no current window).
   */
  readonly verdict: 'full' | 'fills' | 'holds' | 'flat' | 'unknown';
  readonly fullAt: string | null;
  /** Projected % at the reset (≤ 100), `null` unless `holds`. */
  readonly atReset: number | null;
}

/** One account's forecast. */
export interface AccountForecast {
  readonly profileId: string;
  readonly name: string;
  readonly cli: CliProviderId;
  readonly windows: readonly WindowForecast[];
  readonly credits: string | null;
  readonly onCredits: boolean;
}

/** A suggested routing rule (never applied by itself). */
export interface RoutingSuggestion {
  readonly id: string;
  /** "Haiku 4.5 finished 5 low-priority todos ≤ 30 min with 0 reopened at 1/5 the cost of Opus 5.5." */
  readonly text: string;
  readonly evidence: {
    readonly cheap: { readonly model: string; readonly todos: number; readonly reopened: number; readonly medianCost: number };
    readonly expensive: { readonly model: string; readonly todos: number; readonly reopened: number; readonly medianCost: number };
    readonly currency: string;
  };
  /** The rule the D82 editor is pre-filled with. */
  readonly rule: Omit<ModelRule, 'id'>;
}

/** `GET /api/insights` (D108). */
export interface InsightsAnswer {
  readonly generatedAt: string;
  readonly query: InsightsQuery;
  /** The options of the filters (from the period's data, before filtering). */
  readonly options: {
    readonly folders: readonly string[];
    readonly clis: readonly string[];
    readonly models: readonly string[];
    readonly accounts: ReadonlyArray<{ readonly id: string; readonly name: string }>;
    /** A folder key's label where it is not the last segment of the path (merged machines). */
    readonly folderLabels: Readonly<Record<string, string>>;
  };
  readonly backfill: InsightsBackfillState;
  /** Which machines the answer covers (D108 ruling: the merged view by default). */
  readonly machines: InsightsMachines;
  readonly time: {
    readonly totals: { readonly turns: number; readonly tokens: number; readonly durationMs: number; readonly tokensPerTurn: number | null; readonly sessions: number };
    readonly byFolder: readonly TimeTokensRow[];
    /** The top {@link TOP_SESSIONS} sessions by tokens. */
    readonly bySession: readonly TimeTokensRow[];
    readonly byModel: readonly TimeTokensRow[];
    readonly trend: readonly TrendPoint[];
    /** D106: chats, counted apart (never in the numbers above). */
    readonly chats: { readonly turns: number; readonly tokens: number; readonly durationMs: number };
  };
  /**
   * D147: the accuracy of the items measured in working time; `openOnly` = estimated items left out
   * because they have open time only (finished before D147); `open` = every estimated item's open
   * time ÷ estimate, apart (for planning).
   */
  readonly estimates: AccuracyDistribution & { readonly byModel: readonly AccuracyGroup[]; readonly byFolder: readonly AccuracyGroup[]; readonly openOnly?: number; readonly open?: AccuracyDistribution };
  readonly outcomes: { readonly plansOn: boolean; readonly byModel: readonly OutcomeRow[] };
  readonly cost: CostSection;
  readonly forecast: readonly AccountForecast[];
  readonly suggestions: readonly RoutingSuggestion[];
}

/** Sessions in the per-session table. */
export const TOP_SESSIONS = 20;
/** The most expensive runs listed. */
export const TOP_COSTS = 10;

// ── Helpers ────────────────────────────────────────────────────────────────────

/** The median (the mean of the two middle values for an even count); `null` for none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** `true` when a row passes the query's dimension filters. */
export function matchesFilters(dims: InsightDims, query: Pick<InsightsQuery, 'folder' | 'cli' | 'model' | 'account'>): boolean {
  if (query.folder !== null && dims.folder !== query.folder) return false;
  if (query.cli !== null && dims.provider !== query.cli) return false;
  if (query.model !== null && dims.model !== query.model) return false;
  if (query.account !== null && dims.profileId !== query.account) return false;
  return true;
}

function folderLabel(folder: string): string {
  if (folder === '') return 'no folder';
  const parts = folder.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? folder;
}

interface Acc {
  turns: number;
  tokens: number;
  durationMs: number;
}

function groupTurns(rows: readonly TurnRollupRow[], keyOf: (row: TurnRollupRow) => string, labelOf: (key: string) => string): TimeTokensRow[] {
  const groups = new Map<string, Acc>();
  for (const row of rows) {
    const key = keyOf(row);
    const acc = groups.get(key) ?? { turns: 0, tokens: 0, durationMs: 0 };
    acc.turns += row.turns;
    acc.tokens += row.tokens;
    acc.durationMs += row.durationMs;
    groups.set(key, acc);
  }
  return [...groups.entries()]
    .map(([key, acc]) => ({ key, label: labelOf(key), turns: acc.turns, tokens: acc.tokens, durationMs: acc.durationMs, tokensPerTurn: acc.turns > 0 ? acc.tokens / acc.turns : null }))
    .sort((a, b) => b.tokens - a.tokens || b.durationMs - a.durationMs || a.key.localeCompare(b.key));
}

/** The bucket of a ratio: `[0, 0.5)`, `[0.5, 1)`, `[1, 2)`, `[2, ∞)`. */
export function accuracyBucket(value: number): AccuracyBucketKey {
  return (ACCURACY_BUCKETS.find((bucket) => value < bucket.max) ?? ACCURACY_BUCKETS[3]).key;
}

/**
 * `actual ÷ estimate` of a completed todo with an estimate; `null` without one. D147: the actual
 * is its working time (`null` for an open-time-only row), or with `measure: 'open'` its open time.
 */
export function accuracyRatio(todo: Pick<TodoActualRow, 'estimateMinutes' | 'actualMs' | 'workingMs'>, measure: 'working' | 'open' = 'working'): number | null {
  if (typeof todo.estimateMinutes !== 'number' || todo.estimateMinutes <= 0) return null;
  const actual = measure === 'open' ? todo.actualMs : todo.workingMs;
  return typeof actual === 'number' ? actual / (todo.estimateMinutes * 60_000) : null;
}

/** The distribution of `actual ÷ estimate` over the todos with an estimate (D147: and the measure). */
export function accuracyDistribution(todos: readonly Pick<TodoActualRow, 'estimateMinutes' | 'actualMs' | 'workingMs'>[], measure: 'working' | 'open' = 'working'): AccuracyDistribution {
  const ratios = todos.map((todo) => accuracyRatio(todo, measure)).filter((value): value is number => value !== null);
  return {
    count: ratios.length,
    median: median(ratios),
    buckets: ACCURACY_BUCKETS.map((bucket) => ({ key: bucket.key, label: bucket.label, count: ratios.filter((value) => accuracyBucket(value) === bucket.key).length })),
  };
}

/**
 * D147: the line under the estimate accuracy that names what is left out and the open time:
 * `Working time only · 12 finished before working time was measured (open time only) left out ·
 * open time (in progress → done): median 3.4× over 20`; `''` when there is nothing to say.
 */
export function openTimeNote(estimates: Pick<InsightsAnswer['estimates'], 'openOnly' | 'open'>): string {
  const parts: string[] = [];
  const openOnly = estimates.openOnly ?? 0;
  if (openOnly > 0) parts.push(`${openOnly} finished before working time was measured (open time only) left out`);
  const open = estimates.open;
  if (open && open.count > 0 && open.median !== null) parts.push(`open time (in progress → done): median ${open.median.toFixed(1)}× over ${open.count}`);
  return parts.length === 0 ? '' : `Working time only · ${parts.join(' · ')}`;
}

function accuracyGroups(todos: readonly TodoActualRow[], keyOf: (todo: TodoActualRow) => string, labelOf: (key: string) => string): AccuracyGroup[] {
  const groups = new Map<string, TodoActualRow[]>();
  for (const todo of todos) {
    if (accuracyRatio(todo) === null) continue;
    const key = keyOf(todo);
    groups.set(key, [...(groups.get(key) ?? []), todo]);
  }
  return [...groups.entries()].map(([key, list]) => ({ key, label: labelOf(key), ...accuracyDistribution(list) })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** A todo's tokens for the cost table: D78's total, else the split's input + cache write + output + unsplit. */
function todoTokens(todo: TodoActualRow): number {
  if (typeof todo.actualTokens === 'number') return todo.actualTokens;
  return todo.usage.input + todo.usage.cacheWrite + todo.usage.output + todo.usage.unsplit;
}

/** A todo's cost at `prices`. */
export function todoCost(todo: TodoActualRow, prices: PriceTable): TodoCost {
  const price = priceFor(prices, todo.model);
  return {
    todoId: todo.todoId,
    title: todo.title,
    sessionId: todo.sessionId,
    runSessionId: todo.runSessionId,
    model: todo.model,
    modelLabel: modelLabel(todo.model),
    tokens: todoTokens(todo),
    actualMs: todo.actualMs,
    workingMs: todo.workingMs ?? null,
    cost: price ? usageCost(todo.usage, price) : null,
    lowerBound: price !== null && todo.usage.unsplit > 0,
    completedAt: todo.completedAt,
  };
}

// ── Forecast ───────────────────────────────────────────────────────────────────

/** How far back each window's pace looks (ms). */
export const FORECAST_LOOKBACK_MS = { five_hour: 60 * 60_000, seven_day: 24 * 60 * 60_000 } as const;
/** The window lengths (ms). */
export const WINDOW_MS = { five_hour: 5 * 60 * 60_000, seven_day: 7 * 24 * 60 * 60_000 } as const;
/** Readings whose reset differs from the newest one's by at most this much belong to the same window. */
export const RESET_TOLERANCE_MS = 15 * 60_000;
/** The pace needs readings spanning at least this long (ms). */
export const MIN_SPAN_MS = { five_hour: 10 * 60_000, seven_day: 60 * 60_000 } as const;

/**
 * One window's forecast from an account's readings: the newest reading with that window
 * names the current window (its reset, still ahead of `now`); the readings of the same window
 * (reset within {@link RESET_TOLERANCE_MS}) received in the lookback
 * ({@link FORECAST_LOOKBACK_MS}) give the pace by least squares (% per hour). With at least
 * two readings spanning {@link MIN_SPAN_MS}: already ≥ 100 % → `full`; pace ≤ 0 → `flat`;
 * `fullAt = newest time + (100 − newest %) ÷ pace` before the reset → `fills`, else `holds`
 * with the projected % at the reset.
 */
export function windowForecast(readings: readonly InsightReading[], window: 'five_hour' | 'seven_day', now: Date): WindowForecast {
  const pick = (r: InsightReading): { pct: number | null; resetsAt: string | null } => (window === 'five_hour' ? { pct: r.fiveHourPct, resetsAt: r.fiveHourResetsAt } : { pct: r.sevenDayPct, resetsAt: r.sevenDayResetsAt });
  const at = now.getTime();
  const usable = readings
    .map((r) => ({ t: Date.parse(r.receivedAt), ...pick(r) }))
    .filter((r): r is { t: number; pct: number; resetsAt: string } => Number.isFinite(r.t) && r.t <= at && typeof r.pct === 'number' && Number.isFinite(r.pct) && typeof r.resetsAt === 'string' && Number.isFinite(Date.parse(r.resetsAt)))
    .sort((a, b) => a.t - b.t);
  const newest = usable.at(-1);
  const unknown = (pct: number | null, resetsAt: string | null): WindowForecast => ({ window, pct, resetsAt, pctPerHour: null, readings: 0, verdict: 'unknown', fullAt: null, atReset: null });
  if (!newest) return unknown(null, null);
  const reset = Date.parse(newest.resetsAt);
  if (reset <= at) return unknown(null, null);
  if (newest.pct >= 100) return { window, pct: newest.pct, resetsAt: newest.resetsAt, pctPerHour: null, readings: 1, verdict: 'full', fullAt: null, atReset: null };
  const from = Math.max(at - FORECAST_LOOKBACK_MS[window], reset - WINDOW_MS[window]);
  const points = usable.filter((r) => r.t >= from && Math.abs(Date.parse(r.resetsAt) - reset) <= RESET_TOLERANCE_MS);
  const first = points[0];
  if (points.length < 2 || !first || newest.t - first.t < MIN_SPAN_MS[window]) return { ...unknown(newest.pct, newest.resetsAt), readings: points.length };
  // Least squares over (hours since the first point, %).
  const xs = points.map((p) => (p.t - first.t) / 3_600_000);
  const ys = points.map((p) => p.pct);
  const n = points.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += ((xs[i] as number) - mx) * ((ys[i] as number) - my);
    sxx += ((xs[i] as number) - mx) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const base = { window, pct: newest.pct, resetsAt: newest.resetsAt, pctPerHour: slope, readings: n } as const;
  if (slope <= 0) return { ...base, verdict: 'flat', fullAt: null, atReset: newest.pct };
  const fullAt = newest.t + ((100 - newest.pct) / slope) * 3_600_000;
  if (fullAt < reset) return { ...base, verdict: 'fills', fullAt: new Date(fullAt).toISOString(), atReset: null };
  return { ...base, verdict: 'holds', fullAt: null, atReset: Math.min(100, newest.pct + (slope * (reset - newest.t)) / 3_600_000) };
}

// ── Suggestions ────────────────────────────────────────────────────────────────

/** A model needs this many completed todos in a group to be compared. */
export const SUGGESTION_MIN_TODOS = 3;
/** The cheaper model's median cost must be at most this share of the other's. */
export const SUGGESTION_MAX_COST_SHARE = 0.5;
/** The estimate split of the suggestions' groups (minutes). */
export const SUGGESTION_ESTIMATE_SPLIT = 30;

function estimateClass(minutes: number | null): EstimateMatch {
  if (typeof minutes !== 'number' || minutes <= 0) return { kind: 'unknown' };
  return minutes <= SUGGESTION_ESTIMATE_SPLIT ? { kind: 'at-most', minutes: SUGGESTION_ESTIMATE_SPLIT } : { kind: 'more-than', minutes: SUGGESTION_ESTIMATE_SPLIT };
}

function estimateText(match: EstimateMatch): string {
  if (match.kind === 'at-most') return `estimated ≤ ${match.minutes} min`;
  if (match.kind === 'more-than') return `estimated > ${match.minutes} min`;
  return 'without an estimate';
}

function costShareText(share: number): string {
  if (share <= 0) return 'at no recorded cost';
  const times = 1 / share;
  return times >= 1.95 ? `at 1/${Math.round(times)} the cost` : `at ${Math.round(share * 100)}% of the cost`;
}

/**
 * Routing rules worth trying: the completed todos (all filters but the model applied) are
 * grouped by priority × estimate class (≤ 30 min, > 30 min, none) × model. A model **A** is
 * suggested over a model **B** of the same group when each has at least
 * {@link SUGGESTION_MIN_TODOS} todos, every one of them priced, A's reopen rate is not higher
 * than B's and A's median cost is at most {@link SUGGESTION_MAX_COST_SHARE} of B's. Per group
 * the cheapest such A against the most expensive B. Suggestions only: never applied.
 */
export function routingSuggestions(todos: readonly TodoActualRow[], prices: PriceTable): RoutingSuggestion[] {
  const groups = new Map<string, { priority: TodoPriority; estimate: EstimateMatch; models: Map<string, TodoActualRow[]> }>();
  for (const todo of todos) {
    if (todo.priority === null || todo.model === '') continue;
    const estimate = estimateClass(todo.estimateMinutes);
    const key = `${todo.priority}|${estimate.kind}`;
    const group = groups.get(key) ?? { priority: todo.priority, estimate, models: new Map<string, TodoActualRow[]>() };
    group.models.set(todo.model, [...(group.models.get(todo.model) ?? []), todo]);
    groups.set(key, group);
  }
  const out: RoutingSuggestion[] = [];
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const stats = [...group.models.entries()]
      .map(([model, list]) => {
        const costs = list.map((todo) => todoCost(todo, prices).cost);
        const priced = costs.every((cost) => cost !== null);
        return { model, list, priced, medianCost: priced ? (median(costs as number[]) ?? 0) : 0, reopened: list.filter((todo) => todo.reopens > 0).length, provider: list[0]?.provider ?? '' };
      })
      .filter((s) => s.priced && s.list.length >= SUGGESTION_MIN_TODOS);
    if (stats.length < 2) continue;
    const byCost = [...stats].sort((a, b) => a.medianCost - b.medianCost || a.model.localeCompare(b.model));
    const expensive = byCost.at(-1);
    if (!expensive) continue;
    const cheap = byCost.find((s) => s !== expensive && s.medianCost <= expensive.medianCost * SUGGESTION_MAX_COST_SHARE && s.reopened / s.list.length <= expensive.reopened / expensive.list.length);
    if (!cheap) continue;
    const share = expensive.medianCost > 0 ? cheap.medianCost / expensive.medianCost : 0;
    const provider = cheap.provider as CliProviderId;
    out.push({
      id: `${key}|${cheap.model}`,
      text: `${modelLabel(cheap.model)} finished ${cheap.list.length} ${group.priority}-priority todos ${estimateText(group.estimate)} with ${cheap.reopened} reopened, ${costShareText(share)} of ${modelLabel(expensive.model)} (${expensive.list.length} todos, ${expensive.reopened} reopened).`,
      evidence: {
        cheap: { model: cheap.model, todos: cheap.list.length, reopened: cheap.reopened, medianCost: cheap.medianCost },
        expensive: { model: expensive.model, todos: expensive.list.length, reopened: expensive.reopened, medianCost: expensive.medianCost },
        currency: prices.currency,
      },
      rule: { priority: group.priority, estimate: group.estimate, provider, model: cheap.model },
    });
  }
  return out;
}

// ── The whole answer ───────────────────────────────────────────────────────────

function inPeriod(at: string, query: Pick<InsightsQuery, 'from' | 'to'>): boolean {
  const day = at.slice(0, 10);
  return day >= query.from && day <= query.to;
}

function distinct(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/** D108: the page's answer from the rows (see the module comment and `docs/insights.md`). */
export function buildInsights(input: InsightsInput): InsightsAnswer {
  const { query, prices } = input;
  const labelFolder = (key: string): string => input.folderLabels?.get(key) ?? folderLabel(key);
  const periodTurns = input.turns.filter((row) => row.day >= query.from && row.day <= query.to);
  const periodTodos = input.todos.filter((todo) => inPeriod(todo.completedAt, query));
  const periodPlans = input.plans === null ? null : input.plans.filter((row) => inPeriod(row.at, query));
  const periodDecisions = input.mergeDecisions.filter((row) => inPeriod(row.at, query));

  const dims: InsightDims[] = [...periodTurns, ...periodTodos];
  const options = {
    folders: distinct(dims.map((d) => d.folder)),
    clis: distinct(dims.map((d) => d.provider).filter((p) => p !== '')),
    models: distinct(dims.map((d) => d.model)),
    accounts: distinct(dims.map((d) => d.profileId).filter((p) => p !== '')).map((id) => ({ id, name: input.accountNames.get(id) ?? id })),
    folderLabels: Object.fromEntries([...(input.folderLabels ?? new Map<string, string>())].filter(([key]) => dims.some((d) => d.folder === key))),
  };

  const turns = periodTurns.filter((row) => matchesFilters(row, query));
  const sessionTurns = turns.filter((row) => row.kind === 'session');
  const chatTurns = turns.filter((row) => row.kind === 'chat');
  const todos = periodTodos.filter((todo) => matchesFilters(todo, query));

  // 1 · Time and tokens.
  const total = sessionTurns.reduce((acc, row) => ({ turns: acc.turns + row.turns, tokens: acc.tokens + row.tokens, durationMs: acc.durationMs + row.durationMs }), { turns: 0, tokens: 0, durationMs: 0 });
  const trend: TrendPoint[] = [];
  const perDay = new Map<string, Acc>();
  for (const row of sessionTurns) {
    const acc = perDay.get(row.day) ?? { turns: 0, tokens: 0, durationMs: 0 };
    acc.turns += row.turns;
    acc.tokens += row.tokens;
    perDay.set(row.day, acc);
  }
  for (let day = query.from; day <= query.to; day = addDays(day, 1)) {
    const acc = perDay.get(day);
    trend.push({ day, turns: acc?.turns ?? 0, tokens: acc?.tokens ?? 0, tokensPerTurn: acc && acc.turns > 0 ? acc.tokens / acc.turns : null });
  }
  const chats = chatTurns.reduce((acc, row) => ({ turns: acc.turns + row.turns, tokens: acc.tokens + row.tokens, durationMs: acc.durationMs + row.durationMs }), { turns: 0, tokens: 0, durationMs: 0 });

  // 2 · Estimates.
  // D147: working time; the open-time-only rows (before D147) are counted apart, and every row's open time is shown apart.
  const openOnly = todos.filter((t) => accuracyRatio(t, 'open') !== null && accuracyRatio(t) === null).length;
  const estimates = { ...accuracyDistribution(todos), byModel: accuracyGroups(todos, (t) => t.model, modelLabel), byFolder: accuracyGroups(todos, (t) => t.folder, labelFolder), openOnly, open: accuracyDistribution(todos, 'open') };

  // 3 · Outcomes and rework, per model.
  const plans = periodPlans?.filter((row) => matchesFilters(row, query)) ?? null;
  const decisions = periodDecisions.filter((row) => matchesFilters(row, query));
  const models = distinct([...sessionTurns.map((r) => r.model), ...todos.map((t) => t.model), ...(plans ?? []).map((p) => p.model), ...(plans ? decisions.map((d) => d.model) : [])]);
  const byModel: OutcomeRow[] = models.map((model) => {
    const done = todos.filter((t) => t.model === model);
    const reopened = done.filter((t) => t.reopens > 0).length;
    const rows = sessionTurns.filter((r) => r.model === model);
    const turnCount = rows.reduce((s, r) => s + r.turns, 0);
    const reverts = rows.reduce((s, r) => s + r.reverts, 0);
    const redos = rows.reduce((s, r) => s + r.redos, 0);
    let planPart: OutcomeRow['plans'] = null;
    if (plans) {
      const mine = plans.filter((p) => p.model === model);
      const merged = mine.filter((p) => p.outcome === 'merged').length;
      const failed = mine.filter((p) => p.outcome === 'failed').length;
      const blocked = mine.filter((p) => p.outcome === 'blocked').length;
      const dec = decisions.filter((d) => d.model === model);
      const dm = dec.filter((d) => d.decision === 'merged').length;
      const ds = dec.filter((d) => d.decision === 'sent-back').length;
      const df = dec.filter((d) => d.decision === 'failed').length;
      planPart = { merged, failed, blocked, mergeRate: ratio(merged, merged + failed + blocked), decisions: { merged: dm, sentBack: ds, failed: df }, sendBackRate: ratio(ds, dm + ds + df) };
    }
    return {
      model,
      label: modelLabel(model),
      todos: { done: done.length, reopened, reopenRate: ratio(reopened, done.length) },
      plans: planPart,
      reverts: { turns: turnCount, reverts, redos, per100Turns: turnCount > 0 ? (Math.max(0, reverts - redos) / turnCount) * 100 : null },
    };
  });

  // 4 · Cost per todo.
  const costs = todos.map((todo) => todoCost(todo, prices));
  const priced = costs.filter((c): c is TodoCost & { cost: number } => c.cost !== null);
  const costTotal = priced.reduce((s, c) => s + c.cost, 0);
  const costModels = distinct(costs.map((c) => c.model));
  const cost: CostSection = {
    currency: prices.currency,
    example: prices.example,
    todos: costs.length,
    priced: priced.length,
    total: costTotal,
    average: priced.length > 0 ? costTotal / priced.length : null,
    median: median(priced.map((c) => c.cost)),
    lowerBound: priced.some((c) => c.lowerBound),
    byModel: costModels.map((model) => {
      const mine = costs.filter((c) => c.model === model);
      const mp = mine.filter((c): c is TodoCost & { cost: number } => c.cost !== null);
      return { model, label: modelLabel(model), todos: mine.length, priced: mp.length, total: mp.reduce((s, c) => s + c.cost, 0), median: median(mp.map((c) => c.cost)) };
    }),
    top: [...priced].sort((a, b) => b.cost - a.cost || a.todoId.localeCompare(b.todoId)).slice(0, TOP_COSTS),
    period: periodCost(sessionTurns, chatTurns, prices, labelFolder),
  };

  // 5 · Forecast (the account filter applies; the period does not: it is about now).
  const forecast: AccountForecast[] = input.accounts
    .filter((account) => query.account === null || account.id === query.account)
    .filter((account) => query.cli === null || account.cli === query.cli)
    .map((account) => {
      const mine = input.readings.filter((r) => r.profileId === account.id);
      return { profileId: account.id, name: account.name, cli: account.cli, windows: [windowForecast(mine, 'five_hour', input.now), windowForecast(mine, 'seven_day', input.now)], credits: account.credits, onCredits: account.onCredits };
    });

  // 6 · Suggestions (every filter but the model: they compare models).
  const suggestions = routingSuggestions(periodTodos.filter((todo) => matchesFilters(todo, { ...query, model: null })), prices);

  return {
    generatedAt: input.now.toISOString(),
    query,
    options,
    backfill: input.backfill,
    machines: input.machines ?? { scope: 'local', included: [{ id: null, name: 'This machine' }], pending: [], missing: [] },
    time: {
      totals: { ...total, tokensPerTurn: total.turns > 0 ? total.tokens / total.turns : null, sessions: new Set(sessionTurns.map((r) => r.sessionId)).size },
      byFolder: groupTurns(sessionTurns, (r) => r.folder, labelFolder),
      bySession: groupTurns(sessionTurns, (r) => r.sessionId, (id) => input.sessionTitles.get(id) ?? 'deleted session').slice(0, TOP_SESSIONS),
      byModel: groupTurns(sessionTurns, (r) => r.model, modelLabel),
      trend,
      chats,
    },
    estimates,
    outcomes: { plansOn: plans !== null, byModel },
    cost,
    forecast,
    suggestions,
  };
}

/**
 * D108: what a turn's `result` event payload records for Insights, from the raw line:
 * `usage` (the split, when the line has one) and `model` (the reported model, when it names
 * one). Both are left out when unknown.
 */
export function resultInsightFields(raw: unknown): { readonly usage?: TokenSplit; readonly model?: string } {
  const usage = resultTokenSplit(raw);
  const model = resultModel(raw);
  return { ...(usage ? { usage } : {}), ...(model ? { model } : {}) };
}

// ── Period cost (D108 ruling) ──────────────────────────────────────────────────

/**
 * D108 ruling: every turn of the period priced: each rollup row's split × its model's price
 * row (`usageCost`; tokens without a split at the input rate, marked as a lower bound), summed
 * per folder, per model and in total. Rows whose model has no price row add their tokens to
 * `unpricedTokens` instead. Chats (D106) are priced apart.
 */
export function periodCost(sessionTurns: readonly TurnRollupRow[], chatTurns: readonly TurnRollupRow[], prices: PriceTable, labelFolder: (key: string) => string = folderLabel): PeriodCost {
  const group = (keyOf: (row: TurnRollupRow) => string, labelOf: (key: string) => string): PeriodCostRow[] => {
    const acc = new Map<string, { cost: number | null; lowerBound: boolean; unpricedTokens: number }>();
    for (const row of sessionTurns) {
      const key = keyOf(row);
      const entry = acc.get(key) ?? { cost: null, lowerBound: false, unpricedTokens: 0 };
      const price = priceFor(prices, row.model);
      if (price) {
        entry.cost = (entry.cost ?? 0) + usageCost(row.usage, price);
        if (row.usage.unsplit > 0) entry.lowerBound = true;
      } else {
        entry.unpricedTokens += row.tokens;
      }
      acc.set(key, entry);
    }
    return [...acc.entries()].map(([key, e]) => ({ key, label: labelOf(key), ...e })).sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || a.key.localeCompare(b.key));
  };
  const byModel = group((r) => r.model, modelLabel);
  let chats = 0;
  for (const row of chatTurns) {
    const price = priceFor(prices, row.model);
    if (price) chats += usageCost(row.usage, price);
  }
  return {
    total: byModel.reduce((sum, row) => sum + (row.cost ?? 0), 0),
    lowerBound: byModel.some((row) => row.lowerBound),
    unpricedTokens: byModel.reduce((sum, row) => sum + row.unpricedTokens, 0),
    byFolder: group((r) => r.folder, labelFolder),
    byModel,
    chats,
  };
}

// ── Merged machines (D108 ruling) ──────────────────────────────────────────────

/** One machine's rows for {@link mergeMachineRows}: `id` `null` = this machine. */
export interface MachineRows {
  readonly machine: { readonly id: string | null; readonly name: string };
  readonly rows: InsightsRows;
}

/** A paired machine's id in this machine's namespace (sessions, todos, accounts): `r~<machine>~<id>`, as D48's proxy does. */
export function remoteId(machineId: string, id: string): string {
  return `r~${machineId}~${id}`;
}

/** A paired machine's folder key: its path and its machine (folders are per machine). */
export function remoteFolder(machineId: string, folder: string): string {
  return folder === '' ? '' : `${folder}@@${machineId}`;
}

/** The path of a folder key (a paired machine's keys carry `@@<machine>`). */
export function folderPath(key: string): string {
  const at = key.lastIndexOf('@@');
  return at < 0 ? key : key.slice(0, at);
}

/**
 * D108 ruling: one view over this machine's and the paired machines' rows. A paired machine's
 * sessions, todos and plan items are namespaced (`r~<machine>~<id>`); its folders stay its own
 * (`<path>@@<machine>`) and, where two folders of the view share a name, each is labelled with
 * its machine (`acme · Studio`); its accounts merge with this machine's by identity (D98) —
 * the same account is one account (its readings together, the forecast over both) — and an
 * account only it has is `<name> (<machine>)`. Models and CLIs are the same everywhere.
 */
export function mergeMachineRows(parts: readonly MachineRows[]): { readonly rows: InsightsRows; readonly folderLabels: Map<string, string> } {
  const turns: TurnRollupRow[] = [];
  const todos: TodoActualRow[] = [];
  let plans: PlanOutcomeRow[] | null = null;
  const mergeDecisions: MergeDecisionRow[] = [];
  const readings: InsightReading[] = [];
  const accounts: InsightAccount[] = [];
  const sessionTitles: Record<string, string> = {};
  const accountNames: Record<string, string> = {};
  const folderMachine = new Map<string, string>();
  // Identity → the account id the view uses (the first machine's that has it; this machine comes first).
  const byIdentity = new Map<string, string>();
  for (const { machine, rows } of parts) {
    const local = machine.id === null;
    const sid = (id: string): string => (local ? id : remoteId(machine.id as string, id));
    const folder = (key: string): string => {
      const out = local ? key : remoteFolder(machine.id as string, key);
      if (out !== '') folderMachine.set(out, machine.name);
      return out;
    };
    const accountMap = new Map<string, string>();
    for (const account of rows.accounts) {
      const known = account.identity ? byIdentity.get(account.identity) : undefined;
      if (known !== undefined) {
        accountMap.set(account.id, known);
        continue;
      }
      const id = local ? account.id : remoteId(machine.id as string, account.id);
      accountMap.set(account.id, id);
      if (account.identity) byIdentity.set(account.identity, id);
      const name = local ? account.name : `${account.name} (${machine.name})`;
      accounts.push({ ...account, id, name });
      accountNames[id] = name;
    }
    for (const [id, name] of Object.entries(rows.accountNames)) {
      const mapped = accountMap.get(id) ?? (local ? id : remoteId(machine.id as string, id));
      accountNames[mapped] ??= local ? name : `${name} (${machine.name})`;
    }
    const profile = (id: string): string => (id === '' ? '' : (accountMap.get(id) ?? (local ? id : remoteId(machine.id as string, id))));
    for (const row of rows.turns) turns.push({ ...row, sessionId: sid(row.sessionId), folder: folder(row.folder), profileId: profile(row.profileId) });
    for (const row of rows.todos) todos.push({ ...row, todoId: sid(row.todoId), sessionId: sid(row.sessionId), runSessionId: row.runSessionId === null ? null : sid(row.runSessionId), folder: folder(row.folder), profileId: profile(row.profileId) });
    if (rows.plans) plans = [...(plans ?? []), ...rows.plans.map((row) => ({ ...row, itemId: sid(row.itemId), folder: folder(row.folder), profileId: profile(row.profileId) }))];
    for (const row of rows.mergeDecisions) mergeDecisions.push({ ...row, itemId: sid(row.itemId), folder: folder(row.folder), profileId: profile(row.profileId) });
    for (const row of rows.readings) readings.push({ ...row, profileId: profile(row.profileId) });
    for (const [id, title] of Object.entries(rows.sessionTitles)) sessionTitles[sid(id)] = local ? title : `${title} (${machine.name})`;
  }
  // Labels: the folder's last segment, with its machine where two folders of the view share it.
  const base = new Map<string, string[]>();
  for (const key of folderMachine.keys()) base.set(folderLabel(folderPath(key)), [...(base.get(folderLabel(folderPath(key))) ?? []), key]);
  const folderLabels = new Map<string, string>();
  for (const [label, keys] of base) {
    for (const key of keys) {
      if (keys.length > 1) folderLabels.set(key, `${label} · ${folderMachine.get(key) ?? ''}`);
      else if (key !== folderPath(key)) folderLabels.set(key, label);
    }
  }
  readings.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  return { rows: { turns, todos, plans, mergeDecisions, readings, accounts, sessionTitles, accountNames }, folderLabels };
}

/** Reads a paired machine's rows answer defensively; `null` when it is not one. */
export function readInsightsRows(value: unknown): InsightsRows | null {
  if (!isRecord(value)) return null;
  const list = (key: string): unknown[] | null => (Array.isArray(value[key]) ? (value[key] as unknown[]) : null);
  const turns = list('turns');
  const todos = list('todos');
  const decisions = list('mergeDecisions');
  const readings = list('readings');
  const accounts = list('accounts');
  if (!turns || !todos || !decisions || !readings || !accounts) return null;
  const plans = value['plans'] === null ? null : list('plans');
  const record = (key: string): Record<string, string> => (isRecord(value[key]) ? Object.fromEntries(Object.entries(value[key] as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string')) : {});
  return {
    turns: turns.filter(isRecord) as unknown as TurnRollupRow[],
    todos: todos.filter(isRecord) as unknown as TodoActualRow[],
    plans: plans === null ? null : (plans.filter(isRecord) as unknown as PlanOutcomeRow[]),
    mergeDecisions: decisions.filter(isRecord) as unknown as MergeDecisionRow[],
    readings: readings.filter(isRecord) as unknown as InsightReading[],
    accounts: accounts.filter(isRecord) as unknown as InsightAccount[],
    sessionTitles: record('sessionTitles'),
    accountNames: record('accountNames'),
  };
}
