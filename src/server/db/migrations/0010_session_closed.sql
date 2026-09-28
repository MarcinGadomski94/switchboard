-- 0010 · closed sessions (D33, "sessions can be closed out of the sidebar and
-- reopened from History").
-- sessions:
--   closed_at       when the developer closed the session (ISO); NULL = open, as
--                   for every session before this migration. A closed session is
--                   left out of the sidebar's list (`GET /api/sessions`) and the
--                   palette, its process was stopped the way Pause stops it (the
--                   conversation stays resumable), restart recovery never resumes
--                   it, and History lists it with a "Closed" tag. Reopen clears it.
--                   Its worktrees and branches are kept.
-- question_batches:
--   closed_reason   why a batch that still waited for the developer was closed
--                   without answers (`session closed`: its session was closed). The
--                   batch is `stale` (the stale path), no longer waits (it leaves the
--                   Inbox and the session's open question count) and can no longer
--                   be answered. NULL for every other batch.
-- docs/database.md, docs/supervisor.md → Close and reopen.
-- Numbered 0010: 0009 belongs to another change (D31) and neither depends on the
-- other; the runner accepts the gap.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE sessions ADD COLUMN closed_at TEXT;

ALTER TABLE question_batches ADD COLUMN closed_reason TEXT;
