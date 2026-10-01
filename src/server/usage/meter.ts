import { randomUUID } from 'node:crypto';
import type { UsageWarning } from '../../core/api.ts';
import type { ControlRequestLine } from '../../core/stdin.ts';
import type { ControlResponseMessage } from '../../core/stream-json.ts';
import {
  LIVE_USAGE_INTERVAL_MS,
  MODEL_WINDOW_MAX_AGE_MS,
  type ModelWindowReading,
  POLLER_USAGE_INTERVAL_MS,
  type ParsedUsage,
  type SystemUsageFields,
  type UsageState,
  WARN_AT_PCT_SETTING,
  type WarnedState,
  activeWarnings,
  dueWarnings,
  getUsageLine,
  modelWindowsFromGetUsage,
  readWarnedState,
  readingFromGetUsage,
  systemUsageFields,
  usageState,
  usageWindows,
  warnThreshold,
} from '../../core/usage.ts';
import type { Store } from '../db/store.ts';
import type { UsageFetcher } from './poller.ts';

/** Settings key of the fired warnings (internal state, not a user preference; `docs/usage.md`). */
export const WARNED_SETTING = 'usage.warned';

/** How often the meter checks whether a reading is due (the limits below decide whether one is taken). */
export const DEFAULT_TICK_MS = 15_000;

/** How long a live session may take to answer `get_usage`. */
export const DEFAULT_LIVE_REQUEST_TIMEOUT_MS = 15_000;

/** Readings older than this are deleted (only the newest one drives the meter; a 5-hour window is long over by then). */
export const READING_RETENTION_MS = 24 * 60 * 60_000;

/** How often old readings are pruned. */
const PRUNE_EVERY_MS = 60 * 60_000;

/** What the meter needs from the supervisor (M2.1): the live sessions and a stdin control request between turns. */
export interface UsageSessions {
  /** Live supervised processes. */
  readonly liveCount: number;
  /** D63: the live Claude Code sessions with the profile each runs on and whether it is between turns (per-profile readings). */
  liveClaudeSessions?(): ReadonlyArray<{ readonly id: string; readonly profileId: string; readonly idle: boolean }>;
  /** Live sessions between turns (where `get_usage` may go). */
  idleLiveSessionIds(): string[];
  /** One stdin control request → its `control_response`, `null` when none came. */
  controlRequest(sessionId: string, line: ControlRequestLine, timeoutMs: number): Promise<ControlResponseMessage | null>;
}

/**
 * D63: the Claude Code account profiles the meter reads (`docs/accounts.md` →
 * *Usage per profile*): each enabled profile gets its own readings (a live
 * session of it between turns, else a poller with its `CLAUDE_CONFIG_DIR`).
 */
export interface UsageProfiles {
  /** The enabled Claude Code profile ids, in priority order. */
  claudeProfiles(): Promise<readonly string[]>;
  /** A poller for a profile (`null` = the base poller, the Default's). */
  pollerFor(profileId: string): UsageFetcher | null;
  /** The profile the main footer bars show: the one a new session would start on. */
  active(): Promise<string>;
}

/** Options for {@link UsageMeter}. */
export interface UsageMeterOptions {
  /** D63: per-profile readings; without it the meter reads one account, as before 0024. */
  readonly profiles?: UsageProfiles;
  readonly store: Store;
  readonly sessions: UsageSessions;
  /** The short-lived poller (`UsagePoller`) used while no session is live. */
  readonly poller: UsageFetcher;
  /** Connected `/hub` clients (`SseHub.clientCount`); can be set later with {@link UsageMeter.watchViewers}. Default: none. */
  readonly viewers?: () => number;
  /** Clock (tests pass a fake one). */
  readonly now?: () => Date;
  /** At most one live `get_usage` per this many ms (default 60 s). */
  readonly liveIntervalMs?: number;
  /** At most one poller run per this many ms (default 5 min). */
  readonly pollerIntervalMs?: number;
  /** Gap between {@link UsageMeter.tick}s once {@link UsageMeter.start}ed (default 15 s). */
  readonly tickMs?: number;
  /** Live `get_usage` answer limit (default 15 s). */
  readonly liveRequestTimeoutMs?: number;
  /** A warning fired (once per window until it resets). */
  readonly onWarning?: (warning: UsageWarning) => void;
  /** A tick failed (default: `console.error`). */
  readonly onError?: (error: unknown) => void;
}

/** What one {@link UsageMeter.tick} did. */
export type UsageTick = 'live' | 'poller' | null;

/**
 * The Max usage meter (M9.2, `docs/usage.md`). Readings go to `usage_readings`:
 * - `get_usage` over the stdin of a live session between turns, at most once per
 *   60 s (the CLI caches it for about a minute);
 * - every `rate_limit_event` (stored by the recorder, M2.1: free, no request);
 * - while no session is live, a short-lived poller at most once per 5 min, and
 *   not while a reading younger than that exists.
 * Requests are only made while a `/hub` client is connected (someone sees the
 * meter). The newest reading drives `usagePct` and the Session / Week windows
 * (src/core/usage.ts); D17: the model-scoped windows come from the newest
 * `get_usage` reading while it is at most {@link MODEL_WINDOW_MAX_AGE_MS} old (a
 * `rate_limit_event` carries none). Every evaluation also fires the due warnings
 * (once per window until its reset), remembered in the settings table so a
 * restart does not repeat them.
 */
export class UsageMeter {
  readonly #store: Store;
  readonly #sessions: UsageSessions;
  readonly #poller: UsageFetcher;
  readonly #now: () => Date;
  readonly #liveIntervalMs: number;
  readonly #pollerIntervalMs: number;
  readonly #tickMs: number;
  readonly #liveTimeoutMs: number;
  readonly #onWarning: (warning: UsageWarning) => void;
  readonly #onError: (error: unknown) => void;
  #viewers: () => number;
  readonly #profiles: UsageProfiles | null;
  #lastLiveAt = Number.NEGATIVE_INFINITY;
  #lastPollAt = Number.NEGATIVE_INFINITY;
  /** D63: per profile, the last live request / poller run. */
  readonly #profileLive = new Map<string, number>();
  readonly #profilePoll = new Map<string, number>();
  #lastPruneAt = Number.NEGATIVE_INFINITY;
  #timer: NodeJS.Timeout | undefined;
  #ticking: Promise<UsageTick> | null = null;
  /** Serializes warning evaluations (a tick and a `/api/system` call must not both fire one). */
  #evaluating: Promise<unknown> = Promise.resolve();

  constructor(options: UsageMeterOptions) {
    this.#store = options.store;
    this.#sessions = options.sessions;
    this.#poller = options.poller;
    this.#now = options.now ?? (() => new Date());
    this.#liveIntervalMs = options.liveIntervalMs ?? LIVE_USAGE_INTERVAL_MS;
    this.#pollerIntervalMs = options.pollerIntervalMs ?? POLLER_USAGE_INTERVAL_MS;
    this.#tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.#liveTimeoutMs = options.liveRequestTimeoutMs ?? DEFAULT_LIVE_REQUEST_TIMEOUT_MS;
    this.#onWarning = options.onWarning ?? (() => undefined);
    this.#onError = options.onError ?? ((error) => console.error('switchboard usage:', error));
    this.#viewers = options.viewers ?? (() => 0);
    this.#profiles = options.profiles ?? null;
  }

  /** Sets where the number of connected `/hub` clients comes from (buildApp: `SseHub.clientCount`). */
  watchViewers(count: () => number): void {
    this.#viewers = count;
  }

  /** Ticks now and then every `tickMs` until {@link stop}. */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.#safeTick(), this.#tickMs);
    this.#timer.unref();
    void this.#safeTick();
  }

  /** Stops ticking; resolves once a running tick (a live request or a poller run) has finished. */
  async stop(): Promise<void> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#ticking?.catch(() => undefined);
  }

  /**
   * One step: fire due warnings, prune old readings, then take at most one
   * reading if one is due. With a viewer: a live session between turns when one
   * is live (≤ 1 per `liveIntervalMs`), else the poller (≤ 1 per
   * `pollerIntervalMs`, and only when the newest reading is older than that).
   * Returns what it read. Overlapping calls share the running tick.
   */
  tick(): Promise<UsageTick> {
    if (!this.#ticking) {
      this.#ticking = this.#tick().finally(() => {
        this.#ticking = null;
      });
    }
    return this.#ticking;
  }

  /** The meter now, from the newest reading. */
  async state(): Promise<UsageState> {
    return usageState(await this.#store.usage.latest(undefined, await this.#active()), this.#now());
  }

  /** D63: the profile whose readings drive the bars (`undefined` = any, the single-account meter). */
  async #active(): Promise<string | undefined> {
    return this.#profiles ? this.#profiles.active() : undefined;
  }

  /** The usage fields of `GET /api/system` / the `system` event (fires due warnings first). */
  async systemFields(): Promise<SystemUsageFields> {
    const now = this.#now();
    const warned = await this.#evaluate(now);
    const latest = await this.#store.usage.latest(undefined, await this.#active());
    return systemUsageFields(usageState(latest, now), activeWarnings(warned, now), usageWindows(latest, await this.#modelWindows(now), now));
  }

  /**
   * D17: the model-scoped weekly limits of the newest `get_usage` reading (a
   * `rate_limit_event` has none, so a newer one does not hide them). A reading
   * older than {@link MODEL_WINDOW_MAX_AGE_MS} is kept and marked with its time
   * (`asOf`, shown as "as of <age>"; developer ruling 2026-09-28); a window whose
   * reset has passed is dropped as before (`usageWindows`).
   */
  async #modelWindows(now: Date): Promise<ModelWindowReading[]> {
    const reading = await this.#store.usage.latest('get_usage', await this.#active());
    if (!reading) return [];
    const age = now.getTime() - Date.parse(reading.receivedAt);
    const windows = modelWindowsFromGetUsage(reading.raw);
    return age <= MODEL_WINDOW_MAX_AGE_MS ? windows : windows.map((w) => ({ ...w, asOf: reading.receivedAt }));
  }

  /** Stores a reading taken now (`get_usage` from a live session or the poller). */
  async record(reading: ParsedUsage, sessionId: string | null, profileId?: string): Promise<void> {
    await this.#store.usage.add({
      ...(profileId !== undefined ? { profileId } : {}),
      receivedAt: this.#now().toISOString(),
      source: reading.source,
      sessionId,
      fiveHourPct: reading.fiveHourPct,
      fiveHourResetsAt: reading.fiveHourResetsAt,
      sevenDayPct: reading.sevenDayPct,
      sevenDayResetsAt: reading.sevenDayResetsAt,
      raw: reading.raw,
    });
    await this.#evaluate(this.#now());
  }

  async #safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      this.#onError(error);
    }
  }

  async #tick(): Promise<UsageTick> {
    const now = this.#now().getTime();
    await this.#evaluate(new Date(now));
    await this.#prune(now);
    if (this.#viewers() <= 0) return null;
    if (this.#profiles) return this.#profileTick(now);
    if (this.#sessions.liveCount > 0) {
      if (now - this.#lastLiveAt < this.#liveIntervalMs) return null;
      // Every live session is mid-turn: its turns bring rate_limit_events instead.
      const [sessionId] = this.#sessions.idleLiveSessionIds();
      if (!sessionId) return null;
      this.#lastLiveAt = now;
      const response = await this.#sessions.controlRequest(sessionId, getUsageLine(`sb-usage-${randomUUID()}`), this.#liveTimeoutMs);
      const reading = readingFromGetUsage(response ? { kind: 'response', message: response } : { kind: 'failed', error: 'no get_usage answer from the live session' });
      await this.record(reading, sessionId);
      return 'live';
    }
    if (now - this.#lastPollAt < this.#pollerIntervalMs) return null;
    const latest = await this.#store.usage.latest();
    if (latest && now - Date.parse(latest.receivedAt) < this.#pollerIntervalMs) return null;
    this.#lastPollAt = now;
    await this.record(readingFromGetUsage(await this.#poller.getUsage()), null);
    return 'poller';
  }

  /**
   * D63: one reading per tick at most, for the first enabled Claude Code profile
   * that is due: a live session of it between turns (at most one request per
   * `liveIntervalMs`), else, while none of its sessions is live and its newest
   * reading is older than `pollerIntervalMs`, a poller with its folder.
   */
  async #profileTick(now: number): Promise<UsageTick> {
    const profiles = this.#profiles as UsageProfiles;
    const live = this.#sessions.liveClaudeSessions?.() ?? [];
    for (const profileId of await profiles.claudeProfiles()) {
      const mine = live.filter((s) => s.profileId === profileId);
      if (mine.length > 0) {
        const idle = mine.find((s) => s.idle);
        // Mid-turn sessions bring rate_limit_events; no request goes to them.
        if (!idle || now - (this.#profileLive.get(profileId) ?? Number.NEGATIVE_INFINITY) < this.#liveIntervalMs) continue;
        this.#profileLive.set(profileId, now);
        const response = await this.#sessions.controlRequest(idle.id, getUsageLine(`sb-usage-${randomUUID()}`), this.#liveTimeoutMs);
        await this.record(readingFromGetUsage(response ? { kind: 'response', message: response } : { kind: 'failed', error: 'no get_usage answer from the live session' }), idle.id, profileId);
        return 'live';
      }
      if (now - (this.#profilePoll.get(profileId) ?? Number.NEGATIVE_INFINITY) < this.#pollerIntervalMs) continue;
      const latest = await this.#store.usage.latest(undefined, profileId);
      if (latest && now - Date.parse(latest.receivedAt) < this.#pollerIntervalMs) continue;
      const poller = profiles.pollerFor(profileId);
      if (!poller) continue;
      this.#profilePoll.set(profileId, now);
      await this.record(readingFromGetUsage(await poller.getUsage()), null, profileId);
      return 'poller';
    }
    return null;
  }

  /** Fires the due warnings and stores the warned state; returns it. */
  #evaluate(now: Date): Promise<WarnedState> {
    const run = this.#evaluating.then(async () => {
      const stored = await this.#store.settings.get(WARNED_SETTING);
      const warned = readWarnedState(stored);
      const threshold = warnThreshold(await this.#store.settings.get(WARN_AT_PCT_SETTING));
      const result = dueWarnings(await this.#store.usage.latest(undefined, await this.#active()), warned, threshold, now, await this.#modelWindows(now));
      if (JSON.stringify(result.warned) !== JSON.stringify(stored ?? {})) await this.#store.settings.set(WARNED_SETTING, result.warned);
      for (const warning of result.fire) {
        try {
          this.#onWarning(warning);
        } catch (error) {
          this.#onError(error);
        }
      }
      return result.warned;
    });
    this.#evaluating = run.catch(() => undefined);
    return run;
  }

  async #prune(now: number): Promise<void> {
    if (now - this.#lastPruneAt < PRUNE_EVERY_MS) return;
    this.#lastPruneAt = now;
    await this.#store.usage.prune(new Date(now - READING_RETENTION_MS).toISOString());
  }
}
