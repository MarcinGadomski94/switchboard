-- 0007 · Remote Control on Switchboard's own sessions (D24, docs/remote-control.md).
-- sessions:
--   remote_available    what the live process's `initialize` reported
--                       (`remote_control_available`); set to 0 at every spawn and to
--                       the reply once it arrives. NULL = Switchboard never ran a
--                       process for the session (the demo's seeded rows): the API
--                       sends `remote: null` and the header shows no toggle. Rows from
--                       before this migration get 0.
--   remote_enabled      Remote is on: the live process has the bridge, and a new
--                       process (resume, restart recovery) reattaches it (D7).
--   remote_session_url  the claude.ai link of the last bridge (`session_url`); kept
--                       when Remote is turned off.
--   remote_bridge_id    its `cse_…` id (`bridge_session_id`), the `reattach_session_id`
--                       of the next enable; kept when Remote is turned off.
-- question_batches:
--   answered_on         `claude.ai` when the phone answered the batch first (the CLI
--                       withdrew the request with `control_cancel_request` while Remote
--                       was on); the batch is then `answered` without answers.
-- Numbered 0007: 0008 belongs to another change (D25) and neither depends on the other.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE sessions ADD COLUMN remote_available INTEGER CHECK (remote_available IN (0, 1));
ALTER TABLE sessions ADD COLUMN remote_enabled INTEGER NOT NULL DEFAULT 0 CHECK (remote_enabled IN (0, 1));
ALTER TABLE sessions ADD COLUMN remote_session_url TEXT;
ALTER TABLE sessions ADD COLUMN remote_bridge_id TEXT;

UPDATE sessions SET remote_available = 0;

ALTER TABLE question_batches ADD COLUMN answered_on TEXT;
