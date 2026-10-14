-- 0044 · chats: a conversation to think and plan in, not a development session (D106, docs/chats.md).
-- sessions:
--   kind     'session' (every row before 0044, and every development session) or 'chat'. A chat
--            runs in its own empty scratch folder (<dataDir>/chats/<id>/) in the CLI's read-only /
--            plan mode; it is listed under CHATS, not SESSIONS.
--   look_at  JSON array of the folders a chat may read for planning (canonical absolute paths),
--            given to its CLI as extra read-only directories. '[]' for every session.
-- The "continued as <session>" link of a chat reuses 0036's continued_to / continued_from.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'session' CHECK (kind IN ('session', 'chat'));
ALTER TABLE sessions ADD COLUMN look_at TEXT NOT NULL DEFAULT '[]';
