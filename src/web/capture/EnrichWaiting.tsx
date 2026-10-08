import { ENRICH_WAITING_LABEL } from '../../core/todo-capture.ts';
import './capture.css';

/**
 * D81: the card's note on a captured item until its agent fills it in (its `todo_update`
 * clears the mark): `✎ waiting for the agent to fill in`.
 */
export function EnrichWaiting() {
  return (
    <span className="sb-todo-enrich" data-testid="todo-enrich-waiting" title="Captured quickly: the session's agent is asked to fill in the description, plan, priority and estimate when it is next idle">
      {ENRICH_WAITING_LABEL}
    </span>
  );
}
