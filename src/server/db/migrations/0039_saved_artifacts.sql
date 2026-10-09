-- 0039 · artifacts saved on purpose (D89, docs/artifacts.md): the session's agent saves them with the
-- `switchboard` MCP tool `artifact_save`, the developer with Save as artifact on a chat message. Saving
-- again with an artifact's id adds a version. They replace the artifacts the recorder derived from tool
-- results (gap #9): the old `artifacts` table (0001) is no longer written or read; it stays as it is.
-- artifacts_saved:
--   id          short random id (the agent passes it back to add a version).
--   session_id  the session it was saved in; NULL once that session is gone (the artifact stays).
--   kind        markdown / code / html / mermaid / svg / image / csv.
--   language    for code: its language (ts, python, …); else NULL.
--   created_by  agent (artifact_save) or developer (Save as artifact): who created it.
--   updated_at  when its latest version was saved.
-- artifact_versions (n from 1, one per save):
--   content     the text of a text kind; NULL for an image.
--   file        an image's file, relative to the data folder: artifacts/<id>/<n>.<ext>; NULL for text.
--   media_type  an image's sniffed type (image/png, …); NULL for text.
--   size        bytes (UTF-8 for text).
--   created_by  who saved this version.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE artifacts_saved (
  id          TEXT PRIMARY KEY,
  session_id  TEXT REFERENCES sessions (id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('markdown', 'code', 'html', 'mermaid', 'svg', 'image', 'csv')),
  language    TEXT,
  created_by  TEXT NOT NULL CHECK (created_by IN ('agent', 'developer')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;
CREATE INDEX artifacts_saved_session ON artifacts_saved (session_id, updated_at);
CREATE INDEX artifacts_saved_updated ON artifacts_saved (updated_at);

CREATE TABLE artifact_versions (
  artifact_id  TEXT NOT NULL REFERENCES artifacts_saved (id) ON DELETE CASCADE,
  n            INTEGER NOT NULL CHECK (n >= 1),
  content      TEXT,
  file         TEXT,
  media_type   TEXT,
  size         INTEGER NOT NULL CHECK (size >= 0),
  created_by   TEXT NOT NULL CHECK (created_by IN ('agent', 'developer')),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (artifact_id, n),
  CHECK ((content IS NULL) <> (file IS NULL))
) STRICT;
