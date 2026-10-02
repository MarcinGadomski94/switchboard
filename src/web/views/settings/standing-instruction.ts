import { DEFAULT_STANDING_INSTRUCTION, STANDING_INSTRUCTION_MAX } from '../../../core/settings.ts';

/**
 * Pure view logic of the "Standing instruction for agents" setting (D64,
 * `docs/settings.md`): what the buttons may do for a stored value and a draft.
 */

export const STANDING_INSTRUCTION_LABEL = 'Standing instruction for agents';

/** Under the field: when a change applies. */
export const STANDING_INSTRUCTION_DESCRIPTION =
  'Given to the agent of every session (Claude Code, Codex, OpenCode). A change applies to sessions started or resumed afterwards, not to running ones. Empty passes nothing.';

/** What the field's buttons may do. */
export interface StandingDraftState {
  /** The draft differs from what is stored: Save is offered. */
  readonly dirty: boolean;
  /** The draft is longer than the service accepts. */
  readonly tooLong: boolean;
  /** Save is enabled. */
  readonly canSave: boolean;
  /** The stored text is not the default: Reset to default is enabled. */
  readonly canReset: boolean;
}

/** The buttons' state for the stored text and the text in the field. */
export function standingDraftState(stored: string, draft: string): StandingDraftState {
  const dirty = draft !== stored;
  const tooLong = draft.length > STANDING_INSTRUCTION_MAX;
  return { dirty, tooLong, canSave: dirty && !tooLong, canReset: stored !== DEFAULT_STANDING_INSTRUCTION || draft !== DEFAULT_STANDING_INSTRUCTION };
}
