-- 0018 · the last known state of each paired machine's sessions (D48 ruling
-- D48-cache-persist: "keep snapshot but block interaction until reconnection").
-- peer_snapshots: what the peer last answered, raw (its own ids), so after a
-- restart of this service an unreachable machine's sessions stay listed and
-- readable; every interaction with them is refused until it is reached again,
-- and a reconnection replaces the snapshot with live data.
--   machine_id   the paired machine (deleted with it).
--   kind         `sessions` (its open sessions, key ''), `detail` (GET
--                /api/sessions/{id}, key = its session id) or `events` (GET
--                /api/sessions/{id}/events without `since`, key = its session id).
--   body         the peer's JSON answer, verbatim.
--   updated_at   when it was stored (ISO).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE peer_snapshots (
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (machine_id, kind, key)
) STRICT;
