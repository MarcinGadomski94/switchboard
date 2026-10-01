-- 0023 · the CLI a session runs on (D62, docs/providers.md).
-- sessions:
--   provider          the CLI the session's process runs: claude (Claude Code),
--                     codex (Codex CLI) or opencode (OpenCode). Every session from
--                     before this migration ran on Claude Code, so the default fills
--                     them all in as claude. A mid-session switch changes it.
-- session_providers: each CLI's own conversation id for a session, so a later spawn
-- (resume, a switch back) reopens the CLI's own conversation instead of a new one.
--   native_id         a Codex thread id, an OpenCode session id; for Claude Code
--                     the session's claude_session_id (also kept on sessions).
--   first_used_at / last_used_at   ISO times of the first and the latest spawn.
-- provider_switches: one row per mid-session switch (D62 P5), oldest first.
--   handover_by       outgoing (the outgoing agent wrote the handover) or history
--                     (the incoming agent read the exported chat itself).
--   status            running, done or failed (error says why).
--   export_path       the exported chat the incoming agent read (history), else NULL.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude' CHECK (provider IN ('claude', 'codex', 'opencode'));

CREATE TABLE session_providers (
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'opencode')),
  native_id TEXT NOT NULL,
  first_used_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  PRIMARY KEY (session_id, provider)
) STRICT;

CREATE TABLE provider_switches (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  from_provider TEXT NOT NULL CHECK (from_provider IN ('claude', 'codex', 'opencode')),
  to_provider TEXT NOT NULL CHECK (to_provider IN ('claude', 'codex', 'opencode')),
  handover_by TEXT CHECK (handover_by IN ('outgoing', 'history')),
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  error TEXT,
  export_path TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;
CREATE INDEX provider_switches_session ON provider_switches (session_id, created_at);
