-- switchboard: foreign_keys=off
-- 0029 · the sidebar layout as records (D71, docs/sidebar.md → *Shared layout (D71)*).
-- The layout can be shared with paired machines (last write wins per item) and
-- loose sessions get a manual order, so every folder and every session place
-- now carries an order key (`sort_key`, base-36 digits compared as strings,
-- src/core/sidebar-keys.ts) in place of an integer position, and hybrid-clock
-- timestamps (src/core/hlc.ts; '' = written before D71, older than any clock).
--   sidebar_folders   name (+ name_clock), parent_id + sort_key (+ place_clock),
--                     collapsed (this machine's own, never shared) and
--                     deleted_clock: a deleted folder stays as a tombstone so a
--                     paired machine learns it. parent_id is no longer a foreign
--                     key: a peer's folder may name a parent this machine has
--                     not got yet, or a deleted one (shown in the nearest live
--                     folder above it).
--   sidebar_places    one row per placed session: grp pinned / folder / loose
--                     (the manual loose order) / none (unplaced, kept with its
--                     clock); folder_id for `folder` (not a foreign key either).
-- Every existing row keeps its place: positions become keys in the same order
-- (`000000i`, `000001i`, …), clocks ''. SQLite cannot drop the foreign keys or
-- change the columns in place, so both tables are rebuilt (12-step procedure,
-- foreign keys off for this migration, the first line); the two D54 triggers
-- (a deleted session record, a forgotten machine) are created again on the new
-- `sidebar_places`.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE sidebar_folders_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  name_clock TEXT NOT NULL DEFAULT '',
  parent_id TEXT CHECK (parent_id IS NULL OR parent_id <> id),
  sort_key TEXT NOT NULL,
  place_clock TEXT NOT NULL DEFAULT '',
  deleted_clock TEXT,
  collapsed INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO sidebar_folders_new (id, name, parent_id, sort_key, collapsed, created_at)
  SELECT id, name, parent_id, printf('%06di', position), collapsed, created_at FROM sidebar_folders;

CREATE TABLE sidebar_places_new (
  session_id TEXT PRIMARY KEY,
  grp TEXT NOT NULL CHECK (grp IN ('pinned', 'folder', 'loose', 'none')),
  folder_id TEXT,
  sort_key TEXT NOT NULL DEFAULT '',
  clock TEXT NOT NULL DEFAULT '',
  CHECK ((grp = 'folder') = (folder_id IS NOT NULL))
) STRICT;

INSERT INTO sidebar_places_new (session_id, grp, folder_id, sort_key)
  SELECT session_id, CASE WHEN folder_id IS NULL THEN 'pinned' ELSE 'folder' END, folder_id, printf('%06di', position) FROM sidebar_places;

DROP TRIGGER sessions_sidebar_place;
DROP TRIGGER machines_sidebar_places;
DROP TABLE sidebar_places;
DROP TABLE sidebar_folders;
ALTER TABLE sidebar_folders_new RENAME TO sidebar_folders;
ALTER TABLE sidebar_places_new RENAME TO sidebar_places;

CREATE INDEX sidebar_folders_parent ON sidebar_folders (parent_id, sort_key);
CREATE INDEX sidebar_places_group ON sidebar_places (grp, folder_id, sort_key);

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
