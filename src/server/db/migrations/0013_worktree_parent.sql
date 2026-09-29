-- 0013 · the parent a stacked task worktree watches (D47, "stacked task branches").
-- worktrees:
--   parent_branch     the parent task branch this worktree's branch is stacked on
--                     in its repo (the origin branch the typed parent resolved to
--                     when the worktree was made or adopted); NULL when the task is
--                     not stacked in this repo (the epic, D40) and for every
--                     worktree before this migration. The PR poller also watches
--                     `gh pr view <parent_branch>` for these rows.
--   parent_pr_number, parent_pr_url, parent_pr_state
--                     the parent's PR as gh last reported it (state verbatim:
--                     OPEN / CLOSED / MERGED); NULL while unknown or without a PR.
--   parent_base       the parent PR's baseRefName (where the child goes once the
--                     parent merges).
--   parent_head_oid   the parent's head commit as gh last reported it, else the
--                     commit the worktree was cut from ("the old parent tip" of the
--                     `git rebase --onto` after a squash merge).
--   parent_merge      how the parent merged: merge (its tip is in origin/<base>),
--                     squash (it is not) or unknown; set with parent_merged_at.
--   parent_merged_at  when Switchboard saw the parent's PR MERGED; the "Parent …
--                     merged" Inbox item (and the session message) is raised once
--                     per worktree from it (docs/worktrees.md → Stacked task branches (D47)).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE worktrees ADD COLUMN parent_branch TEXT;
ALTER TABLE worktrees ADD COLUMN parent_pr_number INTEGER;
ALTER TABLE worktrees ADD COLUMN parent_pr_url TEXT;
ALTER TABLE worktrees ADD COLUMN parent_pr_state TEXT;
ALTER TABLE worktrees ADD COLUMN parent_base TEXT;
ALTER TABLE worktrees ADD COLUMN parent_head_oid TEXT;
ALTER TABLE worktrees ADD COLUMN parent_merge TEXT;
ALTER TABLE worktrees ADD COLUMN parent_merged_at TEXT;
