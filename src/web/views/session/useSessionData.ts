import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { SessionDetail, SessionEvent } from '../../../core/api.ts';
import { ApiError, api } from '../../api/client.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { upsertEvent } from './chat.ts';
import { CHAT_EVENTS_PAGE, type LoadState, PlaceholderDelay, inWindow, mergeFetchedEvents, pageCursor, sessionCache, withOlderPage } from './session-loading.ts';

/** The session view's data (D45, `docs/session-panel.md` → *Loading a session*). */
export interface SessionData {
  /** `GET /api/sessions/{id}` of this session: the last load, else the cached one; `null` while it loads or after a failure. */
  readonly detail: SessionDetail | null;
  readonly detailState: LoadState;
  /** The last failed load of the detail (`null` after a success); a 404 means there is no such session. */
  readonly detailError: ApiError | null;
  /** The session's events (`GET /api/sessions/{id}/events` + the `/hub` `event` stream); the chat's conversation. */
  readonly events: readonly SessionEvent[];
  /** `ready` once the list is there (fetched, or cached from an earlier visit in this tab). */
  readonly eventsState: LoadState;
  /** D95: the earlier events not loaded yet (the chat loads its newest page first). */
  readonly older: OlderEvents;
  /** Loads the detail again (a `/hub` event or an action changed the session). */
  readonly reload: () => void;
}

/** D95: the events older than the loaded window (`docs/performance.md` → *Chat window*). */
export interface OlderEvents {
  /** There are older events to load. */
  readonly available: boolean;
  /** A page of them is on its way. */
  readonly loading: boolean;
  /** The last load of them failed (load again to retry). */
  readonly failed: boolean;
  /** Loads the next older page (nothing while one loads or none is left). */
  readonly load: () => void;
}

interface DetailSlot {
  readonly id: string;
  readonly data: SessionDetail | null;
  readonly error: ApiError | null;
}

interface EventsSlot {
  readonly id: string;
  readonly list: readonly SessionEvent[];
  /** D95: the oldest loaded event while older ones exist, `null` once the list reaches the first event. */
  readonly cursor: SessionEvent | null;
  /** The list is there (fetched once, or cached). */
  readonly loaded: boolean;
  readonly failed: boolean;
  /** D95: an older page is on its way / its last load failed. */
  readonly loadingOlder: boolean;
  readonly olderFailed: boolean;
}

const NO_EVENTS: readonly SessionEvent[] = [];

function cachedDetail(id: string): DetailSlot {
  return { id, data: sessionCache.get(id)?.detail ?? null, error: null };
}

function cachedEvents(id: string): EventsSlot {
  const cached = sessionCache.get(id);
  const list = cached?.events ?? null;
  return { id, list: list ?? NO_EVENTS, cursor: list === null ? null : (cached?.cursor ?? null), loaded: list !== null, failed: false, loadingOlder: false, olderFailed: false };
}

function asApiError(caught: unknown): ApiError {
  return caught instanceof ApiError ? caught : new ApiError(0, String(caught));
}

/**
 * D45: the session's detail and events for the session view. Everything is held
 * per session id, so another session's data never shows (the view drops it the
 * moment the id changes); a session opened before in this tab starts from the
 * in-memory cache (`sessionCache`) and refreshes in the background. Every load
 * and every `/hub` update of the shown session is written back to the cache, and
 * `/hub` events of other cached sessions are merged into theirs.
 *
 * The events are fetched only while `wantEvents` (the chat tab is open, as before
 * D45: the other tabs load their own); `/hub` events are applied either way. Events
 * the stream delivers while a fetch runs stay (merged by id).
 *
 * D95 (`docs/performance.md` → *Chat window*): only the newest
 * {@link CHAT_EVENTS_PAGE} events are fetched; `older.load()` adds the page before
 * them (the chat calls it when scrolled to its top). A `/hub` event older than the
 * loaded window is left for its page.
 */
export function useSessionData(sessionId: string, wantEvents: boolean): SessionData {
  const [detailSlot, setDetail] = useState<DetailSlot>(() => cachedDetail(sessionId));
  const [eventsSlot, setEvents] = useState<EventsSlot>(() => cachedEvents(sessionId));
  const eventsRef = useRef(eventsSlot);
  eventsRef.current = eventsSlot.id === sessionId ? eventsSlot : cachedEvents(sessionId);
  const [tick, setTick] = useState(0);
  /** Events streamed for the session while its events fetch runs. */
  const streamed = useRef<{ readonly id: string; readonly list: SessionEvent[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getSession(sessionId).then(
      (data) => {
        if (cancelled) return;
        sessionCache.putDetail(sessionId, data);
        setDetail({ id: sessionId, data, error: null });
      },
      (caught: unknown) => {
        if (cancelled) return;
        const error = asApiError(caught);
        // A session that is gone leaves the cache; any other failure keeps what is shown (a background refresh failed).
        const gone = error.status === 404;
        if (gone) sessionCache.drop(sessionId);
        setDetail((current) => ({ id: sessionId, data: gone ? null : (current.id === sessionId ? current : cachedDetail(sessionId)).data, error }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, tick]);

  useEffect(() => {
    if (!wantEvents) return;
    let cancelled = false;
    const live: SessionEvent[] = [];
    streamed.current = { id: sessionId, list: live };
    const settle = (): void => {
      if (streamed.current?.list === live) streamed.current = null;
    };
    // D95: the newest page only; older pages load when the conversation is scrolled to its top.
    api.sessionEventsPage(sessionId, { limit: CHAT_EVENTS_PAGE }).then(
      (fetched) => {
        if (cancelled) return;
        settle();
        const cursor = pageCursor(fetched, CHAT_EVENTS_PAGE);
        const window = { list: fetched, cursor };
        setEvents({ id: sessionId, list: mergeFetchedEvents(fetched, live.filter((event) => inWindow(window, event))), cursor, loaded: true, failed: false, loadingOlder: false, olderFailed: false });
      },
      () => {
        if (cancelled) return;
        settle();
        setEvents((current) => ({ ...(current.id === sessionId ? current : cachedEvents(sessionId)), failed: true }));
      },
    );
    return () => {
      cancelled = true;
      settle();
    };
  }, [sessionId, wantEvents]);

  useHubEvent('event', (payload) => {
    if (payload.sessionId !== sessionId) {
      sessionCache.applyEvent(payload.sessionId, payload.event);
      return;
    }
    if (streamed.current?.id === sessionId) streamed.current.list.push(payload.event);
    setEvents((current) => {
      const base = current.id === sessionId ? current : cachedEvents(sessionId);
      // D95: an event older than the loaded window belongs to a page not loaded yet (it comes with that page).
      if (!inWindow(base, payload.event)) return base;
      return { ...base, list: upsertEvent(base.list, payload.event) };
    });
  });

  // D95: the next older page, in front of the window.
  const loadingOlder = useRef(false);
  const loadOlder = useCallback(() => {
    const current = eventsRef.current;
    if (current.id !== sessionId || !current.loaded || current.cursor === null || loadingOlder.current) return;
    loadingOlder.current = true;
    const cursor = current.cursor;
    setEvents((slot) => (slot.id === sessionId ? { ...slot, loadingOlder: true, olderFailed: false } : slot));
    api.sessionEventsPage(sessionId, { limit: CHAT_EVENTS_PAGE, before: cursor.id }).then(
      (page) => {
        loadingOlder.current = false;
        setEvents((slot) => {
          if (slot.id !== sessionId || slot.cursor?.id !== cursor.id) return slot.id === sessionId ? { ...slot, loadingOlder: false } : slot;
          const window = withOlderPage(slot, page, CHAT_EVENTS_PAGE);
          return { ...slot, list: window.list, cursor: window.cursor, loadingOlder: false, olderFailed: false };
        });
      },
      () => {
        loadingOlder.current = false;
        setEvents((slot) => (slot.id === sessionId ? { ...slot, loadingOlder: false, olderFailed: true } : slot));
      },
    );
  }, [sessionId]);
  useEffect(() => {
    loadingOlder.current = false;
  }, [sessionId]);

  // The list follows every update into the cache (D95: with its cursor; the cache keeps two pages at most).
  useEffect(() => {
    if (eventsSlot.loaded) sessionCache.putEvents(eventsSlot.id, eventsSlot.list, eventsSlot.cursor);
  }, [eventsSlot]);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  // Slots of another session id never show: the cache (or nothing) stands in until this id's loads land.
  const detail = detailSlot.id === sessionId ? detailSlot : cachedDetail(sessionId);
  const events = eventsSlot.id === sessionId ? eventsSlot : cachedEvents(sessionId);
  return {
    detail: detail.data,
    detailState: detail.data ? 'ready' : detail.error ? 'failed' : 'loading',
    detailError: detail.error,
    events: events.list,
    eventsState: events.loaded ? 'ready' : events.failed ? 'failed' : 'loading',
    older: { available: events.loaded && events.cursor !== null, loading: events.loadingOlder, failed: events.olderFailed, load: loadOlder },
    reload,
  };
}

/**
 * D95: a subagent's own events for its chat (`?agent=`: every event of that agent
 * plus the Agent / Task call that started it), whatever the main chat's window
 * holds, merged with `windowEvents` and kept current from `/hub`. Until they arrive
 * (and when the load fails) the window's events stand in.
 */
export function useAgentEvents(sessionId: string, agentId: string, toolUseId: string | null, windowEvents: readonly SessionEvent[]): readonly SessionEvent[] {
  const key = `${sessionId}\u0000${agentId}`;
  const [slot, setSlot] = useState<{ readonly key: string; readonly list: readonly SessionEvent[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.sessionEventsPage(sessionId, { agent: agentId }).then(
      (list) => {
        if (!cancelled) setSlot((current) => ({ key, list: current?.key === key ? mergeFetchedEvents(list, current.list) : list }));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, agentId, key]);
  useHubEvent('event', (payload) => {
    if (payload.sessionId !== sessionId) return;
    const event = payload.event;
    const call = (event.payload as { type?: unknown; toolUseId?: unknown } | null) ?? null;
    if (event.agentId !== agentId && !(toolUseId !== null && call?.type === 'tool' && call.toolUseId === toolUseId)) return;
    setSlot((current) => ({ key, list: upsertEvent(current?.key === key ? current.list : [], event) }));
  });
  const own = slot?.key === key ? slot.list : null;
  return useMemo(() => (own === null ? windowEvents : mergeFetchedEvents(windowEvents, own)), [own, windowEvents]);
}

const BROWSER_TIMERS = {
  setTimeout: (callback: () => void, ms: number): unknown => window.setTimeout(callback, ms),
  clearTimeout: (handle: unknown): void => window.clearTimeout(handle as number),
};

/**
 * D45: `true` once session `key` has waited ({@link PlaceholderDelay}) for
 * `PLACEHOLDER_DELAY_MS` without its data; `false` again when the wait ends or the
 * session changes.
 */
export function usePlaceholderDelay(key: string, waiting: boolean): boolean {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const delay = useRef<PlaceholderDelay | null>(null);
  delay.current ??= new PlaceholderDelay(BROWSER_TIMERS, rerender);
  const current = delay.current;
  useEffect(() => {
    current.update(key, waiting);
  }, [current, key, waiting]);
  useEffect(() => () => current.dispose(), [current]);
  return waiting && current.due(key);
}
