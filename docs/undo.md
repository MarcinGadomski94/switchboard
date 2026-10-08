# Undo a turn (D80)

An agent's turn can leave a repo somewhere you did not want: files rewritten, new
files, commits. Before each turn Switchboard saves a **checkpoint** of every git
working tree the session uses, so any earlier turn can be reverted to, and the
revert itself undone (**Redo**). The conversation is never rewound: the agent is
told what happened with your next message.

Code: `src/server/checkpoints/` (`git.ts` the git side, `service.ts` the rest),
`src/core/checkpoints.ts` (names, texts, retention, wire shapes),
`src/web/views/session/RevertTurn.tsx` + `checkpoints.ts` (the UI). Decision: D80
in `docs/decisions.md`. Contract: `docs/handoff/contracts/local-api.md` →
*Undo a turn (D80)*.

## When a checkpoint is taken

When a supervised session's user message goes to its process (the task, a typed
message, a service message such as a todo reminder, "Continue."), before the
message is written: the supervisor calls `CheckpointService.capture`, writes the
message, then `record` gives the capture its refs and rows once the message's
event exists (the event's place among the session's user messages is the **turn
number**). A failing checkpoint never blocks the message: the session's last
problem is remembered and shown where a turn has no checkpoint.

Which working trees: the session's cwd (when it is in a git working tree), its
worktrees, and — like the session diff — the solutions of a workspace session
that it works on in place. Each is reduced to its top-level folder and taken once.
A folder that is no git repository gets no checkpoint; the turn action says why.

**Off switch:** Settings → Sessions → **Save a checkpoint before each turn**
(`sessions.checkpoints`, default on), read at every turn.

**Not for hooked terminal sessions.** Their `UserPromptSubmit` hook runs in the
background (`async`, D48 P4: hooks never delay the terminal), so a snapshot taken
from it races the turn's first edits and would not be "before" the turn. The
action says so; *Continue in Switchboard* (D72) makes such a session supervised,
and its later turns get checkpoints.

## How a checkpoint is built

D65's throw-away-index technique (`takeover/git.ts`), per working tree:

1. The developer's index file (`git rev-parse --git-path index`) is **copied** to a
   temp file, so git's stat cache makes the next step fast (no index: start from
   `HEAD`'s tree).
2. With `GIT_INDEX_FILE` = the copy: `git write-tree` (the **staged** state, kept as
   `index_tree` so a revert can restore it), then `git add -A` (every tracked and
   untracked file; `.gitignore`d files never) and `git write-tree` (the **files**).
3. `git commit-tree <tree> -p HEAD` (identity Switchboard, `commit.gpgsign=false`;
   no hooks run), unless the tree and HEAD equal the session's newest checkpoint
   there: then that commit is reused (identical trees are deduplicated).
4. `git update-ref refs/switchboard/checkpoints/<session>/<turn> <commit>` (a second
   working tree of the same repo in one turn: `<turn>-2`, …).

Only objects and that ref are written: the developer's index, HEAD, branch and
files are never touched (the tests byte-compare `git status --porcelain`, the
index file's hash, HEAD and every file). The refs are not branches (`git branch`,
`git log` and `git status` do not show them; `git log --all` and a `git push
--mirror` would). HEAD and the branch at that moment are recorded in
`turn_checkpoints` (migration 0034, `docs/database.md`).

Timing on a repo of 5,000 files (50 folders × 100, Apple silicon, `tests/server/checkpoints/service.test.ts`):
a snapshot ≈ 0.1 s, a turn's checkpoint (capture + ref) ≈ 0.15 s whether or not
something changed, a revert (safety checkpoint + restore) ≈ 0.5 s.

## Reverting

**Revert to before this turn** (the ↶ beside each user bubble; hover shows it, a
touch screen always) and **Undo last turn** (the session header; in the ⋯ menu on
narrow screens; the newest turn) open the confirmation:

- "Revert to before turn N?", the message's first line, "the changes of turns
  N..M are undone", and per working tree every file that changes (+ restored,
  ~ changed back, − removed; up to 200 listed, then "…and K more") and what
  happens to its branch.
- **Revert** (Cancel has the focus; Esc or a click outside cancels).

What a revert does, per working tree (all are checked before anything changes):

1. **Refused while a turn runs** (409 `turn-running`: stop it first). The action
   and *Undo last turn* are disabled meanwhile.
2. A **safety checkpoint** of the current state (`…/<session>/safety/<group>`), so
   the revert can be undone.
3. **The branch:** when the agent committed after the checkpoint, the branch is
   moved back to the recorded HEAD (`git update-ref -m "switchboard: revert to
   before turn N" refs/heads/<branch> <then> <now>`; the reflog keeps the old tip)
   **only if** it is the same branch, the recorded HEAD is an ancestor of today's,
   and none of the commits since is on a remote-tracking ref (not pushed).
   Otherwise the revert is refused with the reason (409 `files-only-needed`) and
   the dialog offers **Revert files only**, which leaves the branch where it is.
4. **The files** become the checkpoint's: files the checkpoint has are written
   back (from a throw-away index, `checkout-index`), files made since (and not
   ignored) are removed, with folders that end up empty. Ignored files are never
   touched: the diff is between two `add -A` trees, which never contain them.
5. **The index**: the staged state of the checkpoint when the branch was restored
   (or never moved); with files only, the index matches today's HEAD (the reverted
   files show as changes).
6. The chat gets the divider **Reverted to before turn N** (a lifecycle event,
   action `reverted`), and the agent gets, with its next message (queued in the
   outbox, kind `checkpoint-note`), "Switchboard reverted the files to before turn
   N (<first line of that message>); changes made in turns N..M are gone. Don't
   rely on them."

Any earlier turn with a checkpoint can be picked, several turns back.

## Redo

The newest revert's divider has **Redo** until a message is sent after it. Redo
takes its own safety checkpoint, puts the files back as they were just before the
revert, and moves the branch forward again when it can (same branch, and today's
HEAD is an ancestor of the one then; otherwise files only). The divider "Undid the
revert to before turn N" follows; the revert's note is withdrawn if the agent has
not got it yet, otherwise the agent is told the files are back.

## Retention

Per session: a turn's checkpoint is kept while it is **at most 7 days old and among
the last 100 turns** (whichever keeps fewer); safety checkpoints 7 days and the
newest 20. The prune runs hourly and at start; a **closed** session's checkpoints
go at once (a reopened session starts again with its next turn), a deleted
session's at the next prune. Refs are deleted; their objects are left to the repo's
own `git gc` (Switchboard never runs gc).

## Peers and phones

A paired machine's session: the routes go through the proxy (D48) and the
checkpoint, revert and Redo run on the machine the session runs on. Phones and
tablets (D73) may use all of it (normal use, with the confirm).

## Tests

`tests/server/checkpoints/service.test.ts` (the git side and the service: byte-identical index / HEAD / files after a checkpoint, tracked + untracked restored, later files removed, ignored files untouched, commits taken off the branch, pushed commits refused, files only, several turns back, Redo, retention, the 5,000-file timing), `tests/server/checkpoints/api.test.ts` (the real supervisor with fake-claude: the checkpoint before each turn, the routes, `turn-running`, the note on the next message's stdin, the allow-lists), `tests/server/peers/undo.test.ts` (through the proxy), `tests/web/undo.test.ts` (the dividers and the actions), `tests/e2e/undo.spec.ts` (the action, the confirmation, the divider and Redo, *Undo last turn*, a non-git folder, a phone).

## Known limits

- A message queued while a turn runs is checkpointed when it is sent, not when the
  agent takes it up; the running turn's later edits are part of that checkpoint.
- Files git does not track by design (ignored ones, a nested repo's content,
  submodules' working trees) are not part of a checkpoint and are never reverted.
- A revert that fails part-way (a file locked by another program) stops with the
  error; Redo brings back the state from before it.
