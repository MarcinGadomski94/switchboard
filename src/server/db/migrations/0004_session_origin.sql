-- 0004 · where a session came from (D16): started in Switchboard, or moved in
-- from a terminal ("Continue in Switchboard"). A moved session has no
-- session-start answers, so its mode line reads "terminal · moved" instead of an
-- empty one (developer ruling 2026-09-28). Sessions moved before this migration
-- are found by their `moved` lifecycle event. docs/database.md.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'switchboard' CHECK (origin IN ('switchboard', 'terminal'));

UPDATE sessions SET origin = 'terminal'
 WHERE id IN (
   SELECT session_id FROM events
    WHERE json_extract(payload, '$.type') = 'lifecycle' AND json_extract(payload, '$.action') = 'moved'
 );
