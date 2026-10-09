-- 0041 · Switchboard-owned loops (D94, docs/loops.md): recurring or one-shot prompts that
-- Switchboard itself sends into a session (instead of the CLI's own /loop or CronCreate jobs).
-- session_loops:
--   id              10 hex characters (the service makes them).
--   session_id      the session the prompt is sent to; the rows go with the session.
--   label           a short name for the card and the chat's chip; NULL = derived from the prompt.
--   prompt          the message sent at each firing (origin service).
--   schedule_kind   cron | every | at.
--   schedule_value  the normalized cron expression, the interval in minutes, or the ISO time of a one-shot.
--   expires_at      no firing at or after it (NULL = no expiry: until cancelled).
--   max_runs        it ends after this many firings (NULL = no limit).
--   state           active | paused | ended; ended_reason says why it ended.
--   runs            firings sent; skipped = due times not sent (a firing still waiting, Switchboard
--                   not running, the session busy switching, …).
--   last_fired_at   when the last firing was sent; last_event_id = its chat message (a firing the
--                   agent has not taken up yet holds the next one back).
--   last_error      why the last due time was skipped (NULL when it was sent).
--   next_fire_at    the next due time (NULL while paused or ended).
--   created_by      agent | developer.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE session_loops (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  label TEXT,
  prompt TEXT NOT NULL,
  schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('cron', 'every', 'at')),
  schedule_value TEXT NOT NULL,
  expires_at TEXT,
  max_runs INTEGER,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused', 'ended')),
  ended_reason TEXT,
  runs INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  last_fired_at TEXT,
  last_event_id INTEGER,
  last_error TEXT,
  next_fire_at TEXT,
  created_by TEXT NOT NULL DEFAULT 'agent' CHECK (created_by IN ('agent', 'developer')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX session_loops_session ON session_loops (session_id);
