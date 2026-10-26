-- 0050 · D134 Usage breakdown (docs/insights.md → Usage breakdown): one row per turn, so the
-- "Where your usage went" view can align to each account's 5-hour / weekly window (to the minute,
-- with the account the session ran on when the turn ended) and page a log of turns, without
-- scanning events (they have no time index and no account). D108's daily rollup stays as it is.
-- insight_turns: one row per `result` event, added as each turn ends (the events repository's
--   rollup hook) and, for the last 8 days before this migration, by a background backfill.
--   event_id            the result event's id.
--   ts                  the result event's time (ISO 8601 UTC).
--   session_id, provider, model, profile_id, folder, kind
--                       as insight_turns_daily (0045): the session's CLI, the model key, the account
--                       profile, its root and kind, as they were when the turn ended.
--   input_tokens …      the turn's own replies (the result's `usage`); unsplit_tokens for results
--   unsplit_tokens      without a split (D78's total only).
--   agent_usage         JSON {model: {input, output, cacheWrite, cacheRead}}: the tokens of the turn's
--                       subagents, workflow agents and background calls (the growth of the CLI's
--                       cumulative `modelUsage` since the session's previous turn, minus `usage`);
--                       '{}' when none or not known.
--   model_totals        JSON: the CLI's cumulative `modelUsage` at this turn (the next turn's baseline);
--                       NULL when the result carried none.
--   duration_ms         the result's duration_ms.
-- insight_state turns.upto = the newest event id when this migration ran: events after it are added
--   by their write, the backfill reads events up to it (turns.done = its progress; it starts at the
--   first event of the last 8 days, found when it first runs).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE insight_turns (
  event_id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'session' CHECK (kind IN ('session', 'chat')),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  unsplit_tokens INTEGER NOT NULL DEFAULT 0,
  agent_usage TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(agent_usage)),
  model_totals TEXT CHECK (model_totals IS NULL OR json_valid(model_totals)),
  duration_ms INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX insight_turns_ts ON insight_turns (ts);
CREATE INDEX insight_turns_profile_ts ON insight_turns (profile_id, ts);
CREATE INDEX insight_turns_session ON insight_turns (session_id, event_id);

INSERT INTO insight_state (key, value) VALUES ('turns.upto', CAST((SELECT COALESCE(MAX(id), 0) FROM events) AS TEXT));
