import { useEffect, useRef, useSyncExternalStore } from 'react';
import { HUB_EVENT_NAMES, type HubEventName, type HubEvents, type Session } from '../../core/api.ts';
import { AGENT_DELTA_QUERY, AGENT_DELTA_VALUE, AgentDeltaDecoder } from '../../core/agent-delta.ts';
import { pageClientId } from '../pwa/presence.ts';
import { presenceHubOpened } from '../pwa/presence-page.ts';

/**
 * Client of the `/hub` Server-Sent Events stream (D5, contract → Event hub). One
 * shared `EventSource` for the whole page, opened by the first subscriber and
 * closed after the last one leaves. Payloads are one line of camelCase JSON per
 * event. The browser reconnects by itself after a dropped stream; when the server
 * refuses the stream (non-200, e.g. before M2.3 lands), the client retries with a
 * backoff of 2 s doubling up to 60 s. D87: the stream names the page
 * (`/hub?client=<id>`, `pwa/presence.ts`): on a paired device the server knows the
 * page is gone once its stream drops. D95 follow-up: the stream asks for agent deltas
 * (`&agents=delta`, `core/agent-delta.ts`); `sessionUpdated` is expanded here to the
 * session's whole agent list before any handler sees it, so handlers are unchanged.
 */

type Handler<K extends HubEventName> = (payload: HubEvents[K]) => void;

/** `connecting` until the stream is open, `open` while it is, `closed` while waiting to retry. */
export type HubStatus = 'connecting' | 'open' | 'closed';

const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;

const handlers = new Map<HubEventName, Set<(payload: unknown) => void>>();
const statusListeners = new Set<() => void>();
let source: EventSource | null = null;
let status: HubStatus = 'closed';
let retryMs = RETRY_MIN_MS;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let subscribers = 0;
/** D95 follow-up: the open stream's agent lists (a new stream starts with whole lists). */
const agentLists = new AgentDeltaDecoder();

function setStatus(next: HubStatus): void {
  if (status === next) return;
  status = next;
  for (const listener of statusListeners) listener();
}

function dispatch(name: HubEventName, raw: string): void {
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return;
  }
  if (name === 'sessionUpdated' && payload && typeof payload === 'object') payload = agentLists.decode(payload as Session);
  for (const handler of handlers.get(name) ?? []) handler(payload);
}

function open(): void {
  if (source || subscribers === 0) return;
  setStatus('connecting');
  const es = new EventSource(`/hub?client=${encodeURIComponent(pageClientId())}&${AGENT_DELTA_QUERY}=${AGENT_DELTA_VALUE}`, { withCredentials: true });
  source = es;
  es.onopen = () => {
    // Also after the browser reconnected by itself: the server's side of the new stream starts with whole lists.
    agentLists.reset();
    retryMs = RETRY_MIN_MS;
    setStatus('open');
    presenceHubOpened();
  };
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      // The server refused the stream: retry with a backoff.
      es.close();
      source = null;
      setStatus('closed');
      if (subscribers > 0 && !retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          open();
        }, retryMs);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }
    } else {
      setStatus('connecting');
    }
  };
  for (const name of HUB_EVENT_NAMES) {
    es.addEventListener(name, (event) => dispatch(name, (event as MessageEvent<string>).data));
  }
}

function close(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  source?.close();
  source = null;
  setStatus('closed');
}

function retain(): () => void {
  subscribers += 1;
  open();
  return () => {
    subscribers -= 1;
    if (subscribers === 0) close();
  };
}

/** Calls `handler` for every `name` event while the component is mounted. */
export function useHubEvent<K extends HubEventName>(name: K, handler: Handler<K>): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = (payload: unknown): void => ref.current(payload as HubEvents[K]);
    let set = handlers.get(name);
    if (!set) {
      set = new Set();
      handlers.set(name, set);
    }
    set.add(listener);
    const release = retain();
    return () => {
      set.delete(listener);
      release();
    };
  }, [name]);
}

/** The hub connection status (keeps the stream open while mounted). */
export function useHubStatus(): HubStatus {
  useEffect(() => retain(), []);
  return useSyncExternalStore(
    (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    () => status,
  );
}
