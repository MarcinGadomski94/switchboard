import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { SessionDetail, SessionEvent } from '../../../core/api.ts';
import { ApiError, api } from '../../api/client.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { upsertEvent } from './chat.ts';
import { type LoadState, PlaceholderDelay, mergeFetchedEvents, sessionCache } from './session-loading.ts';

/** The session view's data (D45, `docs/session-panel.md` → *Loading a session*). */
export interface SessionData {
  /** `GET /api/sessions/{id}` of this session: the last load, else the cached one; `null` while it loads or after a failure. */
  readonly detail: SessionDetail | null;
  readonly detailState: LoadState;
  /** The last failed load of the detail (`null` after a success); a 404 means there is no such session. */
  readonly detailError: ApiError | null;
  /** The session's events (`GET /api/sessions/{id}/events` + the `/hub` `event` stream); the chat's conversation. */
  readonly events: readonly SessionEvent[];
  /** `ready` once the complete list is there (fetched, or cached from an earlier visit in this tab). */
  readonly eventsState: LoadState;
  /** Loads the detail again (a `/hub` event or an action changed the session). */
  readonly reload: () => void;
}

interface DetailSlot {
  readonly id: string;
  readonly data: SessionDetail | null;
  readonly error: ApiError | null;
}

interface EventsSlot {
  readonly id: string;
  readonly list: readonly SessionEvent[];
  /** The list is complete (fetched once, or cached). */
  readonly loaded: boolean;
  readonly failed: boolean;
}

const NO_EVENTS: readonly SessionEvent[] = [];

function cachedDetail(id: string): DetailSlot {
  return { id, data: sessionCache.get(id)?.detail ?? null, error: null };
}

function cachedEvents(id: string): EventsSlot {
  const list = sessionCache.get(id)?.events ?? null;
  return { id, list: list ?? NO_EVENTS, loaded: list !== null, failed: false };
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
 */
export function useSessionData(sessionId: string, wantEvents: boolean): SessionData {
  const [detailSlot, setDetail] = useState<DetailSlot>(() => cachedDetail(sessionId));
  const [eventsSlot, setEvents] = useState<EventsSlot>(() => cachedEvents(sessionId));
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
    api.sessionEvents(sessionId).then(
      (fetched) => {
        if (cancelled) return;
        settle();
        setEvents({ id: sessionId, list: mergeFetchedEvents(fetched, live), loaded: true, failed: false });
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
      return { ...base, list: upsertEvent(base.list, payload.event) };
    });
  });

  // The complete list follows every update into the cache.
  useEffect(() => {
    if (eventsSlot.loaded) sessionCache.putEvents(eventsSlot.id, eventsSlot.list);
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
    reload,
  };
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
