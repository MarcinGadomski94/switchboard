import type { Session, SessionListItem, TurnWait } from '../../../core/api.ts';
import { turnWaits } from '../../../core/derive/turn-status.ts';

/**
 * D124 (`docs/derivations.md` → *Session status* → *Waiting for you at a turn's end*): the
 * session's needs-you line when its turn ended waiting for the developer (its agent's
 * `turn_status`, or the text check): `null` while it works, has an open question (that one shows
 * in the chat and the Inbox) or its turn did not wait.
 */
export function needsYouOf(session: Pick<Session | SessionListItem, 'status' | 'turnWait' | 'closedAt'> | null | undefined): (TurnWait & { readonly status: 'waiting_for_you' | 'blocked' }) | null {
  if (!session || session.status !== 'need' || session.closedAt) return null;
  return turnWaits(session.turnWait) ? session.turnWait : null;
}

/** The words before the ask: "Needs you" (waiting for the developer) or "Blocked". */
export function needsYouWord(wait: Pick<TurnWait, 'status'>): string {
  return wait.status === 'blocked' ? 'Blocked' : 'Needs you';
}

/** The tooltip of a detected wait (the text check read the agent's last message as a question). */
export const DETECTED_HINT = "Detected from the agent's last message (it did not say so itself). Not waiting clears it for this turn.";

/** The tooltip of Not waiting. */
export const NOT_WAITING_HINT = 'The agent is not waiting for you: clear "needs you" for this turn.';

/**
 * D124: `true` while a turn runs or waits on a question / permission (`run`, or a `need` that is
 * not the turn's own wait for the developer): what Stop, the queued-send clock and the fresh
 * offer read. A turn that ended waiting for you is over: a message goes to the agent at once.
 */
export function turnBusy(session: Pick<Session | SessionListItem, 'status' | 'turnWait'>): boolean {
  return session.status === 'run' || (session.status === 'need' && !turnWaits(session.turnWait));
}
