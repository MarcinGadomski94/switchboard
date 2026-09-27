-- 0001 · initial schema (M1.3)
-- Every entity of docs/handoff/ARCHITECTURE.md → "Data model", plus the fields the
-- M0 spike added (ARCHITECTURE → "Claude Code integration" → "Stored state"), the
-- Inbox's permission requests (D6) and system items (M3.3). Conventions are in
-- docs/database.md: STRICT tables, snake_case columns, timestamps as ISO 8601 UTC
-- text, JSON in TEXT columns checked with json_valid (lists also with json_type),
-- booleans as 0/1, CHECK only on enumerations locked by the contract or the
-- architecture data model.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE schedules (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT NOT NULL DEFAULT '',
  cron         TEXT NOT NULL,
  -- session config (NewSession shape) + prompt
  template     TEXT NOT NULL CHECK (json_valid(template)),
  paused       INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id                         TEXT PRIMARY KEY,
  name                       TEXT NOT NULL UNIQUE,
  task                       TEXT NOT NULL DEFAULT '',
  claude_session_id          TEXT NOT NULL UNIQUE,
  status                     TEXT NOT NULL DEFAULT 'idle'
                             CHECK (status IN ('need', 'run', 'done', 'fail', 'idle', 'paused')),
  work_type                  TEXT CHECK (work_type IN ('feature', 'qa')),
  mode                       TEXT CHECK (mode IN ('single', 'orchestrator')),
  phase                      TEXT CHECK (phase IN ('ui-first', 'integration')),
  coordination               TEXT CHECK (coordination IN ('sequential', 'parallel-twin', 'none')),
  qa_stack                   TEXT CHECK (qa_stack IN ('web', 'mobile', 'both')),
  qa_confluence_url          TEXT,
  qa_figma_urls              TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(qa_figma_urls) AND json_type(qa_figma_urls) = 'array'),
  -- solution names in scope, in the order chosen
  solutions                  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(solutions) AND json_type(solutions) = 'array'),
  worktrees                  INTEGER NOT NULL DEFAULT 0 CHECK (worktrees IN (0, 1)),
  ultracode                  INTEGER NOT NULL DEFAULT 0 CHECK (ultracode IN (0, 1)),
  attached                   INTEGER NOT NULL DEFAULT 1 CHECK (attached IN (0, 1)),
  -- the claude process: cwd it runs in, pid while live
  cwd                        TEXT,
  pid                        INTEGER,
  requested_permission_mode  TEXT,
  observed_permission_mode   TEXT,
  cli_version                TEXT,
  -- sync point for Attach (last transcript entry Switchboard has)
  last_transcript_uuid       TEXT,
  -- set while a Switchboard-initiated stop runs (pause | detach | restart | stop)
  stop_reason                TEXT,
  schedule_id                TEXT REFERENCES schedules (id) ON DELETE SET NULL,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  last_activity_at           TEXT,
  detached_at                TEXT,
  ended_at                   TEXT
) STRICT;
CREATE INDEX sessions_status ON sessions (status);

CREATE TABLE agents (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  -- main | subagent | workflow (gap #8)
  kind           TEXT NOT NULL DEFAULT 'subagent',
  name           TEXT NOT NULL,
  description    TEXT,
  solution_path  TEXT,
  branch         TEXT,
  status         TEXT NOT NULL DEFAULT 'run',
  status_text    TEXT,
  -- the Agent/Task tool_use that started it, the CLI task id, its subagent_type
  tool_use_id    TEXT,
  task_id        TEXT,
  subagent_type  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  ended_at       TEXT
) STRICT;
CREATE INDEX agents_session ON agents (session_id);
CREATE UNIQUE INDEX agents_tool_use ON agents (session_id, tool_use_id) WHERE tool_use_id IS NOT NULL;
CREATE INDEX agents_task ON agents (session_id, task_id) WHERE task_id IS NOT NULL;

CREATE TABLE events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  agent_id     TEXT REFERENCES agents (id) ON DELETE SET NULL,
  ts           TEXT NOT NULL,
  -- end of a timeline block (a tool_use finished by its tool_result)
  end_ts       TEXT,
  kind         TEXT NOT NULL
               CHECK (kind IN ('plan', 'impl', 'loop', 'ask', 'ok', 'tool', 'text', 'error')),
  label        TEXT NOT NULL DEFAULT '',
  payload      TEXT CHECK (payload IS NULL OR json_valid(payload)),
  -- stream-json / transcript identifiers: dedupe on import, merge and pairing
  uuid         TEXT,
  message_id   TEXT,
  tool_use_id  TEXT
) STRICT;
CREATE INDEX events_session_ts ON events (session_id, ts, id);
CREATE INDEX events_uuid ON events (session_id, uuid) WHERE uuid IS NOT NULL;
CREATE INDEX events_tool_use ON events (session_id, tool_use_id) WHERE tool_use_id IS NOT NULL;

-- One AskUserQuestion control_request = one batch (id = request_id = batchId).
CREATE TABLE question_batches (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  tool_use_id    TEXT,
  -- the tool input verbatim; the answer is this input unchanged + answers
  input          TEXT NOT NULL CHECK (json_valid(input)),
  state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'answered', 'stale')),
  created_at     TEXT NOT NULL,
  answered_at    TEXT,
  stale_at       TEXT,
  -- control_response | user_message; null until the answers reached the CLI
  delivered_via  TEXT,
  delivered_at   TEXT
) STRICT;
CREATE INDEX question_batches_session ON question_batches (session_id, state);

CREATE TABLE questions (
  id            TEXT PRIMARY KEY,
  batch_id      TEXT NOT NULL REFERENCES question_batches (id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  -- index in input.questions[]
  position      INTEGER NOT NULL,
  source        TEXT NOT NULL,
  text          TEXT NOT NULL,
  header        TEXT,
  -- [{label, description}] verbatim
  options       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(options) AND json_type(options) = 'array'),
  multi_select  INTEGER NOT NULL DEFAULT 0 CHECK (multi_select IN (0, 1)),
  answer_index  INTEGER,
  answer_label  TEXT,
  answered_at   TEXT,
  UNIQUE (batch_id, position)
) STRICT;
CREATE INDEX questions_session ON questions (session_id);

-- can_use_tool for any other tool = an Inbox permission item (D6).
CREATE TABLE permission_requests (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  request_id       TEXT NOT NULL,
  tool_use_id      TEXT,
  tool_name        TEXT NOT NULL,
  input            TEXT NOT NULL CHECK (json_valid(input)),
  description      TEXT,
  decision_reason  TEXT,
  -- the request's agent_id (= a subagent's task_id) when a subagent asks
  agent_id         TEXT,
  -- open | decided | stale
  state            TEXT NOT NULL DEFAULT 'open',
  -- allow-once | deny
  decision         TEXT,
  created_at       TEXT NOT NULL,
  decided_at       TEXT,
  stale_at         TEXT,
  UNIQUE (session_id, request_id)
) STRICT;
CREATE INDEX permission_requests_state ON permission_requests (state);

CREATE TABLE worktrees (
  id             TEXT PRIMARY KEY,
  repo           TEXT NOT NULL,
  repo_path      TEXT NOT NULL,
  branch         TEXT NOT NULL,
  -- what the diff compares against (gap #10)
  base_ref       TEXT,
  path           TEXT NOT NULL,
  session_id     TEXT REFERENCES sessions (id) ON DELETE SET NULL,
  pr_number      INTEGER,
  pr_url         TEXT,
  -- verbatim from gh (OPEN | MERGED | CLOSED …)
  pr_state       TEXT,
  pr_checked_at  TEXT,
  removable      INTEGER NOT NULL DEFAULT 0 CHECK (removable IN (0, 1)),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  removed_at     TEXT
) STRICT;
CREATE UNIQUE INDEX worktrees_live_path ON worktrees (path) WHERE removed_at IS NULL;
CREATE INDEX worktrees_session ON worktrees (session_id);

CREATE TABLE schedule_runs (
  id           TEXT PRIMARY KEY,
  schedule_id  TEXT NOT NULL REFERENCES schedules (id) ON DELETE CASCADE,
  ts           TEXT NOT NULL,
  finished_at  TEXT,
  -- running | ok | fail | need | skipped
  result       TEXT NOT NULL DEFAULT 'running',
  summary      TEXT,
  session_id   TEXT REFERENCES sessions (id) ON DELETE SET NULL,
  -- cron | manual
  triggered_by TEXT NOT NULL DEFAULT 'cron'
) STRICT;
CREATE INDEX schedule_runs_schedule_ts ON schedule_runs (schedule_id, ts);

-- Inbox items the service raises itself (M3.3): failed scheduled run, worktree removable, …
CREATE TABLE system_items (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  source           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'need',
  title            TEXT NOT NULL,
  detail           TEXT NOT NULL DEFAULT '',
  -- [{solution, branch}]
  branches         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(branches) AND json_type(branches) = 'array'),
  -- [{id, label}], the first one is primary
  actions          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(actions) AND json_type(actions) = 'array'),
  session_id       TEXT REFERENCES sessions (id) ON DELETE SET NULL,
  schedule_id      TEXT REFERENCES schedules (id) ON DELETE SET NULL,
  schedule_run_id  TEXT REFERENCES schedule_runs (id) ON DELETE SET NULL,
  worktree_id      TEXT REFERENCES worktrees (id) ON DELETE SET NULL,
  payload          TEXT CHECK (payload IS NULL OR json_valid(payload)),
  -- open | closed
  state            TEXT NOT NULL DEFAULT 'open',
  closed_action    TEXT,
  created_at       TEXT NOT NULL,
  closed_at        TEXT
) STRICT;
CREATE INDEX system_items_state ON system_items (state);

CREATE TABLE artifacts (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL
              CHECK (type IN ('PR', 'BRANCH', 'DIFF', 'DOC', 'CONTRACT', 'QA', 'FOLLOWUP', 'TICKET')),
  name        TEXT NOT NULL,
  solution    TEXT,
  branch      TEXT,
  session_id  TEXT REFERENCES sessions (id) ON DELETE SET NULL,
  meta        TEXT,
  path        TEXT,
  url         TEXT,
  data        TEXT CHECK (data IS NULL OR json_valid(data)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;
CREATE INDEX artifacts_session ON artifacts (session_id);
CREATE INDEX artifacts_type ON artifacts (type, updated_at);

CREATE TABLE loops (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  -- observed source: /loop | ScheduleWakeup | CronCreate | Workflow | …
  kind           TEXT NOT NULL,
  label          TEXT,
  iteration      INTEGER,
  -- cap + breaker only from a .loop/progress.md (D9), else null
  cap            INTEGER,
  breaker_count  INTEGER,
  breaker_state  TEXT,
  next_fire_at   TEXT,
  expires_at     TEXT,
  -- per-iteration results for the strip
  iterations     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(iterations) AND json_type(iterations) = 'array'),
  progress_path  TEXT,
  note           TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;
CREATE INDEX loops_session ON loops (session_id);

CREATE TABLE tools (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  url              TEXT,
  description      TEXT,
  show_in_sidebar  INTEGER NOT NULL DEFAULT 1 CHECK (show_in_sidebar IN (0, 1)),
  position         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL CHECK (json_valid(value)),
  updated_at  TEXT NOT NULL
) STRICT;

-- Max usage readings (ARCHITECTURE → "Usage meter"); percentages 0–100.
CREATE TABLE usage_readings (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at          TEXT NOT NULL,
  -- get_usage | rate_limit_event
  source               TEXT NOT NULL,
  session_id           TEXT REFERENCES sessions (id) ON DELETE SET NULL,
  five_hour_pct        REAL,
  five_hour_resets_at  TEXT,
  seven_day_pct        REAL,
  seven_day_resets_at  TEXT,
  raw                  TEXT CHECK (raw IS NULL OR json_valid(raw))
) STRICT;
CREATE INDEX usage_readings_received ON usage_readings (received_at);

-- Parsed History rows per transcript file, valid while (size, mtime) match.
CREATE TABLE history_cache (
  transcript_path    TEXT PRIMARY KEY,
  claude_session_id  TEXT NOT NULL,
  size               INTEGER NOT NULL,
  mtime_ms           REAL NOT NULL,
  -- null = the file yields no row (stub, other root, headless not in the DB)
  item               TEXT CHECK (item IS NULL OR json_valid(item)),
  parsed_at          TEXT NOT NULL
) STRICT;
CREATE INDEX history_cache_session ON history_cache (claude_session_id);

-- User messages owed to a session the next time it runs (stale answers, restart note).
CREATE TABLE pending_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  -- restart-note | stale-answers | user
  kind          TEXT NOT NULL,
  text          TEXT NOT NULL,
  batch_id      TEXT REFERENCES question_batches (id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  delivered_at  TEXT
) STRICT;
CREATE INDEX pending_messages_session ON pending_messages (session_id, delivered_at);
