import type { SessionEvent } from '../../../core/api.ts';
import { type ToolPayload, textCutAt } from '../../../core/event-payload.ts';

/**
 * Fix · long messages: the chat's "cut" notes and the restored events
 * (`docs/chat.md` → *Cut messages*), kept free of React so `tests/web` can check
 * them. A message stored cut shows "Message cut at 4,000 characters · Show full
 * message"; a subagent's result (a tool result, kept cut in the database) "Output
 * truncated at 4,000 characters · Show full output". Either fetches the whole text
 * from the session's CLI transcript (`GET /api/sessions/{id}/events/{eventId}/full`).
 */

/** What was cut: message text (written back once restored) or a tool call's output (only shown). */
export type CutKind = 'message' | 'output';

/** A cut text in the chat: the event that holds it, where it was cut, and what it is. */
export interface CutRef {
  readonly eventId: number;
  /** Characters kept. */
  readonly at: number;
  readonly kind: CutKind;
}

/** The note's button. */
export const SHOW_FULL: Readonly<Record<CutKind, string>> = {
  message: 'Show full message',
  output: 'Show full output',
};

/** While the whole text loads. */
export const LOADING_FULL = 'Loading the full text…';

/** `4,000` (the cut, grouped by thousands). */
function count(at: number): string {
  return at.toLocaleString('en-US');
}

/** The note before the button: "Message cut at 4,000 characters" / "Output truncated at 4,000 characters". */
export function cutNote(cut: Pick<CutRef, 'at' | 'kind'>): string {
  return cut.kind === 'message' ? `Message cut at ${count(cut.at)} characters` : `Output truncated at ${count(cut.at)} characters`;
}

/** Where a message event's text was cut, as a {@link CutRef}; `null` when it is whole. */
export function messageCut(event: SessionEvent): CutRef | null {
  const at = textCutAt(event.payload);
  return at === null ? null : { eventId: event.id, at, kind: 'message' };
}

/** `true` while an event still holds cut text (message text, or a tool call's input or result). */
export function isCut(event: SessionEvent): boolean {
  if (textCutAt(event.payload) !== null) return true;
  const payload = event.payload as Partial<ToolPayload> | null;
  return payload?.type === 'tool' && (payload.inputTruncated === true || payload.resultTruncated === true);
}

/**
 * `events` with the restored ones in place: a restored event stands in for its
 * event while that one is still cut (the `/hub` update of a written-back message
 * replaces it anyway; a tool call's output is only ever restored here).
 */
export function withRestored(events: readonly SessionEvent[], restored: ReadonlyMap<number, SessionEvent>): readonly SessionEvent[] {
  if (restored.size === 0) return events;
  return events.map((event) => {
    const whole = restored.get(event.id);
    return whole && whole.sessionId === event.sessionId && isCut(event) ? whole : event;
  });
}

/** The line shown when the whole text could not be fetched: the server's `message`, else the HTTP status. */
export function fullTextError(status: number, body: unknown): string {
  const message =
    typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message : null;
  if (message) return message;
  return status === 0 ? 'Switchboard is not reachable: the full text could not be fetched.' : `The full text could not be fetched (HTTP ${status}).`;
}
