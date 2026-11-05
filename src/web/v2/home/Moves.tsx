import { type MoveRecord, homeMoves, moveAgentName, moveBadgeText, moveOutcomeText } from '../../../core/moves.ts';
import { useTick } from '../../activity/useActivity.ts';
import { api } from '../../api/client.ts';
import { Chip, Icon, IconButton } from '../components/index.ts';
import { MOVES_WORDS } from '../glossary.ts';
import { openMoveStatus, useMoves } from '../shared/moves.ts';
import { timeAgo } from '../shared/time.ts';

/**
 * D154 (`docs/v2.md` → *Home* → *Moves*): Home's Moves card, shown while there is
 * something to show. **Running** moves (the agent, from → to, the step; a click opens
 * the move dialog on that run) and **recently finished** ones (done or failed with the
 * outcome, when; a click opens it; × dismisses it; a failed one also has its Needs-you
 * item). Finished ones go by themselves after a day. Live through the shared moves list.
 */
export function HomeMoves({ phone }: { readonly phone: boolean }) {
  const { moves } = useMoves();
  const now = useTick(60_000);
  const { running, finished } = homeMoves(moves, now);
  if (running.length === 0 && finished.length === 0) return null;
  const rows = (
    <div className="v2-card v2-home-moves" data-testid="v2-home-moves" data-tour="v2-home-moves" data-phone={phone ? '' : undefined}>
      {running.map((move) => (
        <MoveRow key={move.id} move={move} now={now} />
      ))}
      {finished.map((move) => (
        <MoveRow key={move.id} move={move} now={now} />
      ))}
    </div>
  );
  if (phone) {
    return (
      <>
        <h2 className="v2-home-psec">
          <Icon name="desktop" size="s" />
          {MOVES_WORDS.title}
        </h2>
        {rows}
      </>
    );
  }
  return (
    <section className="v2-home-sec" aria-labelledby="v2-home-moves-h">
      <div className="v2-home-sec-h">
        <span className="v2-home-sec-i" data-tone="blue">
          <Icon name="desktop" />
        </span>
        <h2 id="v2-home-moves-h">{MOVES_WORDS.title}</h2>
        {running.length > 0 ? (
          <span className="v2-home-count" data-testid="v2-home-moves-count">
            {running.length}
          </span>
        ) : null}
        <span className="v2-home-hint">{MOVES_WORDS.hint}</span>
      </div>
      {rows}
    </section>
  );
}

function MoveRow({ move, now }: { readonly move: MoveRecord; readonly now: number }) {
  const tone = move.state === 'running' ? 'blue' : move.state === 'done' ? 'green' : 'red';
  const word = move.state === 'running' ? MOVES_WORDS.running : move.state === 'done' ? MOVES_WORDS.done : MOVES_WORDS.failed;
  const name = moveAgentName(move);
  return (
    <div className="v2-home-move" data-testid="v2-home-move" data-move={move.id} data-state={move.state}>
      <button type="button" className="v2-home-move-open" onClick={() => openMoveStatus(move.id)} aria-label={`${name}: ${move.state === 'running' ? moveBadgeText(move) : moveOutcomeText(move)}`}>
        <Chip tone={tone} size="s" icon={move.state === 'done' ? 'check-circle' : move.state === 'failed' ? 'x' : undefined}>
          {move.state === 'running' ? <span className="v2-pulse" aria-hidden="true" /> : null}
          {word}
        </Chip>
        <span className="v2-home-move-body">
          <b>{name}</b>
          <span className="v2-muted v2-home-move-route">
            <span className="v2-home-move-dot" aria-hidden="true">
              {' · '}
            </span>
            {move.source.name} → {move.target.name}
            {move.member ? ` · ${move.member.teamName}` : ''}
          </span>
          <span className="v2-home-move-line" data-testid="v2-home-move-line">
            {move.state === 'running' ? moveBadgeText(move) : moveOutcomeText(move)}
          </span>
        </span>
        <span className="v2-muted v2-home-move-when">{timeAgo(move.state === 'running' ? move.startedAt : (move.endedAt ?? move.updatedAt), now)}</span>
      </button>
      {move.state !== 'running' ? <IconButton icon="x" iconSize="s" label={MOVES_WORDS.dismissLabel(name)} data-testid="v2-home-move-dismiss" onClick={() => void api.dismissMove(move.id).catch(() => undefined)} /> : null}
    </div>
  );
}
