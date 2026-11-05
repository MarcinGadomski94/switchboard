import type { InboxItem } from '../../core/api.ts';
import { type MoveRetry, moveRetry } from '../../core/moves.ts';
import { api } from '../api/client.ts';

/**
 * D154 (`docs/peers.md` → *Following a move (D154)*): a failed move's **Try again** (its
 * Needs-you / Inbox item, the move dialog attached to the run). Both themes: the move is
 * read as this computer names it (its id from `GET /api/machines`), then the dialog opens
 * for the same agent and computer with the last choices.
 */

/** This computer's id (asked once). */
let self: Promise<string> | null = null;

/** This computer's machine id. */
export function selfMachineId(): Promise<string> {
  self ??= api.machines().then(
    (view) => view.self.id,
    (error: unknown) => {
      self = null;
      throw error;
    },
  );
  return self;
}

/** The move of a failed move's item (or a listed move) as this computer retries it. */
export async function retryOf(move: NonNullable<InboxItem['move']>): Promise<MoveRetry> {
  return moveRetry(move, await selfMachineId());
}

export { choiceOfRetry, retryRequest } from './retry-model.ts';
