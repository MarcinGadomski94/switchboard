-- 0025 · taking a session over to another paired machine (D65, docs/peers.md → Taking a session over).
-- sessions:
--   moved_to    JSON { machineId, machineName, sessionId, at } on the SOURCE session once its
--               conversation and files were taken over: the session is closed (read-only) and
--               shows "Moved to <machine>" with a link to the new session there (machineId is
--               the other machine's own id, so its remote id is r~<machineId>~<sessionId>).
--               NULL = the session was not moved away.
--   moved_from  JSON { machineId, machineName, sessionId, at } on the NEW session: where it came
--               from (the chat's "Taken over from <machine>" divider and the header note).
--               NULL = the session was not taken over from another machine.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE sessions ADD COLUMN moved_to TEXT;
ALTER TABLE sessions ADD COLUMN moved_from TEXT;
