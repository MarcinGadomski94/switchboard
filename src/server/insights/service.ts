import {
  type InsightAccount,
  type InsightsAnswer,
  type InsightsMachines,
  type InsightsQuery,
  type InsightsRows,
  type MachineRows,
  type PlanOutcomeRow,
  addDays,
  buildInsights,
  insightsQueryString,
  mergeMachineRows,
  readInsightsRows,
} from '../../core/insights.ts';
import { creditsInUse, creditsMoneyText } from '../../core/credits.ts';
import type { AccountService } from '../accounts/service.ts';
import type { Store } from '../db/store.ts';
import type { PeerService } from '../peers/service.ts';
import { priceTableOf } from '../settings/settings.ts';
import type { InsightsBackfill } from './backfill.ts';
// Plans (D99) hook: the plan items' outcomes while Plans is on (docs/plans-removal.md).
import { plansInsightOutcomes } from '../plans/hooks.ts';

/** An answer is reused for this long while nothing was rolled up (ms). */
export const INSIGHTS_CACHE_MS = 30_000;

/** A paired machine's rows are reused for this long (ms; D108 ruling: a short TTL). */
export const PEER_ROWS_TTL_MS = 60_000;

/** A stale peer copy is still shown (marked pending, refreshed behind it) up to this age (ms). */
export const PEER_ROWS_STALE_MS = 10 * 60_000;

/** How long a `peers=wait` request waits for a paired machine (ms). */
export const PEER_ROWS_TIMEOUT_MS = 2_500;

/** The forecast reads the readings of this many hours (the weekly pace's lookback). */
const READINGS_LOOKBACK_MS = 24 * 60 * 60_000;

/** How an `all` answer treats the paired machines: `cached` never waits (fetches behind), `wait` waits up to {@link PEER_ROWS_TIMEOUT_MS}. */
export type PeerMode = 'cached' | 'wait';

/** Options of {@link InsightsService}. */
export interface InsightsServiceOptions {
  readonly store: Store;
  readonly backfill: InsightsBackfill;
  readonly accounts: Pick<AccountService, 'usageOf' | 'identityOf'>;
  readonly peers?: Pick<PeerService, 'machines' | 'fanOutGet'> | null;
  readonly now?: () => Date;
  readonly cacheMs?: number;
  readonly peerTtlMs?: number;
  readonly peerTimeoutMs?: number;
}

interface PeerCopy {
  readonly at: number;
  readonly rows: InsightsRows | null;
  readonly reason: string | null;
}

/**
 * D108 (`docs/insights.md`): answers `GET /api/insights` from indexed reads only: the daily
 * rollup of the period's days, `todo_actuals` of the period (by `completed_at`), the D102
 * Merge-step decisions of the period, the last 24 h of usage readings (per account), the
 * account list and, while Plans is on, its items' outcomes. An answer is cached per query
 * for {@link INSIGHTS_CACHE_MS} and dropped as soon as the rollup or a todo's actuals change.
 *
 * D108 ruling (merged machines, `docs/insights.md` → *Merged machines*): `machine=all` (the
 * default) adds every paired machine's **rows** (`GET /api/insights/rows` through the peer
 * API, pulled when the page asks, cached {@link PEER_ROWS_TTL_MS}); `peers=cached` never waits
 * for them (a missing or stale copy is fetched behind and listed as `pending`), so the page
 * shows this machine's numbers at once and asks again with `peers=wait` to fill in.
 */
export class InsightsService {
  readonly #store: Store;
  readonly #backfill: InsightsBackfill;
  readonly #accounts: Pick<AccountService, 'usageOf' | 'identityOf'>;
  readonly #peers: Pick<PeerService, 'machines' | 'fanOutGet'> | null;
  readonly #now: () => Date;
  readonly #cacheMs: number;
  readonly #peerTtl: number;
  readonly #peerTimeout: number;
  readonly #cache = new Map<string, { readonly at: number; readonly stamp: string; readonly answer: InsightsAnswer }>();
  readonly #peerCopies = new Map<string, PeerCopy>();
  readonly #peerFetches = new Map<string, Promise<PeerCopy>>();

  constructor(options: InsightsServiceOptions) {
    this.#store = options.store;
    this.#backfill = options.backfill;
    this.#accounts = options.accounts;
    this.#peers = options.peers ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#cacheMs = options.cacheMs ?? INSIGHTS_CACHE_MS;
    this.#peerTtl = options.peerTtlMs ?? PEER_ROWS_TTL_MS;
    this.#peerTimeout = options.peerTimeoutMs ?? PEER_ROWS_TIMEOUT_MS;
  }

  /** What changes this machine's rows: the rollup's writes, the completed todos and their reopens, the backfill's state. */
  #stamp(): string {
    const todos = this.#store.db.prepare('SELECT COUNT(*) AS n, MAX(completed_at) AS m, (SELECT COUNT(*) FROM todo_reopens) AS r FROM todo_actuals').get();
    return `${this.#store.insights.revision}|${String(todos?.['n'])}|${String(todos?.['m'])}|${String(todos?.['r'])}|${this.#backfill.progress().percent}`;
  }

  /**
   * This machine's rows of the period `from`–`to` (what a paired machine merges:
   * `GET /api/insights/rows`): rollup rows, completed todos with their reopens, Plans outcomes
   * (null while off), Merge-step decisions, the last 24 h of readings, the Claude Code accounts
   * (with their D98 identity and D103 credits), session titles and account names.
   */
  async rows(from: string, to: string): Promise<InsightsRows> {
    const now = this.#now();
    const insights = this.#store.insights;
    const fromIso = `${from}T00:00:00.000Z`;
    const toIso = `${addDays(to, 1)}T00:00:00.000Z`;
    const turns = insights.rollup(from, to);
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
      const identity = await this.#accounts.identityOf(record.id).catch(() => null);
      accounts.push({ id: record.id, cli: record.cli, name: record.name, credits: creditsMoneyText(credits), onCredits: creditsInUse(credits, now.getTime()), identity });
    }
    const ids = [...new Set([...turns.map((row) => row.sessionId), ...todos.map((row) => row.sessionId)])];
    return {
      turns,
      todos,
      plans,
      mergeDecisions,
      readings,
      accounts,
      sessionTitles: Object.fromEntries(insights.sessionTitles(ids)),
      accountNames: Object.fromEntries(profiles.map((record) => [record.id, record.name])),
    };
  }

  /** A paired machine's rows (fetched now; one fetch per machine and period at a time). */
  #fetchPeer(machineId: string, from: string, to: string): Promise<PeerCopy> {
    const key = `${machineId}|${from}|${to}`;
    const running = this.#peerFetches.get(key);
    if (running) return running;
    const peers = this.#peers;
    const fetch = (async (): Promise<PeerCopy> => {
      if (!peers) return { at: Date.now(), rows: null, reason: 'not paired' };
      const [answer] = await peers.fanOutGet(`/api/insights/rows?from=${from}&to=${to}`, { timeoutMs: this.#peerTimeout, only: machineId });
      if (!answer) return { at: Date.now(), rows: null, reason: 'not paired' };
      if (answer.reason !== null) return { at: Date.now(), rows: null, reason: answer.reason.startsWith('an older Switchboard') ? 'an older Switchboard (no merged Insights)' : answer.reason };
      const rows = readInsightsRows(answer.body);
      return { at: Date.now(), rows, reason: rows ? null : 'answered something unexpected' };
    })().then(
      (copy) => {
        this.#peerCopies.set(key, copy);
        this.#peerFetches.delete(key);
        return copy;
      },
      (error: unknown) => {
        this.#peerFetches.delete(key);
        const copy = { at: Date.now(), rows: null, reason: error instanceof Error ? error.message : 'failed' };
        this.#peerCopies.set(key, copy);
        return copy;
      },
    );
    this.#peerFetches.set(key, fetch);
    return fetch;
  }

  /** The paired machines' rows for an `all` answer: what is cached (fetching behind), or waiting for them (`wait`). */
  async #peerRows(from: string, to: string, mode: PeerMode): Promise<{ parts: MachineRows[]; pending: Array<{ id: string; name: string }>; missing: Array<{ id: string; name: string; reason: string }> }> {
    const parts: MachineRows[] = [];
    const pending: Array<{ id: string; name: string }> = [];
    const missing: Array<{ id: string; name: string; reason: string }> = [];
    if (!this.#peers) return { parts, pending, missing };
    const machines = await this.#peers.machines();
    await Promise.all(
      machines.map(async (machine) => {
        const key = `${machine.id}|${from}|${to}`;
        const now = Date.now();
        let copy = this.#peerCopies.get(key) ?? null;
        const usable = copy?.rows ? now - copy.at < PEER_ROWS_STALE_MS : false;
        if (machine.state !== 'online') {
          // Offline (ruling): this machine only, with the reason; an older copy is not shown as if current.
          missing.push({ id: machine.id, name: machine.name, reason: machine.state === 'reconnecting' ? 'reconnecting' : 'offline' });
          return;
        }
        const fresh = copy !== null && now - copy.at < this.#peerTtl;
        if (!fresh) {
          if (mode === 'wait') {
            copy = await this.#fetchPeer(machine.id, from, to);
          } else {
            // Never block the page: fetch behind, show the last copy meanwhile (or nothing yet).
            void this.#fetchPeer(machine.id, from, to);
            pending.push({ id: machine.id, name: machine.name });
            if (!usable) return;
          }
        }
        if (copy?.rows) parts.push({ machine: { id: machine.id, name: machine.name }, rows: copy.rows });
        else if (copy) missing.push({ id: machine.id, name: machine.name, reason: copy.reason ?? 'no answer' });
      }),
    );
    parts.sort((a, b) => a.machine.name.localeCompare(b.machine.name));
    return { parts, pending, missing };
  }

  /**
   * The page's answer for `query`: this machine's alone (`scope: 'local'`, also every paired
   * machine's own request), or merged with the paired machines' rows (`all`).
   */
  async answer(query: InsightsQuery, options: { readonly scope?: 'all' | 'local'; readonly peers?: PeerMode } = {}): Promise<InsightsAnswer> {
    const now = this.#now();
    const scope = options.scope ?? 'local';
    const mode = options.peers ?? 'cached';
    const prices = await priceTableOf(this.#store.settings);
    const peers = scope === 'all' ? await this.#peerRows(query.from, query.to, mode) : null;
    const peerStamp = peers ? JSON.stringify([peers.parts.map((p) => [p.machine.id, this.#peerCopies.get(`${p.machine.id}|${query.from}|${query.to}`)?.at ?? 0]), peers.pending, peers.missing]) : '';
    const key = `${scope}|${insightsQueryString(query)}`;
    const stamp = `${this.#stamp()}|${JSON.stringify(prices)}|${peerStamp}`;
    const cached = this.#cache.get(key);
    if (cached && cached.stamp === stamp && now.getTime() - cached.at < this.#cacheMs && cached.answer.query.to === query.to) return cached.answer;

    const local = await this.rows(query.from, query.to);
    const parts: MachineRows[] = [{ machine: { id: null, name: 'This machine' }, rows: local }, ...(peers?.parts ?? [])];
    const merged = parts.length > 1 ? mergeMachineRows(parts) : { rows: local, folderLabels: new Map<string, string>() };
    const machines: InsightsMachines = { scope, included: parts.map((p) => p.machine), pending: peers?.pending ?? [], missing: peers?.missing ?? [] };
    const rows = merged.rows;
    const answer = buildInsights({
      query,
      now,
      turns: rows.turns,
      todos: rows.todos,
      plans: rows.plans,
      mergeDecisions: rows.mergeDecisions,
      readings: rows.readings,
      accounts: rows.accounts,
      sessionTitles: new Map(Object.entries(rows.sessionTitles)),
      prices,
      accountNames: new Map(Object.entries(rows.accountNames)),
      backfill: this.#backfill.progress(),
      folderLabels: merged.folderLabels,
      machines,
    });
    this.#cache.set(key, { at: now.getTime(), stamp, answer });
    if (this.#cache.size > 50) this.#cache.delete(this.#cache.keys().next().value as string);
    return answer;
  }
}
