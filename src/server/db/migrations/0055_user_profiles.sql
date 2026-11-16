-- 0055 · D165 Profiles (docs/profiles.md): two people share one Switchboard; every agent belongs to
-- one user profile. Named user_profile(s) so it never meets D63's CLI account profiles (cli_profiles,
-- sessions.profile_id).
--   user_profiles   id, name (1–40), colour, an optional password hash (scrypt, never the password),
--                   clock (hybrid-clock text, '' = before any change: the peer sync's last write wins),
--                   deleted_at (a tombstone, so a paired computer learns the delete).
--                   'default' is seeded and never deleted.
--   sessions.user_profile_id   the agent's profile; every existing session is Default's.
--   devices.user_profile_id    D73: a paired phone works in one profile; existing phones are Default's.
--   schedules.user_profile_id  M7.1: a scheduled run starts in its schedule's profile.
--   sidebar_folders.user_profile_id   each profile has its own folder tree; existing folders are Default's.
-- Plans, crews, todos, loops, artifacts and the rest follow their session (no column).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE user_profiles (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  color         TEXT NOT NULL DEFAULT 'blue',
  password_hash TEXT,
  clock         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
) STRICT;

INSERT INTO user_profiles (id, name, color, created_at, updated_at)
VALUES ('default', 'Default', 'blue', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

ALTER TABLE sessions ADD COLUMN user_profile_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX sessions_user_profile ON sessions (user_profile_id);

ALTER TABLE devices ADD COLUMN user_profile_id TEXT NOT NULL DEFAULT 'default';

ALTER TABLE schedules ADD COLUMN user_profile_id TEXT NOT NULL DEFAULT 'default';

ALTER TABLE sidebar_folders ADD COLUMN user_profile_id TEXT NOT NULL DEFAULT 'default';
