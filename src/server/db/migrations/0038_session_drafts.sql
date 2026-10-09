-- 0038 · drafts follow you (D88, docs/chat.md → Drafts): the unsent text of a session's fields,
-- kept on the machine that runs the session so it survives switching sessions, a reload and
-- another device.
-- session_drafts:
--   session_id  the session (removed with it).
--   field       the field key: composer, todo-add, question:<batchId>, review:<reviewId>,
--               todo-edit:<todoId> (src/core/drafts.ts; ids are this machine's own).
--   value       the field's value as JSON (its shape per field in src/core/drafts.ts); at most
--               64 KiB, checked by the service.
--   updated_at  when it was last saved.
--   updated_by  who saved it: local / device:<id> / peer, then / and the page's id when it sent one.
-- An emptied field has no row (saving an empty value deletes it).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE session_drafts (
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'local',
  PRIMARY KEY (session_id, field)
) STRICT;
