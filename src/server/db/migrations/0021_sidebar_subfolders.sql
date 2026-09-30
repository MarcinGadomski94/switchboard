-- 0021 · subfolders in the sidebar (D58, docs/sidebar.md).
-- A sidebar folder can sit in another one: `parent_id` NULL = a top-level folder
-- (every folder of 0019 stays top level), else the folder it sits in.
-- `position` is now the order among the folders with the same parent.
-- Loops and the depth limit (5 levels) are checked by the service
-- (`checkFolderParent` in src/core/sidebar-layout.ts); the database refuses a
-- folder that is its own parent. Deleting a folder is done by the service,
-- which first moves its subfolders and sessions up a level (nothing is lost);
-- the cascade only ever meets rows the service already moved.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE sidebar_folders ADD COLUMN parent_id TEXT REFERENCES sidebar_folders (id) ON DELETE CASCADE CHECK (parent_id IS NULL OR parent_id <> id);

CREATE INDEX sidebar_folders_parent ON sidebar_folders (parent_id, position);
