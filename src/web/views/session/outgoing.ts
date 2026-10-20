/**
 * Fix · queued send feedback (`docs/chat.md` → *Composer*): the messages the
 * composer sent that the chat has not shown yet. While a turn runs, the service
 * may take seconds to answer `POST …/messages` (the checkpoint's git snapshot
 * before the message, the process's queue of stream lines), and the bubble only
 * came with the `/hub` event after it. Now the composer empties at once and the
 * message shows here until its event is in the chat (then the event's bubble
 * stands alone: never two). Kept per session outside React, so leaving the session
 * and coming back while the answer is on its way still shows it. React-free, so
 * `tests/web` runs it in Node.
 */
import type { Attachment, SessionEvent } from '../../../core/api.ts';
import type { QueuedReason } from '../../../core/event-payload.ts';

/** How long an answered message waits for its event before it goes anyway (the window shows no end, a lost `/hub` event). */
export const OUTGOING_SETTLE_MS = 15_000;

/** One message on its way. */
export interface OutgoingMessage {
  readonly key: string;
  /** The text as sent (trimmed; the service records it so, after any outbox notes). */
  readonly text: string;
  readonly attachments: readonly Attachment[];
  /** The clock it shows meanwhile (the session ran a turn / had no process); `null` = none. */
  readonly queued: QueuedReason | null;
  /** The newest event id the chat had when it was sent: its own event comes after. */
  readonly afterId: number;
  /** `sending` until the service answered; then `sent` (its event may still be on its way). */
  readonly state: 'sending' | 'sent';
  /** When it was answered (`Date.now()`), `null` while sending. */
  readonly sentAt: number | null;
}

type Listener = () => void;

const outgoing = new Map<string, readonly OutgoingMessage[]>();
const listeners = new Set<Listener>();
const NONE: readonly OutgoingMessage[] = [];
let nextKey = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

function update(sessionId: string, change: (list: readonly OutgoingMessage[]) => readonly OutgoingMessage[]): void {
  const before = outgoing.get(sessionId) ?? NONE;
  const after = change(before);
  if (after === before) return;
  if (after.length === 0) outgoing.delete(sessionId);
  else outgoing.set(sessionId, after);
  emit();
}

/** The session's messages on their way (a stable array until it changes, for `useSyncExternalStore`). */
export function outgoingOf(sessionId: string): readonly OutgoingMessage[] {
  return outgoing.get(sessionId) ?? NONE;
}

/** Calls `listener` on every change; answers the unsubscribe. */
export function subscribeOutgoing(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A message the composer is sending now; answers its key. */
export function addOutgoing(sessionId: string, message: Omit<OutgoingMessage, 'key' | 'state' | 'sentAt'>): string {
  nextKey += 1;
  const key = `o${nextKey}`;
  update(sessionId, (list) => [...list, { ...message, key, state: 'sending', sentAt: null }]);
  return key;
}

/** The service took it (202): it stays until its event is in the chat. */
export function outgoingSent(sessionId: string, key: string, now: number = Date.now()): void {
  update(sessionId, (list) => (list.some((item) => item.key === key) ? list.map((item) => (item.key === key ? { ...item, state: 'sent' as const, sentAt: now } : item)) : list));
}

/** It goes (refused, or its event is shown). */
export function dropOutgoing(sessionId: string, key: string): void {
  update(sessionId, (list) => (list.some((item) => item.key === key) ? list.filter((item) => item.key !== key) : list));
}

/** Tests: forget everything. */
export function resetOutgoing(): void {
  outgoing.clear();
  emit();
}

function userText(event: SessionEvent): string | null {
  const payload = event.payload;
  if (!payload || typeof payload !== 'object' || (payload as { type?: unknown }).type !== 'user') return null;
  const text = (payload as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

/**
 * Which messages on their way already have their event among `events` (a user
 * message newer than the chat was when it was sent, with the same text, or ending
 * with it: outbox notes go first in the same message), each event matched once, in
 * order. The rest still show as their own bubble.
 */
export function matchOutgoing(events: readonly SessionEvent[], list: readonly OutgoingMessage[]): { readonly shown: ReadonlySet<string>; readonly waiting: readonly OutgoingMessage[] } {
  if (list.length === 0) return { shown: new Set(), waiting: NONE };
  const users = events
    .flatMap((event) => {
      const text = userText(event);
      return text === null ? [] : [{ id: event.id, text: text.trim() }];
    })
    .sort((a, b) => a.id - b.id);
  const used = new Set<number>();
  const shown = new Set<string>();
  const waiting: OutgoingMessage[] = [];
  for (const message of list) {
    const match = users.find((user) => !used.has(user.id) && user.id > message.afterId && (message.text === '' || user.text === message.text || user.text.endsWith(`\n\n${message.text}`)));
    if (match) {
      used.add(match.id);
      shown.add(message.key);
    } else {
      waiting.push(message);
    }
  }
  return { shown, waiting };
}

/** The answered messages that can go now: their event is shown, or they waited {@link OUTGOING_SETTLE_MS}. */
export function settledOutgoing(list: readonly OutgoingMessage[], shown: ReadonlySet<string>, now: number = Date.now()): string[] {
  return list.filter((item) => item.state === 'sent' && (shown.has(item.key) || (item.sentAt !== null && now - item.sentAt >= OUTGOING_SETTLE_MS))).map((item) => item.key);
}
