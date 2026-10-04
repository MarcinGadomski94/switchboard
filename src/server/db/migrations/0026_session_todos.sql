-- 0026 · a todo list per session (D68, docs/todos.md).
-- session_todos: one row per item of a session's todo list, added by the developer (the UI)
-- or by the session's agent (the built-in `switchboard` MCP tools).
--   session_id   the session; deleting the session deletes its items.
--   text         the item (trimmed, 1–1000 characters; checked by the service).
--   state        open / done.
--   added_by     developer / agent.
--   position     the order within the session, 0 first (open and done items share it).
--   done_at      when it was marked done; NULL while open. A done item is removed by itself
--                1 hour after done_at (a sweep at start and a timer, so a restart keeps the hour),
--                earlier by Delete or Clear done; reopening it clears done_at.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE session_todos (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (length(text) > 0),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done')),
  added_by TEXT NOT NULL CHECK (added_by IN ('developer', 'agent')),
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT,
  CHECK ((state = 'done') = (done_at IS NOT NULL))
) STRICT;
CREATE INDEX session_todos_session ON session_todos (session_id, position);
CREATE INDEX session_todos_done ON session_todos (done_at) WHERE done_at IS NOT NULL;
