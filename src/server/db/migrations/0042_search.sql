-- 0042 · search across everything (D97, docs/search.md): one SQLite FTS5 index over the
-- sessions' events (their text), the sessions' titles, the saved artifacts, the todos and the
-- History rows of terminal conversations that are not sessions here.
-- search_fts (FTS5, contentless with deletes: it stores no text, only the index):
--   rowid > 0   an event: rowid = events.id; written by the server when it writes the event
--               (src/server/db/repos/search.ts: the text is taken from the payload, tool
--               inputs and results cut), removed by the trigger below when the event goes.
--   rowid < 0   a row of search_items: rowid = -search_items.id (kept by the triggers below).
--   title       a row's title (sessions, artifacts, todos, History); '' for an event.
--   body        the text.
-- search_items: what the index holds for a session / artifact / todo / History row, kept by
--   triggers on the source tables (insert, update of the indexed columns, delete; also the
--   deletes and updates that foreign keys cascade), so it can never outlive its source:
--   kind        session | artifact | todo | history.
--   ref         the source's key: the session / artifact / todo id; History: the transcript path.
--   session_id  the session it belongs to (a session: itself; History: NULL).
--   link        History: the conversation's claude session id; else NULL.
--   title/body  the indexed text (also read back for the snippets).
--   ts          for the recency boost: created_at (sessions, todos), updated_at (artifacts),
--               the conversation's start (History).
-- search_state: the startup backfill's progress (key → value), so a restart resumes it.
-- The search_src_* views say what each source contributes; the triggers and the backfill
-- both read them.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE VIRTUAL TABLE search_fts USING fts5 (
  title,
  body,
  content = '',
  contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE search_items (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('session', 'artifact', 'todo', 'history')),
  ref         TEXT NOT NULL,
  session_id  TEXT,
  link        TEXT,
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  ts          TEXT NOT NULL,
  UNIQUE (kind, ref)
) STRICT;
CREATE INDEX search_items_session ON search_items (session_id);

CREATE TABLE search_state (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
) STRICT;

-- search_items ↔ search_fts
CREATE TRIGGER search_items_ai AFTER INSERT ON search_items BEGIN
  INSERT INTO search_fts (rowid, title, body) VALUES (-new.id, new.title, new.body);
END;
-- (delete + insert, not INSERT OR REPLACE: inside a trigger fired by an upsert the outer
-- statement's conflict policy wins, and FTS5 would then add a second entry for the row.)
CREATE TRIGGER search_items_au AFTER UPDATE OF title, body ON search_items BEGIN
  DELETE FROM search_fts WHERE rowid = -old.id;
  INSERT INTO search_fts (rowid, title, body) VALUES (-new.id, new.title, new.body);
END;
CREATE TRIGGER search_items_ad AFTER DELETE ON search_items BEGIN
  DELETE FROM search_fts WHERE rowid = -old.id;
END;

-- events: indexed by the server on write; gone with their row (a session deleted, anything that prunes).
CREATE TRIGGER search_events_ad AFTER DELETE ON events BEGIN
  DELETE FROM search_fts WHERE rowid = old.id;
END;

-- What each source contributes (src = the source row's rowid, for the backfill's progress).
CREATE VIEW search_src_sessions AS
  SELECT rowid AS src, id AS ref, id AS session_id, NULL AS link,
         COALESCE(NULLIF(title, ''), name) AS title,
         substr(trim(name || char(10) || task), 1, 4000) AS body,
         created_at AS ts
  FROM sessions;

CREATE VIEW search_src_todos AS
  SELECT rowid AS src, id AS ref, session_id, NULL AS link, title,
         substr(trim(COALESCE(description, '') || char(10) || COALESCE(plan, '')), 1, 16000) AS body,
         created_at AS ts
  FROM session_todos;

CREATE VIEW search_src_artifacts AS
  SELECT a.rowid AS src, a.id AS ref, a.session_id, NULL AS link, a.title,
         COALESCE(substr(v.content, 1, 100000), '') AS body,
         a.updated_at AS ts
  FROM artifacts_saved a
  LEFT JOIN artifact_versions v ON v.artifact_id = a.id AND v.n = (SELECT MAX(n) FROM artifact_versions WHERE artifact_id = a.id);

CREATE VIEW search_src_history AS
  SELECT rowid AS src, transcript_path AS ref, NULL AS session_id, claude_session_id AS link,
         COALESCE(json_extract(item, '$.name'), '') AS title,
         substr(trim(COALESCE(json_extract(item, '$.firstPrompt'), '') || char(10) || COALESCE(json_extract(item, '$.summary'), '')), 1, 4000) AS body,
         COALESCE(json_extract(item, '$.startedAt'), parsed_at) AS ts
  FROM history_cache
  WHERE item IS NOT NULL AND json_type(item) = 'object' AND json_extract(item, '$.sessionId') IS NULL;

-- sessions
CREATE TRIGGER search_sessions_ai AFTER INSERT ON sessions BEGIN
  INSERT INTO search_items (kind, ref, session_id, link, title, body, ts)
    SELECT 'session', ref, session_id, link, title, body, ts FROM search_src_sessions WHERE ref = new.id
    ON CONFLICT (kind, ref) DO UPDATE SET session_id = excluded.session_id, link = excluded.link, title = excluded.title, body = excluded.body, ts = excluded.ts;
END;
CREATE TRIGGER search_sessions_au AFTER UPDATE OF name, title, task ON sessions BEGIN
  INSERT INTO search_items (kind, ref, session_id, link, title, body, ts)
    SELECT 'session', ref, session_id, link, title, body, ts FROM search_src_sessions WHERE ref = new.id
    ON CONFLICT (kind, ref) DO UPDATE SET session_id = excluded.session_id, link = excluded.link, title = excluded.title, body = excluded.body, ts = excluded.ts;
END;
CREATE TRIGGER search_sessions_ad AFTER DELETE ON sessions BEGIN
  DELETE FROM search_items WHERE kind = 'session' AND ref = old.id;
END;

-- todos
CREATE TRIGGER search_todos_ai AFTER INSERT ON session_todos BEGIN
  INSERT INTO search_items (kind, ref, session_id, link, title, body, ts)
    SELECT 'todo', ref, session_id, link, title, body, ts FROM search_src_todos WHERE ref = new.id
    ON CONFLICT (kind, ref) DO UPDATE SET session_id = excluded.session_id, link = excluded.link, title = excluded.title, body = excluded.body, ts = excluded.ts;
END;
CREATE TRIGGER search_todos_au AFTER UPDATE OF title, description, plan, session_id ON session_todos BEGIN
  INSERT INTO search_items (kind, ref, session_id, link, title, body, ts)
    SELECT 'todo', ref, session_id, link, title, body, ts FROM search_src_todos WHERE ref = new.id
    ON CONFLICT (kind, ref) DO UPDATE SET session_id = excluded.session_id, link = excluded.link, title = excluded.title, body = excluded.body, ts = excluded.ts;
END;
CREATE TRIGGER search_todos_ad AFTER DELETE ON session_todos BEGIN
  DELETE FROM search_items WHERE kind = 'todo' AND ref = old.id;
END;

-- artifacts (the title and the latest version's text; the session goes NULL when it is deleted)
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

-- History rows of terminal conversations (gone when the row goes or becomes a session's)
CREATE TRIGGER search_history_ai AFTER INSERT ON history_cache BEGIN
  INSERT INTO search_items (kind, ref, session_id, link, title, body, ts)
    SELECT 'history', ref, session_id, link, title, body, ts FROM search_src_history WHERE ref = new.transcript_path
    ON CONFLICT (kind, ref) DO UPDATE SET session_id = excluded.session_id, link = excluded.link, title = excluded.title, body = excluded.body, ts = excluded.ts;
END;
CREATE TRIGGER search_history_au AFTER UPDATE ON history_cache BEGIN
  DELETE FROM search_items WHERE kind = 'history' AND ref = old.transcript_path
    AND NOT EXISTS (SELECT 1 FROM search_src_history WHERE ref = new.transcript_path);
  INSERT INTO search_items (kind, ref, session_id, link, title, body, ts)
    SELECT 'history', ref, session_id, link, title, body, ts FROM search_src_history WHERE ref = new.transcript_path
    ON CONFLICT (kind, ref) DO UPDATE SET session_id = excluded.session_id, link = excluded.link, title = excluded.title, body = excluded.body, ts = excluded.ts;
END;
CREATE TRIGGER search_history_ad AFTER DELETE ON history_cache BEGIN
  DELETE FROM search_items WHERE kind = 'history' AND ref = old.transcript_path;
END;
