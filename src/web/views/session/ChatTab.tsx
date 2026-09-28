import { useEffect, useState } from 'react';
import type { SessionEvent } from '../../../core/api.ts';
import { api } from '../../api/client.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { chatMessages, upsertEvent } from './chat.ts';

/**
 * Chat tab (SPEC → Session → Chat). M4.1 shows the conversation's messages (user
 * bubbles right, agent text left) from `GET /api/sessions/{id}/events` and the
 * `/hub` `event` stream, so the turns a terminal added show after "Attach here"
 * (they arrive as events with the transcript's timestamps). M4.2 fills the rest:
 * tool lines, the inline question card, quick replies and the composer.
 */
export function ChatTab({ sessionId }: { readonly sessionId: string }) {
  const [events, setEvents] = useState<readonly SessionEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.sessionEvents(sessionId).then(
      (loaded) => {
        if (cancelled) return;
        // Events the stream delivered while loading stay (merged by id).
        setEvents((current) => current.reduce(upsertEvent, [...loaded]));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useHubEvent('event', (payload) => {
    if (payload.sessionId === sessionId) setEvents((current) => upsertEvent(current, payload.event));
  });

  const messages = chatMessages(events);
  return (
    <div className="sb-chat" data-testid="session-chat" data-session-id={sessionId}>
      {messages.map((message) => (
        <div
          key={message.id}
          className="sb-chat-message"
          data-testid="chat-message"
          data-role={message.role}
          data-origin={message.origin ?? undefined}
        >
          <div className="sb-chat-bubble">{message.text}</div>
        </div>
      ))}
    </div>
  );
}
