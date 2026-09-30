-- 0020 · attachments (D57, docs/chat.md → Attachments, docs/security.md → Attachments).
-- The images and files pasted, dropped or picked in the chat composer and the
-- New-session forms. The bytes live in the data folder, never in the database:
-- <dataDir>/attachments/<session id>/<id>-<name> (a staged upload of the
-- New-session form, before its session exists: <dataDir>/attachments/_staged/).
--   session_id   the session it belongs to; NULL = staged (bound at the start).
--                Deleting the session deletes its rows (its files go at the next
--                start's cleanup, with anything older than 30 days).
--   name         the sanitized file name (shown; the stored file name is `file`).
--   media_type   the sniffed image / PDF type, else application/octet-stream.
--   kind         image / pdf / file (no CHECK: a TypeScript union, like other
--                small vocabularies).
--   size         bytes.
--   file         the stored file's name inside its folder (`<id>-<name>`).
--   pages        a PDF's page count as read from its bytes, else NULL.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  file TEXT NOT NULL,
  pages INTEGER,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX attachments_session ON attachments (session_id, created_at);
CREATE INDEX attachments_created ON attachments (created_at);
