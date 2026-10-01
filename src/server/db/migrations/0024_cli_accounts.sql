-- 0024 · CLI accounts: profiles per CLI, the profile a session runs on (D63, docs/accounts.md).
-- cli_profiles: one row per account profile of a CLI.
--   id               default-claude / default-codex / default-opencode for the built-in
--                    "Default" profile of each CLI (no config-dir override: the developer's
--                    own login), a random id for every other profile.
--   dir              the profile's config / data folder (CLAUDE_CONFIG_DIR, CODEX_HOME,
--                    XDG_DATA_HOME); NULL for Default. Switchboard never reads a token in it.
--   builtin          1 for Default (cannot be deleted, signed in / out or have its folder touched here).
--   position         the priority order within a CLI, 0 first.
--   share_settings   1 = the profile uses the Default's settings / instructions / MCP config.
--   exhausted_*      set when the profile hit a usage limit: until when (ISO), which window
--                    (session / weekly / unknown) and the CLI's own text. Cleared by its reset.
-- sessions:
--   profile_id       the profile the session's process runs on; NULL = the Default of its CLI.
--   profile_pinned   1 = automatic switching leaves the session on its profile.
-- usage_readings:
--   profile_id       which Claude Code profile the reading belongs to (every earlier reading
--                    is the Default's).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE cli_profiles (
  id TEXT PRIMARY KEY,
  cli TEXT NOT NULL CHECK (cli IN ('claude', 'codex', 'opencode')),
  name TEXT NOT NULL,
  dir TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL,
  share_settings INTEGER NOT NULL DEFAULT 1,
  exhausted_until TEXT,
  exhausted_window TEXT,
  exhausted_text TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX cli_profiles_cli ON cli_profiles (cli, position);

INSERT INTO cli_profiles (id, cli, name, dir, builtin, enabled, position, share_settings, created_at) VALUES
  ('default-claude', 'claude', 'Default', NULL, 1, 1, 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('default-codex', 'codex', 'Default', NULL, 1, 1, 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('default-opencode', 'opencode', 'Default', NULL, 1, 1, 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

ALTER TABLE sessions ADD COLUMN profile_id TEXT;
ALTER TABLE sessions ADD COLUMN profile_pinned INTEGER NOT NULL DEFAULT 0;
UPDATE sessions SET profile_id = 'default-' || provider;

ALTER TABLE usage_readings ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default-claude';
