-- 0019 · the sidebar's pins and folders (D54, docs/sidebar.md).
-- A session sits pinned, in one sidebar folder, or loose (no row). The layout is
-- this machine's: a paired machine's session (remote id `r~<machine>~<id>`) can
-- be placed here too, so `session_id` is not a foreign key of `sessions`.
-- Not the saved folders of D14 (`folders`): these only group the sidebar's rows.
--   sidebar_folders   one level, in a manual order (`position`), with a name
--                     (1–60 characters, may repeat) and a remembered collapsed state.
--   sidebar_places    the placed sessions: `folder_id` NULL = pinned, else the
--                     folder (deleting it makes its sessions loose); `position` =
--                     the order inside the Pinned group or the folder.
-- Rows of a closed session stay (reopening it restores its place, D33). Deleting
-- a session record, or forgetting a paired machine, removes their rows (triggers).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE sidebar_folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  position INTEGER NOT NULL,
  collapsed INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE sidebar_places (
  session_id TEXT PRIMARY KEY,
  folder_id TEXT REFERENCES sidebar_folders (id) ON DELETE CASCADE,
  position INTEGER NOT NULL
) STRICT;
CREATE INDEX sidebar_places_folder ON sidebar_places (folder_id, position);

-- A deleted session record takes its place with it (a refused start, D25).
CREATE TRIGGER sessions_sidebar_place AFTER DELETE ON sessions
BEGIN
  DELETE FROM sidebar_places WHERE session_id = OLD.id;
END;

-- A forgotten machine takes the places of its sessions with it.
CREATE TRIGGER machines_sidebar_places AFTER DELETE ON machines
BEGIN
  DELETE FROM sidebar_places WHERE substr(session_id, 1, length(OLD.id) + 3) = 'r~' || OLD.id || '~';
END;
