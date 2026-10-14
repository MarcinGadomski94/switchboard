-- 0045 · Insights (D108, docs/insights.md): a daily rollup of the turns, so the page never scans events.
-- insight_turns_daily: one row per UTC day × session × CLI × model × account, added to as each turn ends
--   (a `result` event) and by the background backfill for the events written before this migration.
--   day                YYYY-MM-DD (UTC) of the result event's ts.
--   provider, model,   the session's CLI, the model the CLI reported for the turn (else the session's
--   profile_id         chosen model, '' = the CLI's default) and its account profile (a session without
--                      one: the CLI's built-in 'default-<cli>'), as
--                      they were when the turn ended (the backfill: as the session is now).
--   folder, kind       the session's root ('' without one) and kind ('session' | 'chat').
--   turns              result events; error_turns those with is_error.
--   tokens             D78's tokens (input + cache creation + output; cache reads left out).
--   input_tokens …     the split, from the result payload's `usage` (recorded from 0045 on);
--   unsplit_tokens     tokens of results without a split (older results: D78's total only).
--   duration_ms        the results' duration_ms, summed.
--   reverts, redos     D80 lifecycle events ('reverted' / 'revert-undone') that day.
-- insight_state: the backfill's progress. events.upto = the newest event id when this migration ran:
--   every event after it is rolled up by its write, every one up to it by the backfill.
-- todo_actuals gains what a completed todo needs for Insights: its run session, priority, CLI / model /
--   account (of the session that worked on it), its tokens by kind (`usage`, JSON; older rows carry
--   their D78 total as `unsplit`) and session_todos gains actual_usage (accumulated per span like
--   actual_tokens). todo_reopens records each done → open / in progress (from 0045 on).
-- usage_readings gets an index per account for the forecast.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE insight_turns_daily (
  day TEXT NOT NULL,
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'session' CHECK (kind IN ('session', 'chat')),
  turns INTEGER NOT NULL DEFAULT 0,
  error_turns INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  unsplit_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  reverts INTEGER NOT NULL DEFAULT 0,
  redos INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, session_id, provider, model, profile_id)
) STRICT;

CREATE TABLE insight_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

INSERT INTO insight_state (key, value) VALUES ('events.upto', CAST((SELECT COALESCE(MAX(id), 0) FROM events) AS TEXT));
INSERT INTO insight_state (key, value) VALUES ('events.done', '0');

ALTER TABLE session_todos ADD COLUMN actual_usage TEXT CHECK (actual_usage IS NULL OR json_valid(actual_usage));

ALTER TABLE todo_actuals ADD COLUMN run_session_id TEXT;
ALTER TABLE todo_actuals ADD COLUMN priority TEXT;
ALTER TABLE todo_actuals ADD COLUMN provider TEXT;
ALTER TABLE todo_actuals ADD COLUMN model TEXT;
ALTER TABLE todo_actuals ADD COLUMN profile_id TEXT;
ALTER TABLE todo_actuals ADD COLUMN usage TEXT CHECK (usage IS NULL OR json_valid(usage));

UPDATE todo_actuals SET
  run_session_id = (SELECT t.run_session_id FROM session_todos t WHERE t.id = todo_actuals.todo_id),
  priority = (SELECT t.priority FROM session_todos t WHERE t.id = todo_actuals.todo_id);
UPDATE todo_actuals SET
  provider = (SELECT s.provider FROM sessions s WHERE s.id = COALESCE(todo_actuals.run_session_id, todo_actuals.session_id)),
  model = (SELECT COALESCE(s.model, '') FROM sessions s WHERE s.id = COALESCE(todo_actuals.run_session_id, todo_actuals.session_id)),
  profile_id = (SELECT COALESCE(s.profile_id, 'default-' || s.provider) FROM sessions s WHERE s.id = COALESCE(todo_actuals.run_session_id, todo_actuals.session_id)),
  usage = CASE WHEN actual_tokens IS NULL THEN NULL ELSE json_object('input', 0, 'output', 0, 'cacheWrite', 0, 'cacheRead', 0, 'unsplit', actual_tokens) END;

CREATE INDEX todo_actuals_completed ON todo_actuals (completed_at);

CREATE TABLE todo_reopens (
  id INTEGER PRIMARY KEY,
  todo_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  reopened_at TEXT NOT NULL
) STRICT;
CREATE INDEX todo_reopens_todo ON todo_reopens (todo_id);

CREATE INDEX usage_readings_profile ON usage_readings (profile_id, received_at);
