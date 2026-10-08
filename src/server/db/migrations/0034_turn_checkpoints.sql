-- 0034 · checkpoints before each turn, to undo a turn (D80, docs/undo.md).
-- turn_checkpoints: the index of the hidden git refs Switchboard keeps of a session's working trees.
-- One row per working tree per capture (a turn's capture covers every git working tree the session
-- uses: its cwd repo and its worktrees).
--   session_id   the session (no foreign key: the rows of a deleted session stay until the next prune,
--                which deletes their refs first; a cascade would leave the refs behind).
--   kind         turn          taken before the turn's user message went to the process;
--                before-revert the state just before a revert (so Redo can bring it back);
--                before-redo   the state just before a Redo.
--   turn_seq     the turn: the user message's place among the session's user messages (1 = the first).
--                For before-revert / before-redo: the turn the revert went back to.
--   event_id     turn: the user message's event; before-revert / before-redo: the chat divider's event
--                (NULL until it is written).
--   group_id     the rows of one capture share it (a revert works on a whole group).
--   repo_path    the working tree's top-level folder (a repo or a worktree).
--   ref          the hidden ref (refs/switchboard/checkpoints/<session>/<turn>, …/safety/<group>).
--   commit_sha   the checkpoint commit (tree = tracked + untracked, never ignored files; parent = head).
--   tree         the commit's tree (identical trees are deduplicated by git; unchanged turns reuse the commit).
--   index_tree   the tree of the developer's index (staged state) at that moment; NULL when it could not
--                be written (an unmerged index).
--   head         HEAD's commit at that moment; NULL when the repo had no commit yet.
--   branch       the checked-out branch; NULL for a detached HEAD.
--   created_at   (ISO) retention: 7 days or the last 100 turns per session, whichever keeps fewer.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE turn_checkpoints (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('turn', 'before-revert', 'before-redo')),
  turn_seq INTEGER NOT NULL CHECK (turn_seq >= 1),
  event_id INTEGER,
  group_id TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  ref TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  tree TEXT NOT NULL,
  index_tree TEXT,
  head TEXT,
  branch TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX turn_checkpoints_session ON turn_checkpoints (session_id, turn_seq);
CREATE INDEX turn_checkpoints_group ON turn_checkpoints (group_id);
CREATE INDEX turn_checkpoints_created ON turn_checkpoints (created_at);
