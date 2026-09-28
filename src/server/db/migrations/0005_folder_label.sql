-- 0005 · a saved folder's own name (D18)
-- A saved folder can have a custom name, a label shown wherever the folder is
-- shown (Settings → Folders, the New-session form's Folder dropdown, the folder
-- switchers, the folder tags). `NULL` = none: the folder shows its own name, its
-- last path segment, which stays the folder's name underneath (worktrees are
-- named after it, `<repo>-wt-<session>`). The service trims a label, keeps it to
-- 40 characters and refuses a label another saved folder has (case-insensitive,
-- `FolderService.rename`); the index below backs the uniqueness for ASCII case
-- (NOCASE folds A-Z only; the service compares full Unicode lower case).
-- docs/database.md, docs/folders.md.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE folders ADD COLUMN label TEXT;

-- At most one saved folder per label, ignoring ASCII case; folders without a label are not counted.
CREATE UNIQUE INDEX folders_label ON folders (label COLLATE NOCASE) WHERE label IS NOT NULL;
