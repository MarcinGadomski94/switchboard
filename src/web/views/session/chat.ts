import type { SessionEvent } from '../../../core/api.ts';
import type { AssistantPayload, UserPayload } from '../../../core/event-payload.ts';

/**
 * The chat's messages from the session's events (`docs/derivations.md` → *Events*):
 * user messages (typed here, the task, "Continue.", service notes, and prompts a
 * terminal sent while detached, origin `terminal`) on the right, assistant text on
 * the left, in time order. M4.1 needs them so the terminal's turns show after
 * "Attach here"; M4.2 adds tool lines, the question card, quick replies and the
 * composer.
 */
export interface ChatMessage {
  /** The event id. */
  readonly id: number;
  readonly role: 'user' | 'agent';
  readonly text: string;
  /** For user messages: where it came from (`task`, `user`, `resume`, `service`, `terminal`). */
  readonly origin: string | null;
  readonly ts: string;
}

function payloadOf(event: SessionEvent): { type?: unknown } | null {
  return event.payload && typeof event.payload === 'object' ? (event.payload as { type?: unknown }) : null;
}

/** Messages of the main conversation (subagent prompts and other events are not messages). */
export function chatMessages(events: readonly SessionEvent[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const event of events) {
    const payload = payloadOf(event);
    if (payload?.type === 'user') {
      const user = payload as UserPayload;
      out.push({ id: event.id, role: 'user', text: user.text, origin: user.origin, ts: event.ts });
    } else if (payload?.type === 'assistant') {
      out.push({ id: event.id, role: 'agent', text: (payload as AssistantPayload).text, origin: null, ts: event.ts });
    }
  }
  return out.sort((a, b) => (a.ts === b.ts ? a.id - b.id : a.ts < b.ts ? -1 : 1));
}

/** `events` with `event` added, or replaced when an event with its id is already there (merged text, closed tool). */
export function upsertEvent(events: readonly SessionEvent[], event: SessionEvent): SessionEvent[] {
  const at = events.findIndex((e) => e.id === event.id);
  if (at < 0) return [...events, event];
  const next = [...events];
  next[at] = event;
  return next;
}
