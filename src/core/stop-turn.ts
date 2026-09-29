/**
 * D50 · Stop the current turn (`docs/decisions.md` → D50, `docs/supervisor.md` →
 * *Stop the current turn*, `docs/chat.md` → *Stop*): the rules and the copy shared
 * by the server and the UI. Pure.
 *
 * Stop interrupts the running turn only (the stdin `interrupt` control request with
 * `cancel_queued: true`); the process stays alive and the session becomes idle,
 * ready for the next message. Unlike Pause (D7) nothing ends. Messages the agent
 * had not taken up yet are withdrawn: the CLI drops them, and their text goes back
 * into the composer.
 */

/** The chat's small line for a stopped turn (the interrupted turn's result event label). */
export const STOPPED_LABEL = 'Stopped';

/** The composer's button while a turn runs. */
export const STOP_LABEL = 'Stop';

/** The button while Switchboard waits for the CLI to acknowledge the Stop. */
export const STOPPING_LABEL = 'Stopping…';

/** The button's tooltip. */
export const STOP_TOOLTIP = 'Stop the current turn (Esc)';

/** The composer's note when the CLI did not acknowledge a Stop in time (the chat has the error line too). */
export const STOP_TIMEOUT_NOTE = 'The agent did not stop in time. Pause ends the process.';

/** The composer's offer next to {@link STOP_TIMEOUT_NOTE}. */
export const STOP_TIMEOUT_PAUSE = 'Pause';

/** How the stopped turn's result reads, for {@link isInterruptedResult}. */
export interface ResultShape {
  readonly subtype: string;
  readonly isError: boolean;
  readonly terminalReason: string | null;
}

/**
 * `true` for the result of a turn the CLI aborted on an interrupt: an error
 * result with `terminal_reason` `aborted_streaming` / `aborted_tools` (M0.1: between
 * tool calls or while streaming / during a running tool), or, without a terminal
 * reason, `error_during_execution`.
 */
export function isInterruptedResult(result: ResultShape): boolean {
  if (!result.isError) return false;
  if (result.terminalReason !== null) return result.terminalReason.startsWith('aborted');
  return result.subtype === 'error_during_execution';
}

/**
 * The composer's text after a Stop gave back `withdrawn` messages (oldest first):
 * each message in order, separated by a blank line; text the developer already had
 * in the field comes after them, also after a blank line (it was typed later).
 */
export function withdrawnDraft(withdrawn: readonly string[], draft: string): string {
  const parts = withdrawn.filter((text) => text.trim() !== '');
  if (draft.trim() !== '') parts.push(draft);
  return parts.join('\n\n');
}

/** The error line when the CLI did not acknowledge a Stop in time (seconds, rounded up). */
export function stopTimeoutText(waitedMs: number): string {
  return `Stop: the agent did not stop within ${Math.ceil(waitedMs / 1000)} s. Pause ends the process.`;
}
