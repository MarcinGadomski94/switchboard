/**
 * D180 · what each turn changed: the contract between `src/server/api/turn-changes.ts` and
 * the v2 agent view (the "N files changed" chip under a turn's last reply, and the side
 * panel's "Last turn" / "Turn N" views of Changes). In `docs/handoff/contracts/local-api.md`.
 *
 * The data are the save points Switchboard takes before every turn (D80,
 * `docs/undo.md`) and the snapshots it takes when a turn ends (D90,
 * `src/server/worktrees/touched.ts`): a turn's changes are the difference between
 * its save point and where it ended. The end snapshots live in memory, so for a turn
 * that ended before the last restart the next save point stands in, and for the newest
 * such turn, the files as they are now.
 *
 * D180 (the developer, 2026-11-20): only this agent's files count: those its own edit tools
 * (Write, Edit, MultiEdit, NotebookEdit) named during the turn. In a working copy shared with
 * other agents or with you, their edits during the turn are left out; a file the agent changed
 * only through a shell command is left out too.
 *
 * Routes, for the loopback UI only (as the side panel's Files: refused to a paired
 * phone by name, not on the peer listener's list; a request for an agent of a paired
 * computer is forwarded there and refused by it, 409 `remote` is this server's own
 * answer when nothing forwards):
 *
 * - `GET /api/sessions/{id}/turn-changes` → {@link TurnChanges}
 * - `GET /api/sessions/{id}/turn-changes/diff?from=&to=` → `FileDiff[]` (`src/core/api.ts`):
 *   from before turn `from` until after turn `to`; without `to`, until now.
 *   `FileDiff.solution` is the working tree's folder name (with its parent folder in
 *   front when two trees share a name). 404 `no-checkpoint` when turn `from` has no
 *   save point, 404 `not-found`, 422 `invalid`, 500 `unreadable`.
 *
 * Reading "now" takes a snapshot the way a save point does (a throw-away index: the
 * developer's index, HEAD and files are untouched, git objects are written for
 * content git has not seen), so the UI reads these routes when turns change, not on
 * every event of a running turn.
 *
 * Known limits:
 * - A file this agent edited that another agent or you also edited during the same turn
 *   shows all of that file's changes (the comparison is per file, not per edit).
 * - The save points' own limits (`docs/undo.md` → *Known limits*): a repo the agent
 *   first edits during a turn has its first save point at the next turn, so that
 *   turn's edits there are not shown (the To review strip still counts them); a
 *   message queued while a turn runs is saved when it is sent, so the rest of the
 *   running turn's edits count to the next one; a terminal session and a folder that
 *   is no git repository have no save points at all.
 * - End snapshots are taken when a turn ends as idle or done, and kept in memory. A
 *   turn that failed or was paused, and every turn after a restart, ends at the next
 *   save point instead: a revert, a Redo or an edit by hand in between counts to it.
 * - `through` and "Turns N–M" can name a turn that is not counted yet (a message that
 *   is held, or whose save point is still being stored), and with several working
 *   trees the widest range of any of them is named.
 * - No cap on a diff's size, and no paging.
 */

/** What one turn changed in the agent's working trees. */
export interface TurnChange {
  /** The turn (1 = the agent's first message from you). */
  readonly turn: number;
  /** That message's event (the chat bubble the turn starts at), `null` when unknown. */
  readonly eventId: number | null;
  /** The last turn these changes cover: `turn` itself, or a later one when the turns between have no save point of their own. */
  readonly through: number;
  /** How many files differ. */
  readonly files: number;
  readonly added: number;
  readonly removed: number;
}

/** `GET /api/sessions/{id}/turn-changes`. */
export interface TurnChanges {
  /** The turns that changed files, oldest first. */
  readonly turns: readonly TurnChange[];
  /** The agent's newest turn (its messages from you so far). */
  readonly latestTurn: number;
}

/** `unreadable` (500): git could not read any of the agent's working trees (one that is merely gone is left out). */
export type TurnChangesErrorCode = 'not-found' | 'no-checkpoint' | 'remote' | 'invalid' | 'unreadable';

/** "Turn 4" / "Turns 4–6". */
export function turnsLabel(turn: number, through: number): string {
  return through > turn ? `Turns ${turn}–${through}` : `Turn ${turn}`;
}

/** "3 files changed" / "1 file changed". */
export function filesChangedText(files: number): string {
  return `${files} file${files === 1 ? '' : 's'} changed`;
}
