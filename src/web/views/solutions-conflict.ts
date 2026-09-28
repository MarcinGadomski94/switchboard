import type { Solution } from '../../core/api.ts';
import { conflictText, moveLabel } from '../../core/conflicts.ts';
import { displayTitle } from '../../core/session-title.ts';
import { branchFromTitle } from '../../core/ticket-branch.ts';
import { ApiError } from '../api/client.ts';

/**
 * Pure view logic of the Solutions conflict card (M6.3, SPEC → Solutions:
 * "conflict warning card with a 'Move … to worktree' action"). Copy is the
 * prototype's (`sd.warn` and the card's button). D32: the action asks for the
 * new worktree's branch in a confirm step ({@link moveConfirmText},
 * {@link MoveAction.suggestedBranch}).
 */

/** One "Move … to worktree" action of the card. */
export interface MoveAction {
  readonly sessionId: string;
  /** The `{repo}` of `POST /api/solutions/{repo}/isolate`. */
  readonly repo: string;
  readonly label: string;
  /** A detached session cannot be isolated until it is attached again (409 `detached`). */
  readonly disabled: boolean;
  /** Why the action is disabled; empty otherwise. */
  readonly title: string;
  /** D32: the session's display title, which the confirm step names it by. */
  readonly sessionTitle: string;
  /** D32: what the confirm step's Branch field starts with: the title's ticket branch (`branchFromTitle`), else empty. */
  readonly suggestedBranch: string;
}

/** The card of a solution with a conflict, `null` without one. */
export interface ConflictCard {
  readonly text: string;
  /** One per session writing the main checkout, oldest first. */
  readonly actions: readonly MoveAction[];
}

/** The conflict card's text and actions for `solution`, `null` when it has no conflict. */
export function conflictCard(solution: Pick<Solution, 'conflict' | 'conflictSessions' | 'relativePath'>): ConflictCard | null {
  if (!solution.conflict || solution.conflictSessions.length === 0) return null;
  return {
    text: conflictText(solution.conflictSessions, solution.relativePath),
    actions: solution.conflictSessions
      .filter((session) => !session.isolated)
      .map((session) => ({
        sessionId: session.sessionId,
        repo: session.repo,
        // D22: named by the display title; the worktree and branch still come from the short name.
        label: moveLabel(displayTitle(session)),
        disabled: !session.attached,
        title: session.attached ? '' : `${displayTitle(session)} continues in a terminal; attach it here first`,
        sessionTitle: displayTitle(session),
        suggestedBranch: branchFromTitle(session.title ?? '') ?? '',
      })),
  };
}

/** D32: the confirm step's line above its Branch field. */
export function moveConfirmText(action: Pick<MoveAction, 'sessionTitle' | 'repo'>): string {
  return `${action.sessionTitle} gets a new worktree of ${action.repo}. Name its branch after the ticket:`;
}

/** D32: the confirm step's button. */
export const MOVE_CONFIRM = 'Move to worktree';

/** The message of a failed "Move … to worktree" (the server's refusal, verbatim when it gives one). */
export function isolateErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : String(error);
  if (error.unreachable) return 'Switchboard is not reachable.';
  const body = error.body as { message?: unknown; errors?: Array<{ message?: unknown }> } | null;
  if (typeof body?.message === 'string' && body.message) return body.message;
  const first = body?.errors?.[0]?.message;
  if (typeof first === 'string' && first) return first;
  return `The worktree could not be created (HTTP ${error.status}).`;
}
