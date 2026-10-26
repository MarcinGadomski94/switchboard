/**
 * D134 · "Where your usage went" (`docs/insights.md` → *Usage breakdown*): which sessions
 * used the tokens of each account's usage windows (the current 5-hour window, the current
 * weekly window), today or in the last 7 days, ranked and grouped, with a stacked chart and a
 * paged log of the turns.
 *
 * Pure: no I/O. The server reads the per-turn rows (`insight_turns`, migration 0050) and the
 * accounts' windows, merges the paired machines' rows ({@link mergeUsageRows}) and
 * {@link buildUsage} turns them into one answer (`GET /api/insights/usage`).
 *
 * Honesty rules (D134):
 * - The share is of the tokens **Switchboard recorded** (input + output + cache writes, the
 *   subagents' and workflow agents' included). The providers' limit % is not derived from
 *   tokens (the token cap is not published) and also counts use outside Switchboard.
 * - Cache reads are counted apart (never in the share).
 * - "≈ % of the limit" is only given for one account in its own window, labelled an estimate:
 *   the row's share × the window's usage %.
 */
import type { CliProviderId } from './cli-providers.ts';
import {
  EMPTY_USAGE,
  type InsightsBackfillState,
  type InsightsMachines,
  type PriceTable,
  type TokenSplit,
  type TokenUsage,
  addUsage,
  folderPath,
  priceFor,
  remoteFolder,
  remoteId,
  usageCost,
} from './insights.ts';

// ── Query ─────────────────────────────────────────────────────────────────────

/** The periods: each account's current 5-hour / weekly window, today (from the browser's midnight), the last 7 days. */
export const USAGE_PERIODS = ['5h', 'week', 'today', '7d'] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

/** What the ranked list groups by. */
export const USAGE_GROUPS = ['session', 'folder', 'model', 'account', 'kind'] as const;
export type UsageGroupBy = (typeof USAGE_GROUPS)[number];

/** What a session is (the v2 words: agent, conversation, crew teammate, plan step, routine). */
export const USAGE_KINDS = ['agent', 'conversation', 'crew', 'plan', 'routine'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export const HOUR_MS = 3_600_000;
export const FIVE_HOURS_MS = 5 * HOUR_MS;
export const WEEK_MS = 7 * 24 * HOUR_MS;

/** How far back the per-turn rows are read at most (a weekly window plus a day). */
export const USAGE_MAX_SPAN_MS = 8 * 24 * HOUR_MS;

/** The log's page size (default and most). */
export const USAGE_LOG_PAGE_SIZE = 50;
export const USAGE_LOG_PAGE_MAX = 200;

/** Ranked rows at most (the rest are summed in `more`). */
export const USAGE_ROWS_MAX = 100;

/** Series of the stacked chart: the top ones, plus "everything else". */
export const USAGE_CHART_TOP = 5;

/** The CSV export's rows at most. */
export const USAGE_CSV_MAX = 20_000;

/** What the page asks for. */
export interface UsageQuery {
  readonly period: UsagePeriod;
  /** An account profile id (`null` = every account, each in its own window). */
  readonly account: string | null;
  readonly groupBy: UsageGroupBy;
  /** `today` only: the browser's midnight (ISO); `null` = UTC midnight. */
  readonly from: string | null;
  /** The log shows only this group's turns (a key of `groupBy`), `null` = all. */
  readonly group: string | null;
  /** The log's page (0-based) and size. */
  readonly page: number;
  readonly pageSize: number;
}

type Problems = Array<{ field: string; message: string }>;

function text(raw: unknown, field: string, errors: Problems): string | null {
  if (raw === undefined || raw === null || raw === '' || raw === 'all') return null;
  if (typeof raw !== 'string' || raw.length > 500) {
    errors.push({ field, message: `${field} must be text of at most 500 characters` });
    return null;
  }
  return raw;
}

function int(raw: unknown, field: string, fallback: number, min: number, max: number, errors: Problems): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push({ field, message: `${field} must be a whole number from ${min} to ${max}` });
    return fallback;
  }
  return n;
}

/**
 * `GET /api/insights/usage?period=5h|week|today|7d&account=&groupBy=&from=&group=&page=&pageSize=`
 * → the query, or the 422 errors. Defaults: `5h`, every account, by session, page 0 of 50.
 * `from` (today only) must be an ISO time within the last 26 hours (the browser's midnight).
 */
export function parseUsageQuery(raw: Readonly<Record<string, unknown>>, now: Date): { readonly ok: true; readonly query: UsageQuery } | { readonly ok: false; readonly errors: Problems } {
  const errors: Problems = [];
  const periodRaw = raw['period'] ?? '5h';
  const period = (USAGE_PERIODS as readonly unknown[]).includes(periodRaw) ? (periodRaw as UsagePeriod) : null;
  if (!period) errors.push({ field: 'period', message: 'period must be 5h, week, today or 7d' });
  const groupRaw = raw['groupBy'] ?? 'session';
  const groupBy = (USAGE_GROUPS as readonly unknown[]).includes(groupRaw) ? (groupRaw as UsageGroupBy) : null;
  if (!groupBy) errors.push({ field: 'groupBy', message: 'groupBy must be session, folder, model, account or kind' });
  const account = text(raw['account'], 'account', errors);
  const group = typeof raw['group'] === 'string' && raw['group'].length <= 500 ? raw['group'] : raw['group'] === undefined ? null : (errors.push({ field: 'group', message: 'group must be text of at most 500 characters' }), null);
  let from: string | null = null;
  const fromRaw = text(raw['from'], 'from', errors);
  if (fromRaw !== null) {
    const at = Date.parse(fromRaw);
    if (!Number.isFinite(at) || at > now.getTime() || now.getTime() - at > 26 * HOUR_MS) errors.push({ field: 'from', message: 'from must be a time (ISO) within the last 26 hours: the start of today' });
    else from = new Date(at).toISOString();
  }
  const page = int(raw['page'], 'page', 0, 0, 100_000, errors);
  const pageSize = int(raw['pageSize'], 'pageSize', USAGE_LOG_PAGE_SIZE, 1, USAGE_LOG_PAGE_MAX, errors);
  if (errors.length > 0 || !period || !groupBy) return { ok: false, errors };
  return { ok: true, query: { period, account, groupBy, from, group, page, pageSize } };
}

/** The query as a URL query string (the page and the cache key). */
export function usageQueryString(query: Partial<UsageQuery> & Pick<UsageQuery, 'period'>): string {
  const params = new URLSearchParams();
  params.set('period', query.period);
  if (query.account) params.set('account', query.account);
  if (query.groupBy && query.groupBy !== 'session') params.set('groupBy', query.groupBy);
  if (query.from) params.set('from', query.from);
  if (query.group !== null && query.group !== undefined) params.set('group', query.group);
  if (query.page) params.set('page', String(query.page));
  if (query.pageSize && query.pageSize !== USAGE_LOG_PAGE_SIZE) params.set('pageSize', String(query.pageSize));
  return params.toString();
}

// ── Rows the server reads ──────────────────────────────────────────────────────

/** One turn (a `result` event) as `insight_turns` (0050) keeps it. */
export interface UsageTurnRow {
  /** The result event's id (unique per machine). */
  readonly eventId: number;
  /** When the turn ended (the result event's time, ISO). */
  readonly ts: string;
  readonly sessionId: string;
  readonly provider: string;
  /** The model key (`modelKey`) of the session's own replies. */
  readonly model: string;
  /** The account profile id the session ran on when the turn ended. */
  readonly profileId: string;
  readonly folder: string;
  readonly kind: 'session' | 'chat';
  /** The session's own replies (the result's `usage`; `unsplit` for results without a split). */
  readonly usage: TokenUsage;
  /** Subagents, workflow agents and the CLI's background calls of this turn, per model (from the growth of the CLI's `modelUsage`). */
  readonly agents: Readonly<Record<string, TokenSplit>>;
  readonly durationMs: number;
}

/** A known usage window of an account. */
export interface UsageWindowReading {
  readonly pct: number | null;
  readonly resetsAt: string | null;
}

/** An account as the breakdown needs it. */
export interface UsageAccountRow {
  readonly id: string;
  readonly cli: CliProviderId;
  readonly name: string;
  /** D98: the same identity on two machines is one account. */
  readonly identity: string | null;
  readonly fiveHour: UsageWindowReading | null;
  readonly week: UsageWindowReading | null;
  /** When the windows were read (ISO), `null` when unknown. */
  readonly receivedAt: string | null;
}

/** What one machine gives (`GET /api/insights/usage/rows?from=&to=`, the peer API). */
export interface UsageRows {
  readonly turns: readonly UsageTurnRow[];
  readonly accounts: readonly UsageAccountRow[];
  /** Session titles (else names). */
  readonly sessionTitles: Readonly<Record<string, string>>;
  /** What each session is (plain agents are left out). */
  readonly sessionKinds: Readonly<Record<string, UsageKind>>;
  /** Names of account profiles (also those no longer listed). */
  readonly accountNames: Readonly<Record<string, string>>;
}

// ── Windows ───────────────────────────────────────────────────────────────────

/** The span the period covers for one account (or every account: today, 7 days). */
export interface UsageSpan {
  /** The account, `null` for a span that is the same for every account. */
  readonly accountId: string | null;
  readonly name: string;
  /** ISO times; `end` is now. */
  readonly start: string;
  readonly end: string;
  /** The window's usage % (the provider's), `null` when unknown or not a window. */
  readonly pct: number | null;
  /** When the window resets (ISO), `null` when not a window. */
  readonly resetsAt: string | null;
  /** The newest reading is from before the window reset: the span runs from that reset (the new window's start is not known yet). */
  readonly sinceReset: boolean;
}

/**
 * The span of `period` for `account` at `now`: the 5-hour / weekly window is
 * `[resetsAt − length, now]` while its reset is ahead; once the reset has passed (no newer
 * reading), from the later of the reset and `now − length`, marked {@link UsageSpan.sinceReset}. `null` when the account
 * has no reading of that window. `today` runs from `todayStart` (the browser's midnight, else
 * UTC midnight), `7d` from 7 × 24 h ago.
 */
export function accountSpan(account: UsageAccountRow | null, period: UsagePeriod, now: Date, todayStart: string | null = null): UsageSpan | null {
  const end = now.toISOString();
  if (period === 'today' || period === '7d') {
    const start = period === '7d' ? new Date(now.getTime() - WEEK_MS).toISOString() : (todayStart ?? `${end.slice(0, 10)}T00:00:00.000Z`);
    return { accountId: account?.id ?? null, name: account?.name ?? '', start, end, pct: null, resetsAt: null, sinceReset: false };
  }
  if (!account) return null;
  const reading = period === '5h' ? account.fiveHour : account.week;
  const length = period === '5h' ? FIVE_HOURS_MS : WEEK_MS;
  const reset = reading?.resetsAt ? Date.parse(reading.resetsAt) : Number.NaN;
  if (!reading || !Number.isFinite(reset)) return null;
  if (reset > now.getTime()) {
    return { accountId: account.id, name: account.name, start: new Date(reset - length).toISOString(), end, pct: reading.pct, resetsAt: new Date(reset).toISOString(), sinceReset: false };
  }
  // The window reset and no newer reading came: the new window started at its first use, which is
  // not known; it lies after the reset and within the last window length.
  return { accountId: account.id, name: account.name, start: new Date(Math.max(reset, now.getTime() - length)).toISOString(), end, pct: null, resetsAt: null, sinceReset: true };
}

// ── The answer ────────────────────────────────────────────────────────────────

/** Tokens by kind plus the total the share is of. */
export interface UsageTokens extends TokenUsage {
  /** input + output + cache writes + unsplit (the share's measure; cache reads apart). */
  readonly tokens: number;
}

/** "≈ x % of the limit" (D134): only for one account in its own window. */
export interface UsageEstimate {
  /** ≈ the row's share × the window's usage % (0–100). */
  readonly pct: number;
  readonly window: '5h' | 'week';
}

/** A ranked row. */
export interface UsageRow {
  /** The group's key (session id, folder, model key, account id, kind). */
  readonly key: string;
  readonly label: string;
  /** Own replies + agents. */
  readonly total: UsageTokens;
  /** Subagents, workflow agents and background calls (in `total` already). */
  readonly agents: UsageTokens;
  /** The agents' tokens per model (the expandable breakdown). */
  readonly agentModels: ReadonlyArray<{ readonly model: string; readonly tokens: number; readonly cacheRead: number }>;
  /** Share of the answer's tokens (0–1). */
  readonly share: number;
  readonly estimate: UsageEstimate | null;
  /** Turns (results) of the group; by model: the turns whose own replies used it. */
  readonly turns: number;
  /** Every model of the group (own replies first, then the agents'). */
  readonly models: readonly string[];
  /** At the Insights prices; `null` when nothing of it is priced. */
  readonly cost: number | null;
  /** Some of it is not priced, or was priced at the input rate (no split): the cost is at least this. */
  readonly costPartial: boolean;
  /** By session: the session (to open it), what it is, and its machine. */
  readonly sessionId: string | null;
  readonly kind: UsageKind | null;
  readonly machine: { readonly id: string | null; readonly name: string } | null;
  /** The newest turn (ISO). */
  readonly lastAt: string;
}

/** One turn of the log. */
export interface UsageLogRow {
  /** Unique in the answer (`<machine or local>:<event id>`). */
  readonly id: string;
  readonly at: string;
  readonly sessionId: string;
  readonly title: string;
  readonly kind: UsageKind;
  /** The model of its own replies, then the agents'. */
  readonly models: readonly string[];
  readonly total: UsageTokens;
  readonly agentTokens: number;
  readonly accountId: string;
  readonly accountName: string;
  readonly machine: { readonly id: string | null; readonly name: string };
  readonly folder: string;
}

/** The stacked chart: tokens per time bucket, by the top groups plus "everything else". */
export interface UsageChart {
  /** Each bucket's start (ISO); the last ends at `end`. */
  readonly buckets: readonly string[];
  readonly bucketMs: number;
  readonly start: string;
  readonly end: string;
  readonly series: ReadonlyArray<{ readonly key: string; readonly label: string; readonly values: readonly number[]; readonly other: boolean }>;
}

/** `GET /api/insights/usage`. */
export interface UsageAnswer {
  readonly query: UsageQuery;
  readonly generatedAt: string;
  /** Each account's span (5h / week: the accounts with a known window; today / 7d: one for every account). */
  readonly spans: readonly UsageSpan[];
  /** Accounts with no known window of the period (left out, by name). */
  readonly unknownWindows: readonly string[];
  readonly totals: UsageTokens & { readonly agentTokens: number; readonly turns: number; readonly sessions: number; readonly cost: number | null; readonly costPartial: boolean };
  readonly rows: readonly UsageRow[];
  /** Rows past {@link USAGE_ROWS_MAX}, summed. */
  readonly more: { readonly count: number; readonly tokens: number } | null;
  readonly chart: UsageChart;
  readonly log: { readonly rows: readonly UsageLogRow[]; readonly page: number; readonly pageSize: number; readonly total: number };
  /** The share's denominator: one account (`account`), or every account (`all`). */
  readonly shareOf: 'account' | 'all';
  /** Why there is no estimate (`null` when the rows carry one). */
  readonly estimate: { readonly available: boolean; readonly window: '5h' | 'week' | null; readonly pct: number | null };
  readonly currency: string;
  readonly examplePrices: boolean;
  readonly accounts: ReadonlyArray<{ readonly id: string; readonly name: string; readonly cli: string }>;
  readonly machines: InsightsMachines;
  readonly backfill: InsightsBackfillState;
}

/** Tokens by kind → with the share's measure. */
export function withTokens(usage: TokenUsage): UsageTokens {
  return { ...usage, tokens: usage.input + usage.output + usage.cacheWrite + usage.unsplit };
}

function splitUsage(split: TokenSplit): TokenUsage {
  return { input: split.input, output: split.output, cacheWrite: split.cacheWrite, cacheRead: split.cacheRead, unsplit: 0 };
}

/** A turn's tokens: own replies + agents. */
export function turnTotal(turn: UsageTurnRow): { readonly total: UsageTokens; readonly agents: UsageTokens } {
  let agents = EMPTY_USAGE;
  for (const split of Object.values(turn.agents)) agents = addUsage(agents, split);
  return { total: withTokens(addUsage(turn.usage, agents)), agents: withTokens(agents) };
}

/** A part of a turn with one model (own replies, or one model's agents). */
interface Piece {
  readonly model: string;
  readonly usage: TokenUsage;
  readonly own: boolean;
}

function pieces(turn: UsageTurnRow): Piece[] {
  const out: Piece[] = [{ model: turn.model, usage: turn.usage, own: true }];
  for (const [model, split] of Object.entries(turn.agents)) out.push({ model, usage: splitUsage(split), own: false });
  return out;
}

/** What a session is when the machine did not say (a chat is a conversation, else an agent). */
export function kindOf(turn: Pick<UsageTurnRow, 'sessionId' | 'kind'>, kinds: Readonly<Record<string, UsageKind>>): UsageKind {
  return kinds[turn.sessionId] ?? (turn.kind === 'chat' ? 'conversation' : 'agent');
}

/** The bucket length of the chart for a span (≤ 24 buckets, a round length). */
export function chartBucketMs(spanMs: number): number {
  const steps = [15, 30, 60, 120, 180, 360, 720, 1_440].map((m) => m * 60_000);
  return steps.find((step) => spanMs / step <= 24) ?? steps[steps.length - 1]!;
}

/** Everything {@link buildUsage} needs. */
export interface BuildUsageInput {
  readonly query: UsageQuery;
  readonly now: Date;
  readonly rows: UsageRows;
  /** The machine of each session (merged views); absent = this machine. */
  readonly machineOf?: (sessionId: string) => { readonly id: string | null; readonly name: string };
  readonly folderLabels?: ReadonlyMap<string, string>;
  readonly prices: PriceTable;
  readonly machines: InsightsMachines;
  readonly backfill: InsightsBackfillState;
}

function folderName(key: string, labels: ReadonlyMap<string, string> | undefined): string {
  const label = labels?.get(key);
  if (label) return label;
  const path = folderPath(key);
  if (path === '') return 'No folder';
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** The `UsageKind` words of the classic page and the CSV (v2 has its own glossary). */
export const USAGE_KIND_LABELS: Readonly<Record<UsageKind, string>> = { agent: 'Agent', conversation: 'Conversation', crew: 'Teammate', plan: 'Plan step', routine: 'Routine' };

interface Acc {
  key: string;
  label: string;
  total: TokenUsage;
  agents: TokenUsage;
  agentModels: Map<string, TokenUsage>;
  turns: Set<string>;
  models: string[];
  cost: number;
  priced: boolean;
  partial: boolean;
  sessionId: string | null;
  kind: UsageKind | null;
  machine: { id: string | null; name: string } | null;
  lastAt: string;
}

/**
 * The breakdown (D134, `docs/insights.md` → *Usage breakdown*): the turns of each account's
 * span, ranked by tokens (input + output + cache writes, agents included; cache reads apart)
 * under `groupBy`, with shares of the answer's tokens, the "≈ % of the limit" estimate for one
 * account in its own window, costs at the Insights prices, the stacked chart and the log.
 */
export function buildUsage(input: BuildUsageInput): UsageAnswer {
  const { query, now, rows, prices } = input;
  const machineOf = input.machineOf ?? (() => ({ id: null, name: 'This machine' }));
  const accountName = (id: string): string => rows.accountNames[id] ?? rows.accounts.find((a) => a.id === id)?.name ?? (id === '' ? 'unknown account' : id);
  const accounts = query.account === null ? rows.accounts : rows.accounts.filter((a) => a.id === query.account);

  // Spans: per account for the windows; one for everyone for today / 7 days.
  const spans: UsageSpan[] = [];
  const unknownWindows: string[] = [];
  const spanOf = new Map<string, UsageSpan>();
  let common: UsageSpan | null = null;
  if (query.period === 'today' || query.period === '7d') {
    common = accountSpan(null, query.period, now, query.from);
    if (common) spans.push(query.account ? { ...common, accountId: query.account, name: accountName(query.account) } : common);
  } else {
    for (const account of accounts) {
      const span = accountSpan(account, query.period, now);
      if (span) {
        spans.push(span);
        spanOf.set(account.id, span);
      } else unknownWindows.push(account.name);
    }
    if (query.account !== null && accounts.length === 0) unknownWindows.push(accountName(query.account));
  }
  const inSpan = (turn: UsageTurnRow): boolean => {
    if (query.account !== null && turn.profileId !== query.account) return false;
    const span = common ?? spanOf.get(turn.profileId);
    if (!span) return false;
    return turn.ts >= span.start && turn.ts <= span.end;
  };
  const turns = rows.turns.filter(inSpan);

  const keyOf = (turn: UsageTurnRow, piece: Piece): string => {
    switch (query.groupBy) {
      case 'session':
        return turn.sessionId;
      case 'folder':
        return turn.folder;
      case 'model':
        return piece.model;
      case 'account':
        return turn.profileId;
      case 'kind':
        return kindOf(turn, rows.sessionKinds);
    }
  };
  const labelOf = (key: string, turn: UsageTurnRow): string => {
    switch (query.groupBy) {
      case 'session':
        return rows.sessionTitles[key] ?? 'deleted session';
      case 'folder':
        return folderName(key, input.folderLabels);
      case 'model':
        return key === '' ? 'default model' : key;
      case 'account':
        return accountName(key);
      case 'kind':
        return USAGE_KIND_LABELS[kindOf(turn, rows.sessionKinds)];
    }
  };

  const groups = new Map<string, Acc>();
  let totalUsage = EMPTY_USAGE;
  let agentUsage = EMPTY_USAGE;
  let totalCost = 0;
  let anyPriced = false;
  let anyPartial = false;
  const sessions = new Set<string>();
  for (const turn of turns) {
    sessions.add(turn.sessionId);
    for (const piece of pieces(turn)) {
      const key = keyOf(turn, piece);
      let acc = groups.get(key);
      if (!acc) {
        acc = {
          key,
          label: labelOf(key, turn),
          total: EMPTY_USAGE,
          agents: EMPTY_USAGE,
          agentModels: new Map(),
          turns: new Set(),
          models: [],
          cost: 0,
          priced: false,
          partial: false,
          sessionId: query.groupBy === 'session' ? turn.sessionId : null,
          kind: query.groupBy === 'session' ? kindOf(turn, rows.sessionKinds) : null,
          machine: query.groupBy === 'session' ? machineOf(turn.sessionId) : null,
          lastAt: turn.ts,
        };
        groups.set(key, acc);
      }
      const amount = piece.usage.input + piece.usage.output + piece.usage.cacheWrite + piece.usage.cacheRead + piece.usage.unsplit;
      if (amount === 0 && !piece.own) continue;
      acc.total = addUsage(acc.total, piece.usage);
      totalUsage = addUsage(totalUsage, piece.usage);
      if (piece.own) acc.turns.add(`${turn.sessionId}|${turn.eventId}`);
      else {
        acc.agents = addUsage(acc.agents, piece.usage);
        agentUsage = addUsage(agentUsage, piece.usage);
        acc.agentModels.set(piece.model, addUsage(acc.agentModels.get(piece.model) ?? EMPTY_USAGE, piece.usage));
      }
      if (amount > 0 && !acc.models.includes(piece.model) && (piece.own || piece.model !== '')) {
        if (piece.own) acc.models.unshift(piece.model);
        else acc.models.push(piece.model);
      }
      if (turn.ts > acc.lastAt) acc.lastAt = turn.ts;
      const price = priceFor(prices, piece.model);
      if (amount > 0) {
        if (price) {
          const cost = usageCost(piece.usage, price);
          acc.cost += cost;
          acc.priced = true;
          totalCost += cost;
          anyPriced = true;
          if (piece.usage.unsplit > 0) {
            acc.partial = true;
            anyPartial = true;
          }
        } else {
          acc.partial = true;
          anyPartial = true;
        }
      }
    }
  }
  const totals = withTokens(totalUsage);
  // The estimate: one account, its own 5-hour / weekly window, its usage % known.
  const oneSpan = query.account !== null && (query.period === '5h' || query.period === 'week') ? (spanOf.get(query.account) ?? null) : null;
  const estimatePct = oneSpan && !oneSpan.sinceReset ? oneSpan.pct : null;
  const estimateWindow = query.period === '5h' || query.period === 'week' ? query.period : null;

  const ranked = [...groups.values()]
    .map((acc): UsageRow => {
      const total = withTokens(acc.total);
      const share = totals.tokens > 0 ? total.tokens / totals.tokens : 0;
      return {
        key: acc.key,
        label: acc.label,
        total,
        agents: withTokens(acc.agents),
        agentModels: [...acc.agentModels]
          .map(([model, usage]) => ({ model, tokens: withTokens(usage).tokens, cacheRead: usage.cacheRead }))
          .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model)),
        share,
        estimate: estimatePct !== null && estimateWindow !== null ? { pct: share * estimatePct, window: estimateWindow } : null,
        turns: acc.turns.size,
        models: acc.models,
        cost: acc.priced ? acc.cost : null,
        costPartial: acc.partial,
        sessionId: acc.sessionId,
        kind: acc.kind,
        machine: acc.machine,
        lastAt: acc.lastAt,
      };
    })
    .filter((row) => row.total.tokens > 0 || row.total.cacheRead > 0 || row.turns > 0)
    .sort((a, b) => b.total.tokens - a.total.tokens || b.total.cacheRead - a.total.cacheRead || a.label.localeCompare(b.label));
  const shown = ranked.slice(0, USAGE_ROWS_MAX);
  const rest = ranked.slice(USAGE_ROWS_MAX);

  // The chart: the top groups (by tokens) and everything else, per bucket.
  const startMs = Math.min(now.getTime(), ...spans.map((s) => Date.parse(s.start)));
  const endMs = now.getTime();
  const bucketMs = chartBucketMs(Math.max(1, endMs - startMs));
  const firstBucket = Math.floor(startMs / bucketMs) * bucketMs;
  const count = Math.max(1, Math.ceil((endMs - firstBucket + 1) / bucketMs));
  const buckets = Array.from({ length: count }, (_, i) => new Date(firstBucket + i * bucketMs).toISOString());
  const top = ranked.slice(0, USAGE_CHART_TOP).filter((row) => row.total.tokens > 0);
  const series = top.map((row) => ({ key: row.key, label: row.label, values: new Array<number>(count).fill(0), other: false }));
  const other = { key: '__other__', label: 'Everything else', values: new Array<number>(count).fill(0), other: true };
  const seriesOf = new Map(series.map((s) => [s.key, s]));
  for (const turn of turns) {
    const index = Math.min(count - 1, Math.max(0, Math.floor((Date.parse(turn.ts) - firstBucket) / bucketMs)));
    for (const piece of pieces(turn)) {
      const tokens = piece.usage.input + piece.usage.output + piece.usage.cacheWrite + piece.usage.unsplit;
      if (tokens === 0) continue;
      const target = seriesOf.get(keyOf(turn, piece)) ?? other;
      target.values[index] = (target.values[index] ?? 0) + tokens;
    }
  }
  const chart: UsageChart = {
    buckets,
    bucketMs,
    start: new Date(firstBucket).toISOString(),
    end: now.toISOString(),
    series: [...series, ...(other.values.some((v) => v > 0) ? [other] : [])],
  };

  // The log: the period's turns, newest first, of one group when asked.
  const logTurns = (query.group === null ? turns : turns.filter((turn) => pieces(turn).some((piece) => keyOf(turn, piece) === query.group && (piece.own || piece.usage.input + piece.usage.output + piece.usage.cacheWrite + piece.usage.cacheRead > 0))))
    .slice()
    .sort((a, b) => b.ts.localeCompare(a.ts) || b.eventId - a.eventId);
  const page = Math.min(query.page, Math.max(0, Math.ceil(logTurns.length / query.pageSize) - 1));
  const logRows = logTurns.slice(page * query.pageSize, (page + 1) * query.pageSize).map((turn) => logRow(turn, rows, machineOf, accountName));

  return {
    query: { ...query, page },
    generatedAt: now.toISOString(),
    spans,
    unknownWindows,
    totals: { ...totals, agentTokens: withTokens(agentUsage).tokens, turns: turns.length, sessions: sessions.size, cost: anyPriced ? totalCost : null, costPartial: anyPartial },
    rows: shown,
    more: rest.length > 0 ? { count: rest.length, tokens: rest.reduce((sum, row) => sum + row.total.tokens, 0) } : null,
    chart,
    log: { rows: logRows, page, pageSize: query.pageSize, total: logTurns.length },
    shareOf: query.account === null ? 'all' : 'account',
    estimate: { available: estimatePct !== null, window: estimateWindow, pct: estimatePct },
    currency: prices.currency,
    examplePrices: prices.example,
    accounts: rows.accounts.map((a) => ({ id: a.id, name: a.name, cli: a.cli })),
    machines: input.machines,
    backfill: input.backfill,
  };
}

function logRow(turn: UsageTurnRow, rows: UsageRows, machineOf: (id: string) => { readonly id: string | null; readonly name: string }, accountName: (id: string) => string): UsageLogRow {
  const { total, agents } = turnTotal(turn);
  const models = [turn.model, ...Object.entries(turn.agents).filter(([model, s]) => model !== turn.model && s.input + s.output + s.cacheWrite + s.cacheRead > 0).map(([model]) => model)];
  const machine = machineOf(turn.sessionId);
  return {
    id: `${machine.id ?? 'local'}:${turn.eventId}`,
    at: turn.ts,
    sessionId: turn.sessionId,
    title: rows.sessionTitles[turn.sessionId] ?? 'deleted session',
    kind: kindOf(turn, rows.sessionKinds),
    models,
    total,
    agentTokens: agents.tokens,
    accountId: turn.profileId,
    accountName: accountName(turn.profileId),
    machine,
    folder: turn.folder,
  };
}

/** The time range whose turns a period can need at `now` (what is read, and asked of the paired machines). */
export function usageReadRange(query: Pick<UsageQuery, 'period' | 'from'>, now: Date): { readonly from: string; readonly to: string } {
  const to = now.toISOString();
  switch (query.period) {
    case '5h':
      return { from: new Date(now.getTime() - FIVE_HOURS_MS).toISOString(), to };
    case 'week':
    case '7d':
      return { from: new Date(now.getTime() - WEEK_MS).toISOString(), to };
    case 'today':
      return { from: query.from ?? `${to.slice(0, 10)}T00:00:00.000Z`, to };
  }
}

/** The log as CSV (RFC 4180; one header line). */
export function usageLogCsv(rows: readonly UsageLogRow[]): string {
  const cell = (value: string | number): string => {
    const s = String(value);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['time', 'session', 'kind', 'models', 'input', 'output', 'cache_write', 'cache_read', 'unsplit', 'tokens', 'agent_tokens', 'account', 'computer', 'folder'];
  const lines = rows.map((row) =>
    [row.at, row.title, row.kind, row.models.map((m) => m || 'default model').join(' + '), row.total.input, row.total.output, row.total.cacheWrite, row.total.cacheRead, row.total.unsplit, row.total.tokens, row.agentTokens, row.accountName, row.machine.name, folderPath(row.folder)].map(cell).join(','),
  );
  return `${[header.join(','), ...lines].join('\r\n')}\r\n`;
}

// ── The CLI's cumulative usage → the agents' tokens of a turn ─────────────────

/** Per model: the CLI's cumulative token counts (`modelUsage`). */
export type ModelTotals = Readonly<Record<string, TokenSplit>>;

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A raw `result` line's `modelUsage` as per-model token counts, keyed by the model name the
 * Insights model key uses (`canonicalModel`, else the key without a date suffix); `null` when
 * it has no token counts (Codex and OpenCode report none). Claude Code's `modelUsage` is
 * **cumulative** for the session (restored on resume) and includes its subagents', workflow
 * agents' and background calls' tokens, while `usage` is the turn's own main-thread replies.
 */
export function resultModelTotals(raw: unknown): ModelTotals | null {
  if (!isRecord(raw) || !isRecord(raw['modelUsage'])) return null;
  const out: Record<string, TokenSplit> = {};
  let any = false;
  for (const [key, entry] of Object.entries(raw['modelUsage'])) {
    if (!isRecord(entry)) continue;
    const name = typeof entry['canonicalModel'] === 'string' && entry['canonicalModel'] !== '' ? entry['canonicalModel'] : key.replace(/-\d{8}$/, '');
    const split = { input: count(entry['inputTokens']), output: count(entry['outputTokens']), cacheWrite: count(entry['cacheCreationInputTokens']), cacheRead: count(entry['cacheReadInputTokens']) };
    if (split.input + split.output + split.cacheWrite + split.cacheRead === 0) continue;
    const prev = out[name];
    out[name] = prev ? { input: prev.input + split.input, output: prev.output + split.output, cacheWrite: prev.cacheWrite + split.cacheWrite, cacheRead: prev.cacheRead + split.cacheRead } : split;
    any = true;
  }
  return any ? out : null;
}

/** A stored `modelTotals` read defensively. */
export function readModelTotals(value: unknown): ModelTotals | null {
  if (!isRecord(value)) return null;
  const out: Record<string, TokenSplit> = {};
  for (const [model, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    out[model] = { input: count(entry['input']), output: count(entry['output']), cacheWrite: count(entry['cacheWrite']), cacheRead: count(entry['cacheRead']) };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * D134: the tokens of a turn's subagents, workflow agents and background calls, per model:
 * the growth of the CLI's cumulative `modelUsage` since `baseline` (the session's previous
 * turn), minus the turn's own `usage` (on its own model). A total that went down (the CLI
 * started counting afresh) counts from zero. **Never over-counts**: every part is clamped at 0,
 * and with no baseline (`null`) nothing is attributed unless `fresh` (the session's first turn
 * ever, so the CLI started at zero).
 */
export function agentTokensOfTurn(current: ModelTotals | null, baseline: ModelTotals | null, own: TokenSplit | null, ownModel: string, fresh: boolean): Record<string, TokenSplit> {
  if (!current) return {};
  if (!baseline && !fresh) return {};
  let base: ModelTotals = baseline ?? {};
  const wentDown = Object.entries(base).some(([model, b]) => {
    const c = current[model];
    return !c || c.input < b.input || c.output < b.output || c.cacheWrite < b.cacheWrite || c.cacheRead < b.cacheRead;
  });
  if (wentDown) base = {};
  const out: Record<string, TokenSplit> = {};
  for (const [model, c] of Object.entries(current)) {
    const b = base[model] ?? { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    const mine = model === ownModel && own ? own : { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    const d = {
      input: Math.max(0, c.input - b.input - mine.input),
      output: Math.max(0, c.output - b.output - mine.output),
      cacheWrite: Math.max(0, c.cacheWrite - b.cacheWrite - mine.cacheWrite),
      cacheRead: Math.max(0, c.cacheRead - b.cacheRead - mine.cacheRead),
    };
    if (d.input + d.output + d.cacheWrite + d.cacheRead > 0) out[model] = d;
  }
  return out;
}

// ── Merged machines ───────────────────────────────────────────────────────────

/** One machine's rows: `id` `null` = this machine. */
export interface UsageMachineRows {
  readonly machine: { readonly id: string | null; readonly name: string };
  readonly rows: UsageRows;
}

/**
 * D134 over D108's merged machines: a paired machine's sessions are `r~<machine>~<id>`, its
 * folders `<path>@@<machine>` (labelled with the machine where two share a name), its accounts
 * merge with this machine's by identity (D98; the newest reading of the windows wins) or are
 * "<name> (<machine>)". Every turn keeps its machine (the rows' computer tag).
 */
export function mergeUsageRows(parts: readonly UsageMachineRows[]): { readonly rows: UsageRows; readonly machineOf: (sessionId: string) => { readonly id: string | null; readonly name: string }; readonly folderLabels: Map<string, string> } {
  const turns: UsageTurnRow[] = [];
  const accounts: UsageAccountRow[] = [];
  const sessionTitles: Record<string, string> = {};
  const sessionKinds: Record<string, UsageKind> = {};
  const accountNames: Record<string, string> = {};
  const machines = new Map<string, { id: string | null; name: string }>();
  const folderMachine = new Map<string, string>();
  const byIdentity = new Map<string, number>();
  const self = parts.find((p) => p.machine.id === null)?.machine ?? { id: null, name: 'This machine' };
  for (const { machine, rows } of parts) {
    const local = machine.id === null;
    const sid = (id: string): string => (local ? id : remoteId(machine.id as string, id));
    const accountMap = new Map<string, string>();
    for (const account of rows.accounts) {
      const known = account.identity ? byIdentity.get(account.identity) : undefined;
      if (known !== undefined) {
        const merged = accounts[known]!;
        accountMap.set(account.id, merged.id);
        // The newest reading of the windows wins.
        if ((account.receivedAt ?? '') > (merged.receivedAt ?? '')) accounts[known] = { ...merged, fiveHour: account.fiveHour, week: account.week, receivedAt: account.receivedAt };
        continue;
      }
      const id = local ? account.id : remoteId(machine.id as string, account.id);
      const name = local ? account.name : `${account.name} (${machine.name})`;
      accountMap.set(account.id, id);
      if (account.identity) byIdentity.set(account.identity, accounts.length);
      accounts.push({ ...account, id, name });
      accountNames[id] = name;
    }
    for (const [id, name] of Object.entries(rows.accountNames)) {
      const mapped = accountMap.get(id) ?? (local ? id : remoteId(machine.id as string, id));
      accountNames[mapped] ??= local ? name : `${name} (${machine.name})`;
    }
    const profile = (id: string): string => (id === '' ? '' : (accountMap.get(id) ?? (local ? id : remoteId(machine.id as string, id))));
    for (const turn of rows.turns) {
      const sessionId = sid(turn.sessionId);
      const folder = local ? turn.folder : remoteFolder(machine.id as string, turn.folder);
      if (folder !== '') folderMachine.set(folder, machine.name);
      machines.set(sessionId, machine);
      turns.push({ ...turn, sessionId, folder, profileId: profile(turn.profileId) });
    }
    for (const [id, title] of Object.entries(rows.sessionTitles)) sessionTitles[sid(id)] = local ? title : `${title} (${machine.name})`;
    for (const [id, kind] of Object.entries(rows.sessionKinds)) sessionKinds[sid(id)] = kind;
  }
  const base = new Map<string, string[]>();
  const short = (key: string): string => {
    const path = folderPath(key);
    return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  };
  for (const key of folderMachine.keys()) base.set(short(key), [...(base.get(short(key)) ?? []), key]);
  const folderLabels = new Map<string, string>();
  for (const [label, keys] of base) {
    for (const key of keys) {
      if (keys.length > 1) folderLabels.set(key, `${label} · ${folderMachine.get(key) ?? ''}`);
      else if (key !== folderPath(key)) folderLabels.set(key, label);
    }
  }
  return { rows: { turns, accounts, sessionTitles, sessionKinds, accountNames }, machineOf: (id) => machines.get(id) ?? self, folderLabels };
}

/** A paired machine's rows answer read defensively; `null` when it is not one. */
export function readUsageRows(value: unknown): UsageRows | null {
  if (!isRecord(value) || !Array.isArray(value['turns']) || !Array.isArray(value['accounts'])) return null;
  const record = <T>(key: string, ok: (v: unknown) => v is T): Record<string, T> =>
    isRecord(value[key]) ? Object.fromEntries(Object.entries(value[key] as Record<string, unknown>).filter((e): e is [string, T] => ok(e[1]))) : {};
  const isString = (v: unknown): v is string => typeof v === 'string';
  const isKind = (v: unknown): v is UsageKind => (USAGE_KINDS as readonly unknown[]).includes(v);
  return {
    turns: (value['turns'] as unknown[]).filter((t): t is UsageTurnRow => isRecord(t) && typeof t['ts'] === 'string' && typeof t['sessionId'] === 'string' && isRecord(t['usage'])).map((t) => ({ ...t, agents: isRecord(t.agents) ? t.agents : {} })),
    accounts: (value['accounts'] as unknown[]).filter((a): a is UsageAccountRow => isRecord(a) && typeof a['id'] === 'string' && typeof a['name'] === 'string'),
    sessionTitles: record('sessionTitles', isString),
    sessionKinds: record('sessionKinds', isKind),
    accountNames: record('accountNames', isString),
  };
}
