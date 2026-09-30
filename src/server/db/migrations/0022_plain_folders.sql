-- switchboard: foreign_keys=off
-- 0022 · plain folders (D59)
-- A saved folder may also be a `plain` folder: neither a workspace (no router
-- AGENTS.md) nor a git repository. Only Simple sessions start there (no
-- solutions, no worktrees, no router answers). SQLite cannot change a CHECK
-- constraint, so `folders` is rebuilt with SQLite's 12-step procedure
-- (https://sqlite.org/lang_altertable.html#otheralter): the runner turns foreign
-- keys off for this migration (the first line above; `sessions.folder_id` and
-- `schedules.folder_id` reference `folders`, and dropping it with foreign keys on
-- would set theirs to NULL), runs it in one transaction and checks
-- `PRAGMA foreign_key_check` before committing. Every row keeps its id, its
-- fields and its rowid (the saved list's last tie-break); the two indexes are
-- created again; `folders` has no triggers or views.
-- `sessions.root_kind` keeps its CHECK: `sessions` is referenced by most tables
-- (CASCADE), so it is not rebuilt. A plain-folder session stores `root` with
-- `root_kind` NULL, a state no earlier version writes (the session repository
-- reads it as `plain`). docs/database.md, docs/folders.md.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE folders_new (
  id              TEXT PRIMARY KEY,
  path            TEXT NOT NULL,
  canonical_path  TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL CHECK (kind IN ('workspace', 'repo', 'plain')),
  is_default      INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  added_at        TEXT NOT NULL,
  last_used_at    TEXT,
  label           TEXT
) STRICT;

INSERT INTO folders_new (rowid, id, path, canonical_path, kind, is_default, added_at, last_used_at, label)
SELECT rowid, id, path, canonical_path, kind, is_default, added_at, last_used_at, label FROM folders;

DROP TABLE folders;
ALTER TABLE folders_new RENAME TO folders;

-- At most one default folder (0003).
CREATE UNIQUE INDEX folders_default ON folders (is_default) WHERE is_default = 1;
-- At most one saved folder per label, ignoring ASCII case (0005, D18).
CREATE UNIQUE INDEX folders_label ON folders (label COLLATE NOCASE) WHERE label IS NOT NULL;
