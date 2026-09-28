/**
 * Closing and reopening sessions (D33, `docs/supervisor.md` → *Close and
 * reopen*): the rules and the copy shared by the server and the UI. Pure.
 *
 * A closed session (`Session.closedAt` set) leaves the sidebar's list
 * (`GET /api/sessions` leaves it out unless `?closed=include`) and the palette;
 * its process was stopped the way Pause stops it, so the conversation stays
 * resumable; its open questions and permission requests were closed with the
 * label {@link SESSION_CLOSED_REASON}; its worktrees and branches are kept.
 * History lists it with the {@link CLOSED_TAG} tag and a {@link REOPEN_LABEL}
 * action.
 */
import type { SessionStatus } from './model.ts';

/** The label a question batch closed with its session carries (`Question.closedReason`, `question_batches.closed_reason`). */
export const SESSION_CLOSED_REASON = 'session closed';

/** The refusal code of `POST /api/sessions/{id}/close` without `confirm` for a session that runs or waits (HTTP 409). */
export const CLOSE_NEEDS_CONFIRM = 'close-needs-confirm';

/** The refusal code of a message, Resume or Attach for a closed session (HTTP 409): reopen it first. */
export const SESSION_CLOSED = 'closed';

/** `?closed=` of `GET /api/sessions`: `exclude` (the default) lists open sessions only, `include` every session. */
export type ClosedFilter = 'exclude' | 'include';

/** The values `?closed=` accepts. */
export const CLOSED_FILTERS: readonly ClosedFilter[] = ['exclude', 'include'];

/** `?closed=` read: absent → `exclude`; `include` / `exclude` as given; anything else → `null` (the route answers 422). */
export function parseClosedFilter(value: unknown): ClosedFilter | null {
  if (value === undefined) return 'exclude';
  return typeof value === 'string' && (CLOSED_FILTERS as readonly string[]).includes(value) ? (value as ClosedFilter) : null;
}

/** What {@link isClosed} reads: `closedAt` (optional, as in the contract's `Session`). */
export interface Closable {
  readonly closedAt?: string | null;
}

/** `true` for a closed session (a `closedAt`). */
export function isClosed(session: Closable): boolean {
  return typeof session.closedAt === 'string';
}

/** The open sessions of a list, in its order (the sidebar and the palette show only these). */
export function openSessions<T extends Closable>(sessions: readonly T[]): T[] {
  return sessions.filter((session) => !isClosed(session));
}

/**
 * The server's rule: closing needs `confirm: true` when the session's process is
 * live, or when its status says it runs or waits for the developer (`run` /
 * `need`), since the close stops it.
 */
export function closeNeedsConfirm(session: { readonly live: boolean; readonly status: SessionStatus }): boolean {
  return session.live || session.status === 'run' || session.status === 'need';
}

/**
 * The UI's rule: closing asks the developer first when the session is running or
 * waiting (status `run` / `need`, or a turn runs: `activity` is set). A live
 * process that is idle between turns is stopped without asking (the close is
 * posted with `confirm: true`, since the server needs it for any live process).
 */
export function closeAsks(session: { readonly status: SessionStatus; readonly activity?: unknown }): boolean {
  return session.status === 'run' || session.status === 'need' || (session.activity !== null && session.activity !== undefined);
}

/** The Close action (session header; the sidebar row's × says it in its tooltip). */
export const CLOSE_LABEL = 'Close';

/** The sidebar row's × tooltip. */
export const CLOSE_TOOLTIP = 'Close (keeps it in History)';

/** The confirmation's buttons. */
export const STOP_AND_CLOSE = 'Stop & close';
export const CLOSE_CANCEL = 'Cancel';

/** The confirmation for a running or waiting session: "Stop <title> and close it? …". */
export function closeConfirmText(title: string): string {
  return `Stop ${title} and close it? Its conversation stays in History and can be reopened.`;
}

/** History's tag on a closed session's row. */
export const CLOSED_TAG = 'Closed';

/** History's action on a closed session's row. */
export const REOPEN_LABEL = 'Reopen';

/** What the chat shows for a question batch closed without answers (e.g. `Closed · session closed`). */
export function closedBatchText(reason: string): string {
  return `Closed · ${reason}`;
}
