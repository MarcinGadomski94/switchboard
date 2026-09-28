-- 0006 · session titles (D22): a free-text title on top of the technical short
-- name. `name` stays the unique kebab-case short name the worktree folder and the
-- branch are built from; `title` (trimmed, 1–80 characters, not unique; the API
-- checks it) is what the UI shows. NULL = no title: the name is shown, as for every
-- session started before this migration. docs/database.md.
-- Numbered 0006: 0005 belongs to another change (0005_folder_label.sql, D18) and
-- this one does not depend on it.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE sessions ADD COLUMN title TEXT;
