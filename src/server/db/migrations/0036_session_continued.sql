-- 0036 · continue a session in a fresh one when its context fills (D83, docs/fresh-session.md).
-- sessions:
--   continued_to    the id of the session this one was continued in (a new session in the same
--                   folder / worktree / branch, started with the agent's handover). Set on the OLD
--                   session, which is closed at the same time ("Continued in <new session>").
--                   NULL = not continued.
--   continued_from  the id of the session this one continues ("Continued from <old session>").
--                   Set on the NEW session. NULL = a session started any other way.
-- Plain ids (no foreign key, like schedule_id): deleting one session leaves the other's link,
-- which the API then reads as gone (no title).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE sessions ADD COLUMN continued_to TEXT;
ALTER TABLE sessions ADD COLUMN continued_from TEXT;
