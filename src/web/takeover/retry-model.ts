import type { MoveChoices, MoveRetry } from '../../core/moves.ts';
import type { MoveChoice } from './complete-move.ts';
import type { TakeoverRequest } from './takeover.ts';

/** D154 · Try again's pure parts (`retry.ts` reads this computer's id and opens the dialogs). */

/** The take-over dialog's request of a retry (the agent's Move / Move here). */
export function retryRequest(retry: MoveRetry): TakeoverRequest {
  return { sessionId: retry.sessionId, targetMachine: retry.targetMachine, machineName: retry.machineName, title: retry.title, retry: retry.choices };
}

/** The dialog's choice of a move's kept choices. */
export function choiceOfRetry(choices: MoveChoices): MoveChoice {
  return {
    placement: choices.placement,
    clonePaths: { ...choices.clonePaths },
    files: choices.workspaceFiles,
    ...(choices.excludeRepos.length > 0 ? { excludeRepos: [...choices.excludeRepos] } : {}),
    ...(choices.stashTargets.length > 0 ? { stashTargets: [...choices.stashTargets] } : {}),
  };
}
