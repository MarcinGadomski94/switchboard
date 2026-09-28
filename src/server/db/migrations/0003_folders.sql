-- 0003 · saved folders; every session and schedule has its own folder (D14)
-- There is no single workspace root any more. The developer saves folders
-- (Settings → Folders, the setup wizard, the New-session form's Browse…), each a
-- workspace (a folder with a router AGENTS.md that is not itself a git main
-- checkout) or a repo (a git main checkout), one of them the default. A session
-- remembers the folder it was started in (`folder_id`, and `root` + `root_kind`
-- so it keeps working when the folder is removed from the list later); a schedule
-- remembers the folder its runs start in. docs/database.md, docs/folders.md.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE folders (
  id              TEXT PRIMARY KEY,
  -- the absolute path as the developer gave it (`~` expanded)
  path            TEXT NOT NULL,
  -- the same folder resolved on disk (realpath): the identity of a folder
  canonical_path  TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL CHECK (kind IN ('workspace', 'repo')),
  is_default      INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  added_at        TEXT NOT NULL,
  last_used_at    TEXT
) STRICT;
-- At most one default folder.
CREATE UNIQUE INDEX folders_default ON folders (is_default) WHERE is_default = 1;

-- The session's folder: the saved folder (null once it is removed from the list),
-- its canonical path and its kind. `cwd` stays the process's working folder: the
-- workspace root, the repo, or the repo's worktree.
ALTER TABLE sessions ADD COLUMN folder_id TEXT REFERENCES folders (id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN root TEXT;
ALTER TABLE sessions ADD COLUMN root_kind TEXT CHECK (root_kind IN ('workspace', 'repo'));
CREATE INDEX sessions_folder ON sessions (folder_id);

-- The folder a schedule's runs start in (also in its template as `folder`).
ALTER TABLE schedules ADD COLUMN folder_id TEXT REFERENCES folders (id) ON DELETE SET NULL;

-- A workspace root the M5.3 setup wizard saved becomes the first saved folder and
-- the default. The wizard only accepted a folder with an AGENTS.md, so it is a
-- workspace. Its canonical path is refreshed from disk when the service starts
-- (FolderService.open). The setting itself is left in place, unread.
INSERT INTO folders (id, path, canonical_path, kind, is_default, added_at, last_used_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  json_extract(value, '$'),
  json_extract(value, '$'),
  'workspace',
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  NULL
FROM settings
WHERE key = 'setup.workspaceRoot' AND json_type(value) = 'text' AND json_extract(value, '$') <> '';

-- Sessions started before D14 all ran at the one workspace root (their cwd).
UPDATE sessions SET root = cwd, root_kind = 'workspace' WHERE cwd IS NOT NULL;
UPDATE sessions
SET folder_id = (SELECT id FROM folders WHERE is_default = 1)
WHERE root IS NOT NULL
  AND root IN (SELECT canonical_path FROM folders WHERE is_default = 1 UNION SELECT path FROM folders WHERE is_default = 1);

-- Schedules saved before D14 started their runs at that same root.
UPDATE schedules SET folder_id = (SELECT id FROM folders WHERE is_default = 1);
