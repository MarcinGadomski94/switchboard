import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { SessionDetail, SessionEvent } from '../../../core/api.ts';
import { ApiError, api } from '../../api/client.ts';
import { SingleFlight } from '../../api/single-flight.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { upsertEvent } from './chat.ts';
import { CHAT_EVENTS_PAGE, type LoadState, PlaceholderDelay, aroundWindow, byTime, inWindow, mergeFetchedEvents, pageCursor, sessionCache, withNewerPage, withOlderPage } from './session-loading.ts';

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
  /** D97: the later events not loaded yet (a chat opened at a search result away from its end). */
  readonly newer: NewerEvents;
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

/** D97: the events newer than the loaded window (`docs/search.md` → *Opening a result*). */
export interface NewerEvents {
  /** There are newer events to load (the window was opened around an older event). */
  readonly available: boolean;
  readonly loading: boolean;
  readonly failed: boolean;
  /** Loads the next newer page (nothing while one loads or none is left). */
  readonly load: () => void;
  /** Drops the window and loads the newest page (the chat's end), as when the session opens. */
  readonly latest: () => void;
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
  /** D97: the newest loaded event while newer ones exist (opened around an event), `null` when the list reaches the end. */
  readonly newer: SessionEvent | null;
  readonly loadingNewer: boolean;
  readonly newerFailed: boolean;
}

const NO_EVENTS: readonly SessionEvent[] = [];

function cachedDetail(id: string): DetailSlot {
  return { id, data: sessionCache.get(id)?.detail ?? null, error: null };
}

function cachedEvents(id: string): EventsSlot {
  const cached = sessionCache.get(id);
  const list = cached?.events ?? null;
  return { id, list: list ?? NO_EVENTS, cursor: list === null ? null : (cached?.cursor ?? null), loaded: list !== null, failed: false, loadingOlder: false, olderFailed: false, newer: null, loadingNewer: false, newerFailed: false };
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
export function useSessionData(sessionId: string, wantEvents: boolean, focusEventId: number | null = null): SessionData {
  const [detailSlot, setDetail] = useState<DetailSlot>(() => cachedDetail(sessionId));
  const [eventsSlot, setEvents] = useState<EventsSlot>(() => cachedEvents(sessionId));
  // D97: the event the chat opens at, when the window does not hold it: the events load around it.
  const [around, setAround] = useState<{ readonly id: string; readonly eventId: number } | null>(() =>
    focusEventId !== null && !cachedEvents(sessionId).list.some((event) => event.id === focusEventId) ? { id: sessionId, eventId: focusEventId } : null,
  );
  const [eventsTick, setEventsTick] = useState(0);
  /** D97: `/hub` events newer than a window opened around an older event (added once the window reaches the end). */
  const held = useRef<{ readonly id: string; readonly list: SessionEvent[] }>({ id: sessionId, list: [] });
  const eventsRef = useRef(eventsSlot);
  eventsRef.current = eventsSlot.id === sessionId ? eventsSlot : cachedEvents(sessionId);
  const [tick, setTick] = useState(0);
  /** Events streamed for the session while its events fetch runs. */
  const streamed = useRef<{ readonly id: string; readonly list: SessionEvent[] } | null>(null);

  // D144: one detail load at a time per session, never dropped for a newer one: a reload asked while it is on its
  // way runs once after it (a slow detail on a busy agent used to be restarted by every event and never land).
  const detailLoads = useRef<{ readonly id: string; readonly flight: SingleFlight } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const flight = new SingleFlight(() =>
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
      ),
    );
    detailLoads.current = { id: sessionId, flight };
    flight.run();
    return () => {
      cancelled = true;
      flight.close();
      if (detailLoads.current?.flight === flight) detailLoads.current = null;
    };
  }, [sessionId]);
  const seenTick = useRef(tick);
  useEffect(() => {
    if (tick === seenTick.current) return;
    seenTick.current = tick;
    const loads = detailLoads.current;
    if (loads?.id === sessionId) loads.flight.run();
  }, [sessionId, tick]);

  // D97: a result of a search opened while the session is on screen: around it, unless the window holds it.
  useEffect(() => {
    if (focusEventId === null) return;
    const current = eventsRef.current;
    if (current.loaded && current.list.some((event) => event.id === focusEventId)) return;
    setAround({ id: sessionId, eventId: focusEventId });
  }, [sessionId, focusEventId]);
  const aroundId = around?.id === sessionId ? around.eventId : null;

  useEffect(() => {
    if (!wantEvents) return;
    let cancelled = false;
    const live: SessionEvent[] = [];
    held.current = { id: sessionId, list: [] };
    streamed.current = { id: sessionId, list: live };
    const settle = (): void => {
      if (streamed.current?.list === live) streamed.current = null;
    };
    // D95: the newest page only; older pages load when the conversation is scrolled to its top.
    // D97: or the page around the event the chat opens at (a search result), newer pages loading when scrolled to its end.
    api.sessionEventsPage(sessionId, aroundId === null ? { limit: CHAT_EVENTS_PAGE } : { limit: CHAT_EVENTS_PAGE, around: aroundId }).then(
      (fetched) => {
        if (cancelled) return;
        settle();
        const window = aroundId === null ? { list: fetched, cursor: pageCursor(fetched, CHAT_EVENTS_PAGE), newer: null } : aroundWindow(fetched, aroundId, CHAT_EVENTS_PAGE);
        const fits = live.filter((event) => inWindow(window, event));
        if (window.newer !== null) held.current.list.push(...live.filter((event) => !fits.includes(event)));
        setEvents({ id: sessionId, list: mergeFetchedEvents(window.list, fits), cursor: window.cursor, loaded: true, failed: false, loadingOlder: false, olderFailed: false, newer: window.newer, loadingNewer: false, newerFailed: false });
      },
      () => {
        if (cancelled) return;
        settle();
        // D97: an event that is not there (deleted, a bad address) or a machine that refuses `around`: the newest page instead.
        if (aroundId !== null) {
          setAround(null);
          return;
        }
        setEvents((current) => ({ ...(current.id === sessionId ? current : cachedEvents(sessionId)), failed: true }));
      },
    );
    return () => {
      cancelled = true;
      settle();
    };
  }, [sessionId, wantEvents, aroundId, eventsTick]);

  useHubEvent('event', (payload) => {
    if (payload.sessionId !== sessionId) {
      sessionCache.applyEvent(payload.sessionId, payload.event);
      return;
    }
    if (streamed.current?.id === sessionId) streamed.current.list.push(payload.event);
    setEvents((current) => {
      const base = current.id === sessionId ? current : cachedEvents(sessionId);
      // D95: an event older than the loaded window belongs to a page not loaded yet (it comes with that page).
      // D97: one newer than a window opened around an older event waits until the window reaches the end.
      if (!inWindow(base, payload.event)) {
        if (base.newer !== null && byTime(payload.event, base.newer) > 0) {
          if (held.current.id !== sessionId) held.current = { id: sessionId, list: [] };
          held.current.list.push(payload.event);
        }
        return base;
      }
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
    loadingNewer.current = false;
  }, [sessionId]);

  // D97: the next newer page, after the window (it was opened around an older event); the last one brings the held `/hub` events.
  const loadingNewer = useRef(false);
  const loadNewer = useCallback(() => {
    const current = eventsRef.current;
    if (current.id !== sessionId || !current.loaded || current.newer === null || loadingNewer.current) return;
    loadingNewer.current = true;
    const newer = current.newer;
    setEvents((slot) => (slot.id === sessionId ? { ...slot, loadingNewer: true, newerFailed: false } : slot));
    api.sessionEventsPage(sessionId, { limit: CHAT_EVENTS_PAGE, after: newer.id }).then(
      (page) => {
        loadingNewer.current = false;
        setEvents((slot) => {
          if (slot.id !== sessionId || slot.newer?.id !== newer.id) return slot.id === sessionId ? { ...slot, loadingNewer: false } : slot;
          const heldEvents = held.current.id === sessionId ? held.current.list : [];
          const window = withNewerPage(slot, page, CHAT_EVENTS_PAGE, heldEvents);
          if (window.newer === null) held.current = { id: sessionId, list: [] };
          return { ...slot, list: window.list, newer: window.newer, loadingNewer: false, newerFailed: false };
        });
      },
      () => {
        loadingNewer.current = false;
        setEvents((slot) => (slot.id === sessionId ? { ...slot, loadingNewer: false, newerFailed: true } : slot));
      },
    );
  }, [sessionId]);
  // D97: back to the chat's end: the newest page, as when the session opens.
  const loadLatest = useCallback(() => {
    setAround(null);
    setEventsTick((n) => n + 1);
  }, []);

  // The list follows every update into the cache (D95: with its cursor; the cache keeps two pages at most).
  // D97: not a window opened around an older event (it does not reach the end: the cache's revisit would miss the newest).
  useEffect(() => {
    if (eventsSlot.loaded && eventsSlot.newer === null) sessionCache.putEvents(eventsSlot.id, eventsSlot.list, eventsSlot.cursor);
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
    newer: { available: events.loaded && events.newer !== null, loading: events.loadingNewer, failed: events.newerFailed, load: loadNewer, latest: loadLatest },
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
