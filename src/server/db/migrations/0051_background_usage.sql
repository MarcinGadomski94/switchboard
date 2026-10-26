-- 0051 · D136 Project memory checks (docs/memory.md → Checking notes; docs/insights.md → Usage
-- breakdown): token use of work Switchboard runs by itself without a session, so Insights → Usage
-- shows its cost. Today only the memory checks (the proposal check and the periodic check per
-- folder): short-lived headless CLI runs that have no sessions row and no events.
-- insight_background_turns: one row per run and model.
--   id              its own id (the usage rows show it as a negative event id, never an events id).
--   ts              when the run ended (ISO 8601 UTC).
--   kind            memory-check.
--   provider, model, profile_id, folder
--                   the CLI, the model the run reported, the account profile it ran on, the folder.
--   input_tokens …  the run's tokens of that model (cache reads apart, as in insight_turns).
--   duration_ms     the run's duration.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE insight_background_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('memory-check')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX insight_background_turns_ts ON insight_background_turns (ts);
