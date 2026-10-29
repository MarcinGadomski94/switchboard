import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useFullText } from '../../views/session/FullText.tsx';
import { type ChatItem, chatItems } from '../../views/session/chat.ts';
import { OUTGOING_SETTLE_MS, type OutgoingMessage, dropOutgoing, matchOutgoing, outgoingOf, settledOutgoing, subscribeOutgoing } from '../../views/session/outgoing.ts';
import { keepIdentity } from '../../views/session/keep-identity.ts';
import { type ChatRow, chatRows, placeResults } from './chat-model.ts';
import { resultRefs } from './tabs.tsx';
import type { AgentData } from './useAgent.ts';

/** A message on its way (D114), as a chat item (not delivered; its id is never an event's). */
function outgoingItem(message: OutgoingMessage, index: number): ChatItem {
  return { kind: 'user', key: `o:${message.key}`, id: -(index + 1), text: message.text, origin: 'user', delivered: false, queued: message.queued, attachments: message.attachments, cut: null };
}

/**
 * D131 · lane S · the chat's rows for an agent: the classic chat model's items
 * (`chatItems`, the loaded window, cut texts restored), the messages on their way
 * (D114: shown at once, until their event comes), turned into the v2 rows with the
 * agent's results placed as attachments. Also the newest event id (a sent
 * message's own event comes after it) and the full-text control.
 */
export function useChatRows(data: AgentData): { readonly rows: readonly ChatRow[]; readonly lastEventId: () => number; readonly fullText: ReturnType<typeof useFullText>['control'] } {
  const { sessionId, session, events, eventsState, older } = data;
  const fullText = useFullText(sessionId, events);
  const questions = session?.questions;
  const agents = session?.agents;
  const mainAgentId = agents?.find((agent) => agent.kind === 'main')?.id ?? null;
  const ready = session !== null && eventsState !== 'loading';
  const complete = !older.available;
  const items = useMemo(() => (ready && questions && agents ? chatItems(fullText.events, questions, mainAgentId, agents, { complete }) : []), [ready, fullText.events, questions, mainAgentId, agents, complete]);
  const outgoing = useSyncExternalStore(subscribeOutgoing, () => outgoingOf(sessionId));
  const match = useMemo(() => matchOutgoing(events, outgoing), [events, outgoing]);
  // Fix after 2.0: shown at once, even before the chat has loaded (coming back to the agent while it loads).
  const all = useMemo(() => (match.waiting.length > 0 ? [...items, ...match.waiting.map(outgoingItem)] : items), [items, match]);
  useEffect(() => {
    for (const key of settledOutgoing(outgoing, match.shown)) dropOutgoing(sessionId, key);
    const waiting = outgoing.filter((item) => item.state === 'sent' && item.sentAt !== null && !match.shown.has(item.key));
    if (waiting.length === 0) return undefined;
    const due = Math.min(...waiting.map((item) => (item.sentAt ?? 0) + OUTGOING_SETTLE_MS)) - Date.now();
    const timer = setTimeout(
      () => {
        for (const key of settledOutgoing(outgoingOf(sessionId), new Set())) dropOutgoing(sessionId, key);
      },
      Math.max(0, due),
    );
    return () => clearTimeout(timer);
  }, [sessionId, outgoing, match]);
  const times = useMemo(() => new Map(fullText.events.map((event) => [event.id, { ts: event.ts, endTs: event.endTs }])), [fullText.events]);
  const artifacts = session?.artifacts;
  // Typing lag fix (2026-10-29): rows that did not change stay the same objects (the chat's rows are memoized).
  const previousRows = useRef<{ readonly sessionId: string; readonly rows: readonly ChatRow[] } | null>(null);
  const built = useMemo(() => {
    const base = chatRows({ items: all, times, agents: agents ?? [], now: Date.now() });
    // Results older than the loaded window belong to a page not loaded yet.
    const first = base.find((row): row is Extract<ChatRow, { kind: 'you' | 'reply' }> => (row.kind === 'you' || row.kind === 'reply') && row.at !== null);
    const refs = resultRefs(artifacts).filter((r) => complete || !first || first.at === null || Date.parse(r.createdAt) >= first.at);
    return placeResults(base, refs);
  }, [all, times, agents, artifacts, complete]);
  const rows = useMemo(() => {
    const last = previousRows.current;
    const kept = keepIdentity(last !== null && last.sessionId === sessionId ? last.rows : null, built);
    previousRows.current = { sessionId, rows: kept };
    return kept;
  }, [built, sessionId]);
  const newest = useMemo(() => events.reduce((max, event) => Math.max(max, event.id), 0), [events]);
  const newestRef = useRef(newest);
  newestRef.current = newest;
  return { rows, lastEventId: () => newestRef.current, fullText: fullText.control };
}
