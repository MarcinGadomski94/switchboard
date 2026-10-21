-- 0047 · D124: how a session's last turn ended, when it waits for the developer (docs/derivations.md →
-- Session status → Waiting for you at a turn's end).
-- sessions.turn_wait   JSON {status, ask, source, at}: the agent's turn_status declaration
--   (done / waiting_for_you / blocked, with its one-line ask) or the text check's detected
--   waiting_for_you; NULL = nothing (a new turn, Not waiting and a Dismiss of its Inbox item clear it).
--   Stored so a restart keeps "needs you".
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE sessions ADD COLUMN turn_wait TEXT;
