import type { SessionDetail, SessionEvent } from '../../../core/api.ts';
import { upsertEvent } from './chat.ts';

/**
 * D45 · loading a session (`docs/session-panel.md` → *Loading a session*), kept
 * free of React so it can be unit-tested: the in-memory cache of the sessions
 * opened in this tab, the ~150 ms delay before any placeholder shows, and which
 * parts of the session view are still loading.
 */

/** The placeholders show only when a session's data takes longer than this to arrive (D45: no flicker). */
export const PLACEHOLDER_DELAY_MS = 150;

/** How many sessions the in-memory cache keeps: the most recently loaded ones. */
export const SESSION_CACHE_LIMIT = 20;

/** The visually hidden text of the loading state (read by screen readers while the placeholders show). */
export const LOADING_SESSION = 'Loading session…';

/** What the cache holds for one session; each part `null` until it was loaded. */
export interface CachedSession {
  /** The last loaded `GET /api/sessions/{id}`. */
  readonly detail: SessionDetail | null;
  /** The last complete event list (`GET /api/sessions/{id}/events` + the `/hub` events since). */
  readonly events: readonly SessionEvent[] | null;
}

/**
 * The last loaded detail and events of the sessions opened in this tab (D45:
 * *instant revisit*), in memory only, for the page's life. It keeps at most
 * `limit` sessions: storing one makes it the most recent, and the least recently
 * stored one goes first. Reading does not reorder.
 */
export class SessionCache {
  readonly #limit: number;
  readonly #entries = new Map<string, CachedSession>();

  constructor(limit: number = SESSION_CACHE_LIMIT) {
    this.#limit = Math.max(1, limit);
  }

  /** The cached parts of session `id`, `null` when nothing of it is cached. */
  get(id: string): CachedSession | null {
    return this.#entries.get(id) ?? null;
  }

  /** Stores the session's detail (a load succeeded). */
  putDetail(id: string, detail: SessionDetail): void {
    this.#put(id, { detail, events: this.#entries.get(id)?.events ?? null });
  }

  /** Stores the session's complete event list. */
  putEvents(id: string, events: readonly SessionEvent[]): void {
    this.#put(id, { detail: this.#entries.get(id)?.detail ?? null, events });
  }

  /**
   * A `/hub` `event` of a session not on screen: merged (by id) into its cached
   * events, so a revisit starts from the current conversation. Nothing happens when
   * its events are not cached (a partial list would pass for a complete one). Does
   * not reorder.
   */
  applyEvent(id: string, event: SessionEvent): void {
    const entry = this.#entries.get(id);
    if (!entry?.events) return;
    this.#entries.set(id, { ...entry, events: upsertEvent(entry.events, event) });
  }

  /** Forgets session `id` (e.g. the service answered 404 for it). */
  drop(id: string): void {
    this.#entries.delete(id);
  }

  /** How many sessions are cached. */
  get size(): number {
    return this.#entries.size;
  }

  /** The cached session ids, least recently stored first. */
  ids(): string[] {
    return [...this.#entries.keys()];
  }

  #put(id: string, entry: CachedSession): void {
    this.#entries.delete(id);
    this.#entries.set(id, entry);
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.#limit) break;
      this.#entries.delete(oldest);
    }
  }
}

/** The page's cache (one per browser tab). */
export const sessionCache = new SessionCache();

/**
 * The event list after a fetch: the fetched events, with the events the `/hub`
 * stream delivered while the fetch ran merged in by id (they are at least as new).
 * Events that were on screen before the fetch (a cached list) are replaced by the
 * fetched ones.
 */
export function mergeFetchedEvents(fetched: readonly SessionEvent[], streamed: readonly SessionEvent[]): SessionEvent[] {
  return streamed.reduce(upsertEvent, [...fetched]);
}

/** Where one part of a session's data stands. */
export type LoadState = 'ready' | 'loading' | 'failed';

/** Which parts of the session view wait for their data. */
export interface LoadingParts {
  /** The header (title, root line): the detail is not there yet. */
  readonly header: boolean;
  /** The chat tab's conversation: the detail or the events are not there yet. */
  readonly chat: boolean;
  /** The right panel: the detail is not there yet. */
  readonly panel: boolean;
}

/** No part waits. */
export const NOTHING_LOADING: LoadingParts = { header: false, chat: false, panel: false };

/**
 * The parts that wait, from where the detail and the events stand. `chatShown`:
 * the chat tab is the open tab (the other tabs load their own data). A failed
 * load waits no more (the view shows its error / missing state, never a stuck
 * placeholder).
 */
export function loadingParts(detail: LoadState, events: LoadState, chatShown: boolean): LoadingParts {
  const header = detail === 'loading';
  const chat = chatShown && detail !== 'failed' && events !== 'failed' && (detail === 'loading' || events === 'loading');
  return { header, chat, panel: header };
}

/** `true` while any part waits (the view is `aria-busy`). */
export function anyLoading(parts: LoadingParts): boolean {
  return parts.header || parts.chat || parts.panel;
}

/** Timer functions, injected so tests drive the time. */
export interface Timers {
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

/**
 * The D45 delay (no flicker): a wait shows placeholders only once it lasted
 * {@link PLACEHOLDER_DELAY_MS}. Call {@link PlaceholderDelay.update} with the
 * shown session and whether it waits whenever either changes; `onDue` runs once
 * the delay passed (re-render then). A new session, or the end of a wait, starts
 * over: the next wait gets its own delay.
 */
export class PlaceholderDelay {
  readonly #timers: Timers;
  readonly #onDue: () => void;
  readonly #delayMs: number;
  #key: string | null = null;
  #handle: unknown = null;
  #due = false;

  constructor(timers: Timers, onDue: () => void, delayMs: number = PLACEHOLDER_DELAY_MS) {
    this.#timers = timers;
    this.#onDue = onDue;
    this.#delayMs = delayMs;
  }

  /** Session `key` is shown and waits (`waiting`) or not. */
  update(key: string, waiting: boolean): void {
    if (key !== this.#key) {
      this.#cancel();
      this.#key = key;
      this.#due = false;
    }
    if (!waiting) {
      this.#cancel();
      this.#due = false;
      return;
    }
    if (this.#due || this.#handle !== null) return;
    this.#handle = this.#timers.setTimeout(() => {
      this.#handle = null;
      this.#due = true;
      this.#onDue();
    }, this.#delayMs);
  }

  /** `true` once session `key`'s current wait lasted the delay. */
  due(key: string): boolean {
    return this.#key === key && this.#due;
  }

  /** Drops a pending timer (the view unmounts). */
  dispose(): void {
    this.#cancel();
  }

  #cancel(): void {
    if (this.#handle === null) return;
    this.#timers.clearTimeout(this.#handle);
    this.#handle = null;
  }
}
