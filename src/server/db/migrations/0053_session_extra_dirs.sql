-- 0053 · D152 follow-up (2026-11-05): a workspace session moved to another computer may work in
-- repos outside its workspace root (docs/peers.md → *Repos outside the workspace*).
-- sessions gains:
--   extra_dirs  JSON array of folders outside the session's folder its CLI may work in (canonical
--               absolute paths), given to Claude Code as `--add-dir` on every spawn (resumes
--               included). '[]' for every session before 0053 and for every chat (a chat's
--               folders are look_at, 0044).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE sessions ADD COLUMN extra_dirs TEXT NOT NULL DEFAULT '[]';
