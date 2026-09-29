-- 0014 · a stacked worktree's parent closed without merging (D47 ruling
-- D47-closed-parent, "raise an Inbox item when the parent PR becomes CLOSED").
-- worktrees:
--   parent_closed_at  when the PR poll saw the parent's PR turn CLOSED (from any
--                     other state it had reported, or none); NULL otherwise, for a
--                     parent that was already closed when the worktree was made,
--                     and for every worktree before this migration. The "Parent …
--                     closed" Inbox item is raised once per worktree from it (also
--                     by the 30 s sync after a restart); the session gets no message.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE worktrees ADD COLUMN parent_closed_at TEXT;
