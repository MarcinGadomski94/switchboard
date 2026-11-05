import { useEffect, useSyncExternalStore } from 'react';
import { type MoveRecord, type MoveRetry, applyMoveChange } from '../../../core/moves.ts';
import { api } from '../../api/client.ts';
import { onHubEvent, onHubStatus } from '../../api/useHub.ts';
import { openStore } from './open-store.ts';
import { openTakeover } from '../../takeover/store.ts';
import { openChatMove } from '../../takeover/chat-move-store.ts';
import { retryRequest } from '../../takeover/retry-model.ts';

/**
 * D154 (`docs/v2.md` → *Moves*): the moves list shared by every view (the badges on an
 * agent, a teammate and a crew, Home's Moves card, the move dialog attached to a run):
 * `GET /api/moves` once, then kept live by `/hub` `movesChanged` (a step, an end, a
 * dismiss), read again when the hub reconnects or a computer's state changes. The
 * stream stays open while a view uses it.
 */

interface MovesState {
  readonly moves: readonly MoveRecord[];
  readonly loaded: boolean;
}

let state: MovesState = { moves: [], loaded: false };
const listeners = new Set<() => void>();
let users = 0;
let off: Array<() => void> = [];
let asked = 0;

function set(next: MovesState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** Reads the list again (the newest answer wins). */
export function reloadMoves(): void {
  const n = ++asked;
  api.moves().then(
    (moves) => {
      if (n === asked) set({ moves, loaded: true });
    },
    () => {
      if (n === asked && !state.loaded) set({ moves: [], loaded: true });
    },
  );
}

function retain(): () => void {
  users += 1;
  if (users === 1) {
    reloadMoves();
    off = [
      onHubEvent('movesChanged', (change) => set({ moves: applyMoveChange(state.moves, change), loaded: state.loaded })),
      onHubEvent('machineState', () => reloadMoves()),
      onHubStatus((status) => {
        if (status === 'open') reloadMoves();
      }),
    ];
  }
  return () => {
    users -= 1;
    if (users > 0) return;
    for (const stop of off) stop();
    off = [];
  };
}

/** The moves, live (running first, then the finished ones of the last 24 hours). */
export function useMoves(): MovesState {
  useEffect(() => retain(), []);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

/** The move dialog attached to a run (`moveId`), opened from a badge, Home or a Needs-you item. */
export const moveStatusDialog = openStore<{ readonly moveId: string }>();

/** A failed move's **Try again**: the agent's (or teammate's) move dialog, pre-filled with the last choices. */
export const moveRetryDialog = openStore<MoveRetry>();

/** A failed move's **Try again**: the agent's Move dialog, or a teammate's Move to computer…, with the last choices. */
export function startRetry(retry: MoveRetry): void {
  if (retry.kind === 'teammate' && retry.member) moveRetryDialog.open(retry);
  // D155: a chat's move opens the chat's own move dialog (its folders choices are remembered there).
  else if (retry.kind === 'chat') openChatMove({ chatId: retry.sessionId, targetMachine: retry.targetMachine, machineName: retry.machineName, title: retry.title });
  else openTakeover(retryRequest(retry));
}

/** Opens the move dialog on run `moveId`. */
export function openMoveStatus(moveId: string): void {
  moveStatusDialog.open({ moveId });
}
