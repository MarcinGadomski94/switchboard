-- 0011 · the session's worktree branch (D38, "a workspace session can start without
-- picked solutions; the agent determines them").
-- sessions:
--   branch   the branch the session's worktrees are on: the D32 ticket branch, or
--            `session/{name}` (scheduled runs), stored when the session starts with
--            Worktrees on; NULL without worktrees and for every session before this
--            migration. A session started without solutions creates no worktree up
--            front: its agent creates one per solution it changes, on this branch at
--            `<repo>-wt-<name>`, and Switchboard adopts every worktree on this branch
--            (or at that path) as the session's (docs/worktrees.md → Adopted
--            worktrees).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE sessions ADD COLUMN branch TEXT;
