-- switchboard: foreign_keys=off
-- 0048 · D126: an artifact may be a PDF (docs/artifacts.md → Kinds). artifacts_saved (0039) is rebuilt
-- (SQLite cannot change a CHECK in place) with:
--   kind        markdown / code / html / mermaid / svg / image / pdf / csv (0039 had no pdf).
-- A PDF version is stored like an image's: a file artifacts/<id>/<n>.pdf in the data folder,
-- media_type application/pdf, content NULL (artifact_versions is unchanged).
-- Every existing row keeps its values and its rowid. artifact_versions references the table, so the
-- rebuild runs with foreign keys off (the first line; the runner still checks them before committing).
-- The search view and triggers that name artifacts_saved (0042) are dropped first and created again
-- unchanged on the new table, so the search index (search_items, search_fts) is kept as it is.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

DROP TRIGGER search_artifacts_ai;
DROP TRIGGER search_artifacts_au;
DROP TRIGGER search_artifacts_ad;
DROP TRIGGER search_artifact_versions_ai;
DROP TRIGGER search_artifact_versions_ad;
DROP VIEW search_src_artifacts;

CREATE TABLE artifacts_saved_new (
  id          TEXT PRIMARY KEY,
  session_id  TEXT REFERENCES sessions (id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('markdown', 'code', 'html', 'mermaid', 'svg', 'image', 'pdf', 'csv')),
  language    TEXT,
  created_by  TEXT NOT NULL CHECK (created_by IN ('agent', 'developer')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;

INSERT INTO artifacts_saved_new (rowid, id, session_id, title, kind, language, created_by, created_at, updated_at)
  SELECT rowid, id, session_id, title, kind, language, created_by, created_at, updated_at FROM artifacts_saved;

DROP TABLE artifacts_saved;
ALTER TABLE artifacts_saved_new RENAME TO artifacts_saved;
CREATE INDEX artifacts_saved_session ON artifacts_saved (session_id, updated_at);
CREATE INDEX artifacts_saved_updated ON artifacts_saved (updated_at);

-- 0042's search source and triggers, unchanged.
CREATE VIEW search_src_artifacts AS
  SELECT a.rowid AS src, a.id AS ref, a.session_id, NULL AS link, a.title,
         COALESCE(substr(v.content, 1, 100000), '') AS body,
         a.updated_at AS ts
  FROM artifacts_saved a
  LEFT JOIN artifact_versions v ON v.artifact_id = a.id AND v.n = (SELECT MAX(n) FROM artifact_versions WHERE artifact_id = a.id);

CREATE TRIGGER search_artifacts_ai AFTER INSERT ON artifacts_saved BEGIN
  INSERT INTO search_items (kind, ref, session_id, link, title, body, ts)
    SELECT 'artifact', ref, session_id, link, title, body, ts FROM search_src_artifacts WHERE ref = new.id
    ON CONFLICT (kind, ref) DO UPDATE SET session_id = excluded.session_id, link = excluded.link, title = excluded.title, body = excluded.body, ts = excluded.ts;
END;
CREATE TRIGGER search_artifacts_au AFTER UPDATE OF title, session_id, updated_at ON artifacts_saved BEGIN
  INSERT INTO search_items (kind, ref, session_id, link, title, body, ts)
    SELECT 'artifact', ref, session_id, link, title, body, ts FROM search_src_artifacts WHERE ref = new.id
    ON CONFLICT (kind, ref) DO UPDATE SET session_id = excluded.session_id, link = excluded.link, title = excluded.title, body = excluded.body, ts = excluded.ts;
END;
CREATE TRIGGER search_artifacts_ad AFTER DELETE ON artifacts_saved BEGIN
  DELETE FROM search_items WHERE kind = 'artifact' AND ref = old.id;
END;
CREATE TRIGGER search_artifact_versions_ai AFTER INSERT ON artifact_versions BEGIN
  INSERT INTO search_items (kind, ref, session_id, link, title, body, ts)
    SELECT 'artifact', ref, session_id, link, title, body, ts FROM search_src_artifacts WHERE ref = new.artifact_id
    ON CONFLICT (kind, ref) DO UPDATE SET session_id = excluded.session_id, link = excluded.link, title = excluded.title, body = excluded.body, ts = excluded.ts;
END;
CREATE TRIGGER search_artifact_versions_ad AFTER DELETE ON artifact_versions BEGIN
  INSERT INTO search_items (kind, ref, session_id, link, title, body, ts)
    SELECT 'artifact', ref, session_id, link, title, body, ts FROM search_src_artifacts WHERE ref = old.artifact_id
    ON CONFLICT (kind, ref) DO UPDATE SET session_id = excluded.session_id, link = excluded.link, title = excluded.title, body = excluded.body, ts = excluded.ts;
END;
