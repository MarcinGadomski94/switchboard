import { type MoveRecord, activeMove, moveBadgeText } from '../../../core/moves.ts';
import './shared.css';
import { Icon } from '../components/index.ts';
import { openMoveStatus, useMoves } from './moves.ts';

/**
 * D154 (`docs/v2.md` → *Moves*): "Moving to <PC>… (<step>)" while a move of the agent, the
 * teammate or one of the crew's teammates runs; a click reopens the move dialog on that run
 * (its steps, how it ends, Try again). Nothing while nothing moves.
 */
export function MoveBadge({ of, size }: { readonly of: { readonly sessionId?: string; readonly memberId?: string; readonly teamId?: string }; readonly size?: 's' }) {
  const { moves } = useMoves();
  const move = activeMove(moves, of);
  return move ? <MoveBadgeOf move={move} {...(size ? { size } : {})} /> : null;
}

/** The badge of one running move. */
export function MoveBadgeOf({ move, size }: { readonly move: MoveRecord; readonly size?: 's' }) {
  const text = moveBadgeText(move);
  return (
    <button
      type="button"
      className="v2-move-badge"
      data-size={size}
      data-testid="v2-move-badge"
      data-tour="v2-move-badge"
      data-move={move.id}
      data-step={move.step?.id}
      title={`${text} Open the move.`}
      onClick={(event) => {
        event.stopPropagation();
        openMoveStatus(move.id);
      }}
    >
      <Icon name="desktop" size="s" />
      <span className="v2-pulse" aria-hidden="true" />
      <span className="v2-move-badge-text">{text}</span>
    </button>
  );
}
