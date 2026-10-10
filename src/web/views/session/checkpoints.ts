import { useEffect, useSyncExternalStore } from 'react';
import type { SessionEvent } from '../../../core/api.ts';
import type { SessionCheckpoints } from '../../../core/checkpoints.ts';
import { api } from '../../api/client.ts';

/**
 * D80 · Undo a turn (`docs/undo.md`): the UI's side. A small module store (as the
 * D72 dialog's) holds each session's checkpoints (`GET /api/sessions/{id}/checkpoints`)
 * for the chat's turn actions, the Redo button on the newest revert's divider and
 * the header's *Undo last turn*; and which revert confirmation is open.
 */

const cache = new Map<string, SessionCheckpoints>();
const inFlight = new Map<string, Promise<void>>();
/** A refresh asked for while one runs: one more follows it. */
const again = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reads the session's checkpoints again (one request at a time per session; a failure keeps what was there). */
export function refreshCheckpoints(sessionId: string): void {
  if (inFlight.has(sessionId)) {
    again.add(sessionId);
    return;
  }
  const run = api.checkpoints(sessionId).then(
    (data) => {
      cache.set(sessionId, data);
      notify();
    },
    () => undefined,
  );
  inFlight.set(
    sessionId,
    run.finally(() => {
      inFlight.delete(sessionId);
      if (again.delete(sessionId)) refreshCheckpoints(sessionId);
    }),
  );
}

/**
 * The session's checkpoints, live (`null` until read). `refreshKey` changes when
 * they may have changed (a new event, a status change): they are read again then.
 */
export function useCheckpoints(sessionId: string, refreshKey: string): SessionCheckpoints | null {
  useEffect(() => {
    if (sessionId !== '') refreshCheckpoints(sessionId);
  }, [sessionId, refreshKey]);
  return useSyncExternalStore(subscribe, () => (sessionId === '' ? null : (cache.get(sessionId) ?? null)));
}

/**
 * D95: the chat's `refreshKey` for {@link useCheckpoints}: what can change the
 * checkpoints it shows, the session's user messages (a new turn; one withdrawn or
 * no longer queued), its revert dividers and its status, not every event (each
 * read runs git in the session's repos; a streaming turn sent one per event).
 */
export function checkpointsKey(events: readonly SessionEvent[], status: string): string {
  let count = 0;
  let last = 0;
  let marks = '';
  for (const event of events) {
    const payload = event.payload as { type?: unknown; action?: unknown; withdrawn?: unknown; queued?: unknown } | null;
    const type = payload?.type;
    if (type === 'user' || (type === 'lifecycle' && (payload?.action === 'reverted' || payload?.action === 'revert-undone'))) {
      count += 1;
      if (event.id > last) last = event.id;
      if (payload?.withdrawn === true || payload?.queued !== undefined) marks += `${event.id}${payload?.withdrawn === true ? 'w' : 'q'},`;
    }
  }
  return `${count}:${last}:${marks}:${status}`;
}

/** What the turn action on a user bubble offers: the turn to revert to, or why it cannot. */
export interface TurnRevert {
  /** The turn to revert to; `null` = the action is disabled. */
  readonly turn: number | null;
  /** Why it is disabled (its tooltip); `null` = enabled. */
  readonly reason: string | null;
}

/** Why a turn without a checkpoint has none (the setting was off, it was pruned, it is older than the feature). */
export const NO_CHECKPOINT = 'No checkpoint for this turn (taken while checkpoints were off, or pruned after 7 days / 100 turns)';
/** While a turn runs. */
export const STOP_FIRST = 'A turn is running: stop it first';

/** The action on the user bubble of event `eventId` (`null` = none: not read yet). */
export function turnRevertFor(data: SessionCheckpoints | null, eventId: number): TurnRevert | null {
  if (!data) return null;
  const turn = data.turns.find((entry) => entry.eventId === eventId);
  if (turn) return { turn: turn.turn, reason: data.running ? STOP_FIRST : null };
  return { turn: null, reason: data.unsupported ?? NO_CHECKPOINT };
}

/**
 * *Undo last turn* (ruling D80-q1): the newest turn, enabled when it has a checkpoint, else
 * disabled with the reason; `null` (not shown) only before the read and while the session
 * has no user turn yet.
 */
export function lastTurnRevert(data: SessionCheckpoints | null): TurnRevert | null {
  if (!data || data.latestTurn < 1) return null;
  const last = data.turns.at(-1);
  if (last && last.turn === data.latestTurn) return { turn: last.turn, reason: data.running ? STOP_FIRST : null };
  return { turn: null, reason: data.unsupported ?? NO_CHECKPOINT };
}

// ── the open confirmation ─────────────────────────────────────────────

/** A revert being confirmed. */
export interface RevertRequest {
  readonly sessionId: string;
  readonly turn: number;
}

let request: RevertRequest | null = null;

/** Opens the confirmation of a revert to before `turn`. */
export function openRevert(next: RevertRequest): void {
  request = next;
  notify();
}

/** Closes it. */
export function closeRevert(): void {
  request = null;
  notify();
}

/** The open confirmation, live. */
export function useRevertRequest(): RevertRequest | null {
  return useSyncExternalStore(subscribe, () => request);
}
