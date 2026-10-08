-- 0031 · a todo item can be in progress (D75, docs/todos.md → In progress).
-- session_todos (0026–0028) is rebuilt (SQLite cannot change a CHECK in place) with:
--   state        open / in_progress / done (0026 allowed open / done only). Several items of a
--                session may be in progress at once; they keep their place in the priority order.
--   started_at   when the item went in progress (▶ Start, the agent's todo_start, or ⋯ → Mark in
--                progress); kept while it is done, NULL while it is open. Reopening clears it.
--   started_by   how it went in progress: start (the developer's ▶ Start, which sends the start
--                message), agent (todo_start), developer (⋯ → Mark in progress); NULL like started_at.
--                Only start and agent arm the finish reminder.
--   reminded_at  when Switchboard sent the agent its one reminder to finish this start of the item
--                (a turn ended with the item still in progress and untouched); NULL = not sent.
--                A new start clears it (at most one reminder per item per start).
-- Every existing row keeps its values (all of them open or done; the new columns NULL), its id,
-- position and done time (so a done item keeps its hour). Nothing references session_todos, so
-- the rebuild runs with foreign keys on (its own reference to sessions is checked as rows copy).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE session_todos_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) > 0),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'in_progress', 'done')),
  added_by TEXT NOT NULL CHECK (added_by IN ('developer', 'agent')),
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT,
  description TEXT,
  plan TEXT,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('urgent', 'high', 'medium', 'low')),
  estimate_minutes INTEGER CHECK (estimate_minutes IS NULL OR (estimate_minutes BETWEEN 1 AND 10080)),
  started_at TEXT,
  started_by TEXT CHECK (started_by IS NULL OR started_by IN ('start', 'agent', 'developer')),
  reminded_at TEXT,
  CHECK ((state = 'done') = (done_at IS NOT NULL)),
  CHECK (state <> 'in_progress' OR (started_at IS NOT NULL AND started_by IS NOT NULL))
) STRICT;

INSERT INTO session_todos_new (id, session_id, title, state, added_by, position, created_at, updated_at, done_at, description, plan, priority, estimate_minutes)
  SELECT id, session_id, title, state, added_by, position, created_at, updated_at, done_at, description, plan, priority, estimate_minutes FROM session_todos;

DROP TABLE session_todos;
ALTER TABLE session_todos_new RENAME TO session_todos;
CREATE INDEX session_todos_session ON session_todos (session_id, position);
CREATE INDEX session_todos_done ON session_todos (done_at) WHERE done_at IS NOT NULL;
