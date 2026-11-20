/**
 * SPIKE · "N files changed" under the last reply of a turn. The agent view provides
 * what each turn changed (`src/core/turn-changes.ts`); the chat's reply rows read it
 * from the context. Without a provider (the peek, a helper's chat, the classic
 * theme) nothing shows.
 */
import { createContext } from 'react';
import type { TurnChange } from '../../../core/turn-changes.ts';
import type { ChatRow } from './chat-model.ts';

export interface TurnChangeLinks {
  /** By the event id of your message that started the turn. */
  readonly byEvent: ReadonlyMap<number, TurnChange>;
  /** The reply rows that end their turn ({@link lastRepliesOf}). */
  readonly lastReplies: ReadonlySet<number>;
  /** Opens the side panel's Changes on that turn. */
  readonly open: (change: TurnChange) => void;
}

export const TurnChangesContext = createContext<TurnChangeLinks | null>(null);

/**
 * The last turn's changes: the newest turn that changed something, when it reaches the
 * agent's latest turn (two messages that ran as one turn count as one). `null` when
 * the latest turn changed nothing.
 */
export function lastTurnChange(turns: readonly TurnChange[], latestTurn: number): TurnChange | null {
  let newest: TurnChange | null = null;
  for (const change of turns) if (newest === null || change.turn > newest.turn) newest = change;
  return newest !== null && latestTurn > 0 && newest.through >= latestTurn ? newest : null;
}

/** The ids of the reply rows that end their turn (the last reply after each of your messages): the chip sits under them. */
export function lastRepliesOf(rows: readonly ChatRow[]): Set<number> {
  const last = new Map<number, number>();
  for (const row of rows) if (row.kind === 'reply' && row.turnEventId !== null) last.set(row.turnEventId, row.id);
  return new Set(last.values());
}
