-- 0012 · the session's epic/task branching (D40, "the New-session form supports the
-- epic/task branching model (lazy)").
-- sessions:
--   branching   JSON { epic: { key, summary, branch } | null, base, bases, dropped }:
--               how the session's task worktrees are branched, stored when it
--               starts with Worktrees on under the ticket rule (D32); NULL without
--               worktrees, for scheduled runs (`session/{name}`) and for every
--               session before this migration. `epic` = the epic's ticket key,
--               summary and branch (`feature/<KEY>-<Summary>`), NULL for a task
--               without an epic; `base` = the epic's base on origin (`dev`);
--               `bases` = per-solution base overrides; `dropped` = solutions
--               dropped from the task. Worktrees its agent creates later (D38) are
--               adopted with the base they were cut from (`origin/<epic>` or
--               `origin/<base>`; the origin default branch without an epic), also
--               after a restart (docs/worktrees.md → Epic/task branching (D40)).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE sessions ADD COLUMN branching TEXT;
