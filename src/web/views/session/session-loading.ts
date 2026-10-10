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

/**
 * D95 (`docs/performance.md` → *Chat window*): how many events the chat loads at
 * once: the newest page when a session opens, then one page more each time the
 * conversation is scrolled to its top.
 */
export const CHAT_EVENTS_PAGE = 1000;

/**
 * D95: at most this many events stay cached across all sessions not on screen; past
 * it, the least recently stored sessions lose their events (their detail stays) and
 * load them again on the next visit.
 */
export const CACHE_EVENT_BUDGET = 6000;

/** The visually hidden text of the loading state (read by screen readers while the placeholders show). */
export const LOADING_SESSION = 'Loading session…';

/** What the cache holds for one session; each part `null` until it was loaded. */
export interface CachedSession {
  /** The last loaded `GET /api/sessions/{id}`. */
  readonly detail: SessionDetail | null;
  /** The last loaded event window (`GET /api/sessions/{id}/events` pages + the `/hub` events since). */
  readonly events: readonly SessionEvent[] | null;
  /** D95: the oldest event of the window when older ones were not loaded ({@link EventWindow.cursor}); `null` = complete. */
  readonly cursor: SessionEvent | null;
}

/** Events in time order: `ts`, then id (the chat's order). */
export function byTime(a: Pick<SessionEvent, 'ts' | 'id'>, b: Pick<SessionEvent, 'ts' | 'id'>): number {
  return a.ts === b.ts ? a.id - b.id : a.ts < b.ts ? -1 : 1;
}

/**
 * D95: the events of a session the chat has loaded: its newest pages. `cursor` is
 * the oldest loaded event while older ones exist (more can be loaded `before` it),
 * `null` once the list reaches the session's first event.
 */
export interface EventWindow {
  readonly list: readonly SessionEvent[];
  readonly cursor: SessionEvent | null;
}

/** The oldest of `events` in time order, `null` for none. */
function oldest(events: readonly SessionEvent[]): SessionEvent | null {
  let first: SessionEvent | null = null;
  for (const event of events) if (first === null || byTime(event, first) < 0) first = event;
  return first;
}

/**
 * D95: the cursor after a page of `limit` arrived: its oldest event when the page
 * was full (there may be older ones), else `null` (it reached the first event). A
 * machine without paging answers every event: more than `limit`, complete.
 */
export function pageCursor(page: readonly SessionEvent[], limit: number): SessionEvent | null {
  return page.length === limit ? oldest(page) : null;
}

/** D95: `true` when `event` belongs in the window: it is complete, the event is already in it, or it is not older than the cursor. */
export function inWindow(window: EventWindow, event: SessionEvent): boolean {
  if (window.cursor === null) return true;
  if (byTime(event, window.cursor) >= 0) return true;
  return window.list.some((e) => e.id === event.id);
}

/** D95: the window with an older page (`limit` asked) added in front; events already in it stay as they are. */
export function withOlderPage(window: EventWindow, page: readonly SessionEvent[], limit: number): EventWindow {
  const known = new Set(window.list.map((event) => event.id));
  const added = page.filter((event) => !known.has(event.id));
  // A machine without paging answers everything again: nothing new means nothing older is left.
  const cursor = added.length === 0 ? null : pageCursor(page, limit);
  return { list: [...added, ...window.list], cursor };
}

/**
 * D95: the window cut to its newest `keep` events (in time order) when it holds more
 * than `max`; the cut leaves a cursor at its new oldest event. Returns `window` itself
 * when nothing is cut.
 */
export function trimWindow(window: EventWindow, keep: number, max: number): EventWindow {
  if (window.list.length <= max) return window;
  const sorted = [...window.list].sort(byTime);
  const list = sorted.slice(sorted.length - keep);
  return { list, cursor: list[0] ?? null };
}

/**
 * The last loaded detail and events of the sessions opened in this tab (D45:
 * *instant revisit*), in memory only, for the page's life. It keeps at most
 * `limit` sessions: storing one makes it the most recent, and the least recently
 * stored one goes first. Reading does not reorder.
 */
export class SessionCache {
  readonly #limit: number;
  readonly #eventBudget: number;
  readonly #entries = new Map<string, CachedSession>();

  /** D95: `eventBudget` = {@link CACHE_EVENT_BUDGET}; each session keeps at most {@link CHAT_EVENTS_PAGE} × 2 events here. */
  constructor(limit: number = SESSION_CACHE_LIMIT, eventBudget: number = CACHE_EVENT_BUDGET) {
    this.#limit = Math.max(1, limit);
    this.#eventBudget = Math.max(0, eventBudget);
  }

  /** The cached parts of session `id`, `null` when nothing of it is cached. */
  get(id: string): CachedSession | null {
    return this.#entries.get(id) ?? null;
  }

  /** Stores the session's detail (a load succeeded). */
  putDetail(id: string, detail: SessionDetail): void {
    const entry = this.#entries.get(id);
    this.#put(id, { detail, events: entry?.events ?? null, cursor: entry?.cursor ?? null });
  }

  /**
   * Stores the session's event window (`cursor` = its oldest event while older ones
   * were not loaded, D95). A window grown past two pages by scrolling up is cut to
   * the newest page ({@link trimWindow}).
   */
  putEvents(id: string, events: readonly SessionEvent[], cursor: SessionEvent | null = null): void {
    const window = trimWindow({ list: events, cursor }, CHAT_EVENTS_PAGE, CHAT_EVENTS_PAGE * 2);
    this.#put(id, { detail: this.#entries.get(id)?.detail ?? null, events: window.list, cursor: window.cursor });
    this.#spend(id);
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
    // D95: an event older than the cached window belongs to a page not loaded.
    if (!inWindow({ list: entry.events, cursor: entry.cursor }, event)) return;
    this.#entries.set(id, { ...entry, events: upsertEvent(entry.events, event) });
  }

  /** D95: how many events are cached, all sessions together. */
  get eventCount(): number {
    let count = 0;
    for (const entry of this.#entries.values()) count += entry.events?.length ?? 0;
    return count;
  }

  /** D95: while the cache holds more events than its budget, the least recently stored sessions (not `keep`) lose theirs. */
  #spend(keep: string): void {
    let total = this.eventCount;
    for (const [id, entry] of this.#entries) {
      if (total <= this.#eventBudget) break;
      if (id === keep || !entry.events) continue;
      total -= entry.events.length;
      this.#entries.set(id, { ...entry, events: null, cursor: null });
    }
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
