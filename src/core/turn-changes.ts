/**
 * SPIKE · side panel, 2026-11-18: what each turn changed. A throwaway contract between
 * `src/server/api/turn-changes.ts` and the v2 agent view (the "N files changed" chip
 * under a reply, and the Changes panel's "This turn" and "Since your review" views).
 * Not a decision yet, and not in `docs/handoff/contracts/local-api.md`.
 *
 * The data are the save points Switchboard takes before every turn (D80,
 * `docs/undo.md`) and the snapshots it takes when a turn ends (D90,
 * `src/server/worktrees/touched.ts`): a turn's changes are the difference between
 * its save point and where it ended. The end snapshots live in memory, so for a turn
 * that ended before the last restart the next save point stands in (what you changed
 * by hand in between then counts to that turn), and for the newest such turn, the
 * files as they are now. Whatever changed the files during a turn counts (the agent's
 * tools, its commands, or you by hand).
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
 * Known limits, found by review and not solved here:
 * - Whole working trees are compared. In a tree the agent shares with other agents or
 *   with you (it works "in place"), their changes during the turn, and for "since your
 *   review" until now, count too. The Diff's own view narrows such a tree to the files
 *   the agent touched (D90); this does not.
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
 * - `reviewFrom` is the newest turn with a save point that began before the review's
 *   first turn ended: when that first turn has no save point of its own, an earlier,
 *   already reviewed turn is included.
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
  /**
   * D166: the turn the pending review starts at ("since your last review" = from
   * before this turn until now); `null` without a pending review, or without a save
   * point from before its first turn ended.
   */
  readonly reviewFrom: number | null;
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
