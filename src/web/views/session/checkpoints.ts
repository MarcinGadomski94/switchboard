import { useEffect, useSyncExternalStore } from 'react';
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
    refreshCheckpoints(sessionId);
  }, [sessionId, refreshKey]);
  return useSyncExternalStore(subscribe, () => cache.get(sessionId) ?? null);
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

/** *Undo last turn*: the newest turn with a checkpoint (`null` = none, the item is not shown). */
export function lastTurnRevert(data: SessionCheckpoints | null): TurnRevert | null {
  const last = data?.turns.at(-1);
  if (!data || !last) return null;
  return { turn: last.turn, reason: data.running ? STOP_FIRST : null };
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
