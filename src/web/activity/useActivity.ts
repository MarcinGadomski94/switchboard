import { useCallback, useEffect, useState } from 'react';
import type { Session, SessionActivity } from '../../core/api.ts';
import { useHubEvent } from '../api/useHub.ts';

/**
 * The live activity on the page (D19): `Session.activity` from the last REST load
 * (the seed), replaced by each `/hub` `activity` event for that session until the
 * next load brings a newer seed. A load always wins over an older event: the REST
 * value is current when it is read, and the throttled events carry the newest
 * value too, so the two never disagree for long.
 */

interface LiveValue<S> {
  /** The load the event arrived after (object identity of the loaded data). */
  readonly source: S;
  readonly activity: SessionActivity | null;
}

/**
 * One session's activity. `source` is the loaded session (a new object per load,
 * e.g. `GET /api/sessions/{id}`), `null` while it loads.
 */
export function useLiveActivity(sessionId: string, source: Pick<Session, 'id' | 'activity'> | null): SessionActivity | null {
  const [live, setLive] = useState<(LiveValue<unknown> & { readonly sessionId: string }) | null>(null);
  useHubEvent('activity', (payload) => {
    if (payload.sessionId === sessionId) setLive({ source, sessionId, activity: payload.activity });
  });
  if (live && live.sessionId === sessionId && live.source === source) return live.activity;
  return source && source.id === sessionId ? source.activity : null;
}

/**
 * Every listed session's activity (the sidebar): `sessions` is the loaded list
 * (`GET /api/sessions`, a new array per load). Returns a lookup by session id.
 */
export function useLiveActivities(sessions: readonly Pick<Session, 'id' | 'activity'>[] | null): (sessionId: string) => SessionActivity | null {
  const [live, setLive] = useState<ReadonlyMap<string, LiveValue<unknown>>>(new Map());
  useHubEvent('activity', (payload) => {
    setLive((current) => new Map(current).set(payload.sessionId, { source: sessions, activity: payload.activity }));
  });
  return useCallback(
    (sessionId: string) => {
      const value = live.get(sessionId);
      if (value && value.source === sessions) return value.activity;
      return sessions?.find((session) => session.id === sessionId)?.activity ?? null;
    },
    [live, sessions],
  );
}

/** The current time, re-rendering every `ms` while mounted (the activity clocks tick locally). */
export function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
