-- 0008 · the remote session a session is a local copy of (D25, "From a remote
-- session"): `claude -p --teleport <session_X>` in a new worktree of a repo
-- folder made the session, and `remote_source` keeps that remote session's id in
-- its `session_<X>` form (`cse_<X>` is the same session, docs/spike-remote.md →
-- R.8). NULL for every other session, and for every session started before this
-- migration. The UI tags such a session "remote · local copy". The branch the
-- teleport checked out is kept on the session's worktree row (`worktrees.branch`).
-- docs/database.md.
-- Numbered 0008: 0007 belongs to another change (D24, Remote Control) and this one
-- does not depend on it; the runner accepts the gap.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE sessions ADD COLUMN remote_source TEXT;
