-- 0040 · drafts follow you, the New-session form (D88 ruling 2026-10-09, docs/chat.md → Drafts):
-- the unsent values of fields that belong to no session, kept per machine (this machine's own),
-- so they survive closing the dialog, a reload and another device (D73).
-- machine_drafts:
--   field       the field key: new-session (src/core/drafts.ts → isMachineDraftField).
--   value       the field's value as JSON (its shape in src/core/drafts.ts); at most 64 KiB,
--               checked by the service.
--   updated_at  when it was last saved.
--   updated_by  who saved it: local / device:<id>, then / and the page's id when it sent one.
-- An emptied field has no row (saving an empty value deletes it).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE machine_drafts (
  field TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'local'
) STRICT;
