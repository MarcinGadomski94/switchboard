import { CLI_SHORT_LABELS, type CliProviderId } from '../../core/cli-providers.ts';
import type { InsightsMachines } from '../../core/insights.ts';
import {
  BACKGROUND_SESSION_PREFIX,
  USAGE_CSV_MAX,
  type UsageAccountRow,
  type UsageAnswer,
  type UsageKind,
  type UsageMachineRows,
  type UsageQuery,
  type UsageRows,
  buildUsage,
  isBackgroundSession,
  mergeUsageRows,
  readUsageRows,
  usageLogCsv,
  usageQueryString,
  usageReadRange,
} from '../../core/usage-breakdown.ts';
import type { AccountService } from '../accounts/service.ts';
import type { Store } from '../db/store.ts';
import type { PeerService } from '../peers/service.ts';
import { priceTableOf } from '../settings/settings.ts';
import { PEER_ROWS_TIMEOUT_MS, PEER_ROWS_TTL_MS, type PeerMode } from './service.ts';
import type { UsageTurnsBackfill } from './turns-backfill.ts';
// Plans (D99) hook: plan item run sessions are "plan steps" (docs/plans-removal.md).
import { plansRunSessionIds } from '../plans/hooks.ts';
// Team (D100) hook: a member's session is a teammate (docs/team-removal.md).
import { teamMemberList } from '../team/hooks.ts';

/** An account's name as the usage grid shows it: a Claude Code account by its name, another CLI's with its label (`Codex Default`). */
function accountLabel(record: { readonly cli: CliProviderId; readonly name: string }): string {
  return record.cli === 'claude' ? record.name : `${CLI_SHORT_LABELS[record.cli]} ${record.name}`;
}

/** An answer is reused for this long while no turn was recorded (ms). */
export const USAGE_CACHE_MS = 15_000;

/** Options of {@link UsageService}. */
export interface UsageServiceOptions {
  readonly store: Store;
  readonly backfill: Pick<UsageTurnsBackfill, 'progress'>;
  readonly accounts: Pick<AccountService, 'usageOf' | 'identityOf'>;
  readonly peers?: Pick<PeerService, 'machines' | 'fanOutGet'> | null;
  readonly now?: () => Date;
  readonly cacheMs?: number;
  readonly peerTtlMs?: number;
  readonly peerTimeoutMs?: number;
}

interface PeerCopy {
  readonly at: number;
  readonly rows: UsageRows | null;
  readonly reason: string | null;
}

/**
 * D134 (`docs/insights.md` → *Usage breakdown*): answers `GET /api/insights/usage` from the
 * per-turn rows (`insight_turns`, 0050; indexed by time) of the period's read range, the
 * accounts' usage windows (D63's readings; a Codex account's own windows) and, merged by
 * default like D108, the paired machines' rows (`GET /api/insights/usage/rows`, pulled when the
 * page asks, cached {@link PEER_ROWS_TTL_MS}; `peers=cached` never waits).
 */
export class UsageService {
  readonly #store: Store;
  readonly #backfill: Pick<UsageTurnsBackfill, 'progress'>;
  readonly #accounts: Pick<AccountService, 'usageOf' | 'identityOf'>;
  readonly #peers: Pick<PeerService, 'machines' | 'fanOutGet'> | null;
  readonly #now: () => Date;
  readonly #cacheMs: number;
  readonly #peerTtl: number;
  readonly #peerTimeout: number;
  readonly #cache = new Map<string, { readonly at: number; readonly stamp: string; readonly answer: UsageAnswer }>();
  readonly #peerCopies = new Map<string, PeerCopy>();
  readonly #peerFetches = new Map<string, Promise<PeerCopy>>();

  constructor(options: UsageServiceOptions) {
    this.#store = options.store;
    this.#backfill = options.backfill;
    this.#accounts = options.accounts;
    this.#peers = options.peers ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#cacheMs = options.cacheMs ?? USAGE_CACHE_MS;
    this.#peerTtl = options.peerTtlMs ?? PEER_ROWS_TTL_MS;
    this.#peerTimeout = options.peerTimeoutMs ?? PEER_ROWS_TIMEOUT_MS;
  }

  /**
   * This machine's rows of `fromIso`–`toIso` (what a paired machine merges): the turns, every
   * account with its windows and D98 identity, session titles and kinds, account names.
   */
  async rows(fromIso: string, toIso: string): Promise<UsageRows> {
    const insights = this.#store.insights;
    const turns = insights.usageTurns(fromIso, toIso);
    const profiles = await this.#store.profiles.list();
    const accounts: UsageAccountRow[] = [];
    for (const record of profiles) {
      const used = turns.some((t) => t.profileId === record.id);
      const usage = await this.#accounts.usageOf(record).catch(() => null);
      // Claude Code accounts in use, and any account with a reading or turns (an unused Codex / OpenCode Default is left out).
      if (!used && (record.cli !== 'claude' || !record.enabled) && !usage) continue;
      const identity = await this.#accounts.identityOf(record.id).catch(() => null);
      accounts.push({
        id: record.id,
        cli: record.cli,
        name: accountLabel(record),
        identity,
        fiveHour: usage && (usage.fiveHourPct !== null || usage.fiveHourResetsAt !== null) ? { pct: usage.fiveHourPct, resetsAt: usage.fiveHourResetsAt } : null,
        week: usage && (usage.sevenDayPct !== null || usage.sevenDayResetsAt !== null) ? { pct: usage.sevenDayPct, resetsAt: usage.sevenDayResetsAt } : null,
        receivedAt: usage?.receivedAt ?? null,
      });
    }
    const ids = [...new Set(turns.map((t) => t.sessionId))];
    const kinds: Record<string, UsageKind> = {};
    const chats = new Set(turns.filter((t) => t.kind === 'chat').map((t) => t.sessionId));
    const routines = insights.routineSessions(ids);
    const plans = new Set(await plansRunSessionIds(this.#store).catch(() => []));
    const mates = new Set(teamMemberList(this.#store).map((member) => member.sessionId));
    const titles: Record<string, string> = Object.fromEntries(insights.sessionTitles(ids.filter((id) => !isBackgroundSession(id))));
    const folderLabels = new Map((await this.#store.folders.list()).map((folder) => [folder.canonicalPath, folder.label ?? '']));
    for (const id of ids) {
      // Project memory (D107) hook, D136: a folder's memory checks (no session): kind "Memory check", titled with the folder.
      if (isBackgroundSession(id)) {
        const folder = id.slice(BACKGROUND_SESSION_PREFIX.length);
        kinds[id] = 'memory';
        titles[id] = `Memory check · ${folderLabels.get(folder) || folder.split(/[\\/]/).filter(Boolean).at(-1) || folder}`;
        continue;
      }
      // The v2 order: a teammate, a plan step, a conversation, a routine; else a plain agent (left out).
      if (mates.has(id)) kinds[id] = 'crew';
      else if (plans.has(id)) kinds[id] = 'plan';
      else if (chats.has(id)) kinds[id] = 'conversation';
      else if (routines.has(id)) kinds[id] = 'routine';
    }
    return {
      turns,
      accounts,
      sessionTitles: titles,
      sessionKinds: kinds,
      accountNames: Object.fromEntries(profiles.map((record) => [record.id, accountLabel(record)])),
    };
  }

  #fetchPeer(machineId: string, key: string, fromIso: string, toIso: string): Promise<PeerCopy> {
    const running = this.#peerFetches.get(key);
    if (running) return running;
    const peers = this.#peers;
    const fetch = (async (): Promise<PeerCopy> => {
      if (!peers) return { at: Date.now(), rows: null, reason: 'not paired' };
      const [answer] = await peers.fanOutGet(`/api/insights/usage/rows?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`, { timeoutMs: this.#peerTimeout, only: machineId });
      if (!answer) return { at: Date.now(), rows: null, reason: 'not paired' };
      if (answer.reason !== null) return { at: Date.now(), rows: null, reason: answer.reason.startsWith('an older Switchboard') ? 'an older Switchboard (no usage breakdown)' : answer.reason };
      const rows = readUsageRows(answer.body);
      return { at: Date.now(), rows, reason: rows ? null : 'answered something unexpected' };
    })().then(
      (copy) => {
        this.#keepCopy(key, copy);
        this.#peerFetches.delete(key);
        return copy;
      },
      (error: unknown) => {
        this.#peerFetches.delete(key);
        const copy = { at: Date.now(), rows: null, reason: error instanceof Error ? error.message : 'failed' };
        this.#keepCopy(key, copy);
        return copy;
      },
    );
    this.#peerFetches.set(key, fetch);
    return fetch;
  }

  #keepCopy(key: string, copy: PeerCopy): void {
    this.#peerCopies.delete(key);
    this.#peerCopies.set(key, copy);
    while (this.#peerCopies.size > 24) this.#peerCopies.delete(this.#peerCopies.keys().next().value as string);
  }

  async #peerRows(query: UsageQuery, fromIso: string, toIso: string, mode: PeerMode): Promise<{ parts: UsageMachineRows[]; pending: Array<{ id: string; name: string }>; missing: Array<{ id: string; name: string; reason: string }>; stamp: string }> {
    const parts: UsageMachineRows[] = [];
    const pending: Array<{ id: string; name: string }> = [];
    const missing: Array<{ id: string; name: string; reason: string }> = [];
    const stamps: string[] = [];
    if (!this.#peers) return { parts, pending, missing, stamp: '' };
    const machines = await this.#peers.machines();
    await Promise.all(
      machines.map(async (machine) => {
        if (machine.state !== 'online') {
          missing.push({ id: machine.id, name: machine.name, reason: machine.state === 'reconnecting' ? 'reconnecting' : 'offline' });
          return;
        }
        // One copy per machine and period (today: per start of the day); it covers the period's read range.
        const key = `${machine.id}|${query.period}|${query.period === 'today' ? (query.from ?? '') : ''}`;
        let copy = this.#peerCopies.get(key) ?? null;
        const fresh = copy !== null && Date.now() - copy.at < this.#peerTtl;
        if (!fresh) {
          if (mode === 'wait') copy = await this.#fetchPeer(machine.id, key, fromIso, toIso);
          else {
            void this.#fetchPeer(machine.id, key, fromIso, toIso);
            pending.push({ id: machine.id, name: machine.name });
            copy = null;
          }
        }
        if (copy?.rows) {
          parts.push({ machine: { id: machine.id, name: machine.name }, rows: copy.rows });
          stamps.push(`${machine.id}:${copy.at}`);
        } else if (copy) missing.push({ id: machine.id, name: machine.name, reason: copy.reason ?? 'no answer' });
      }),
    );
    parts.sort((a, b) => a.machine.name.localeCompare(b.machine.name));
    return { parts, pending, missing, stamp: JSON.stringify([stamps.sort(), pending, missing]) };
  }

  /** The page's answer: this machine's alone (`local`, also every paired machine's own request) or merged (`all`). */
  async answer(query: UsageQuery, options: { readonly scope?: 'all' | 'local'; readonly peers?: PeerMode } = {}): Promise<UsageAnswer> {
    const now = this.#now();
    const scope = options.scope ?? 'local';
    const range = usageReadRange(query, now);
    const prices = await priceTableOf(this.#store.settings);
    const peers = scope === 'all' ? await this.#peerRows(query, range.from, range.to, options.peers ?? 'cached') : null;
    const key = `${scope}|${usageQueryString(query)}`;
    const progress = this.#backfill.progress();
    const stamp = `${this.#store.insights.revision}|${progress.percent}|${JSON.stringify(prices)}|${peers?.stamp ?? ''}`;
    const cached = this.#cache.get(key);
    if (cached && cached.stamp === stamp && now.getTime() - cached.at < this.#cacheMs) return cached.answer;
    const answer = await this.#build(query, now, range, prices, peers, scope, progress);
    this.#cache.set(key, { at: now.getTime(), stamp, answer });
    if (this.#cache.size > 50) this.#cache.delete(this.#cache.keys().next().value as string);
    return answer;
  }

  async #build(
    query: UsageQuery,
    now: Date,
    range: { readonly from: string; readonly to: string },
    prices: Awaited<ReturnType<typeof priceTableOf>>,
    peers: { parts: UsageMachineRows[]; pending: Array<{ id: string; name: string }>; missing: Array<{ id: string; name: string; reason: string }> } | null,
    scope: 'all' | 'local',
    progress: { readonly done: boolean; readonly percent: number },
  ): Promise<UsageAnswer> {
    const local = await this.rows(range.from, range.to);
    const parts: UsageMachineRows[] = [{ machine: { id: null, name: 'This machine' }, rows: local }, ...(peers?.parts ?? [])];
    const merged = mergeUsageRows(parts);
    const machines: InsightsMachines = { scope, included: parts.map((p) => p.machine), pending: peers?.pending ?? [], missing: peers?.missing ?? [] };
    return buildUsage({ query, now, rows: merged.rows, machineOf: merged.machineOf, folderLabels: merged.folderLabels, prices, machines, backfill: progress });
  }

  /** The whole log of `query` (every page, at most {@link USAGE_CSV_MAX} turns) as CSV. */
  async csv(query: UsageQuery, options: { readonly scope?: 'all' | 'local' } = {}): Promise<string> {
    const answer = await this.answer({ ...query, page: 0, pageSize: USAGE_CSV_MAX }, { scope: options.scope ?? 'local', peers: 'wait' });
    return usageLogCsv(answer.log.rows);
  }
}
