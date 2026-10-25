/**
 * D131 · lane X · the one v2 board's pure part (`Board.tsx`): its four columns,
 * their icons, the counts, the key that tells the FLIP animation a card moved,
 * and how a board card (or any other "open this agent" spot) opens its agent.
 * The Agents board (lane A) and a project's Board view (lane P) both use it;
 * each keeps its own rule for which column an agent or a step sits in.
 */

/** The prototype's four columns, left to right. */
export const BOARD_COLUMNS = ['needs', 'working', 'ready', 'done'] as const;

/** One of {@link BOARD_COLUMNS}. */
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** Each column's icon (the prototype's `COLS`). */
export const BOARD_COLUMN_ICON: Readonly<Record<BoardColumn, string>> = { needs: 'hand', working: 'dot', ready: 'half', done: 'check-circle' };

/** How many of `items` sit in each column; `columnOf` → `null` = not on the board. */
export function boardCounts<T>(items: readonly T[], columnOf: (item: T) => BoardColumn | null): Readonly<Record<BoardColumn, number>> {
  const out: Record<BoardColumn, number> = { needs: 0, working: 0, ready: 0, done: 0 };
  for (const item of items) {
    const column = columnOf(item);
    if (column !== null) out[column] += 1;
  }
  return out;
}

/** A lane's cards as the FLIP key sees them: its id and, per card, the card's id and column. */
export interface FlipLane {
  readonly id: string;
  readonly cards: readonly { readonly id: string; readonly column: BoardColumn | null }[];
}

/** The key that changes whenever a card changes lane or column (the board then animates the moves). */
export function boardFlipKey(lanes: readonly FlipLane[]): string {
  return lanes.map((lane) => `${lane.id}:${lane.cards.map((card) => `${card.id}=${card.column ?? '-'}`).join(',')}`).join('|');
}

/**
 * How a click on an agent opens it: the peek sheet on a desktop or a tablet
 * (the prototype's `data-peek`: look without leaving the page, then "Open full
 * view"), the agent's own page on a phone (the prototype's phone opens the chat).
 */
export function agentOpening(layout: 'desktop' | 'tablet' | 'phone'): 'peek' | 'page' {
  return layout === 'phone' ? 'page' : 'peek';
}
