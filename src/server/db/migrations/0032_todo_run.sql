-- 0032 · a todo can run in its own session (D76), be in review, and records its actuals (D78).
-- docs/todos.md → Run in a new session (D76), Review (D76), Actual vs. estimate (D78).
-- session_todos (0031) is rebuilt (SQLite cannot change a CHECK in place) with:
--   state            open / in_progress / review / done. review = the run session (or the developer)
--                    marked an item with a running run done: it waits for the developer's review
--                    (lane B's review queue resolves it). Like open and in progress it has no done_at
--                    (it is never removed by the done hour).
--   started_by       also run: the item went in progress because ▸ Run in new session started it
--                    (the run session's agent is reminded to finish it, not the source session's).
--   run_session_id   the session ▸ Run in new session started for the item (on the same machine);
--                    kept after the run ends, so the card keeps its link. NULL = never run.
--   run_state        active (the run session works on it: done → review) or discarded (its review
--                    was discarded: the item went back to open, the link is history); NULL = never run.
--   started_first_at when the item first went in progress (never cleared, also not by reopening).
--   span_started_at  when its current in-progress span began (NULL while not in progress): the
--                    actuals add each span when it ends.
--   actual_ms        the time it spent in progress (every span from first in progress to done or
--                    review; time back in open, in review or done does not count). NULL = never started.
--   actual_tokens    the tokens of the turns of the session working on it (the run session's, else
--                    its own session's) that ended during those spans; NULL = none known.
-- sessions gains todo_link (JSON { sourceSessionId, todoId }): the run session of a todo, which may
-- mark that one item of the source session (its agent token reaches nothing else of that list).
-- todo_actuals keeps one row per completed (done / review) item with an estimate or not, so the
-- per-session totals and the agents' estimate calibration outlive the done hour; a reopened item
-- loses its row until it completes again.
-- Every existing row keeps its values, id, position and times (the new columns NULL). Nothing
-- references session_todos, so the rebuild runs with foreign keys on.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE session_todos_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) > 0),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'in_progress', 'review', 'done')),
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
  started_by TEXT CHECK (started_by IS NULL OR started_by IN ('start', 'agent', 'developer', 'run')),
  reminded_at TEXT,
  run_session_id TEXT,
  run_state TEXT CHECK (run_state IS NULL OR run_state IN ('active', 'discarded')),
  started_first_at TEXT,
  span_started_at TEXT,
  actual_ms INTEGER CHECK (actual_ms IS NULL OR actual_ms >= 0),
  actual_tokens INTEGER CHECK (actual_tokens IS NULL OR actual_tokens >= 0),
  CHECK ((state = 'done') = (done_at IS NOT NULL)),
  CHECK (state <> 'in_progress' OR (started_at IS NOT NULL AND started_by IS NOT NULL)),
  CHECK (state <> 'review' OR run_session_id IS NOT NULL),
  CHECK ((run_session_id IS NULL) = (run_state IS NULL))
) STRICT;

INSERT INTO session_todos_new (id, session_id, title, state, added_by, position, created_at, updated_at, done_at, description, plan, priority, estimate_minutes, started_at, started_by, reminded_at)
  SELECT id, session_id, title, state, added_by, position, created_at, updated_at, done_at, description, plan, priority, estimate_minutes, started_at, started_by, reminded_at FROM session_todos;

DROP TABLE session_todos;
ALTER TABLE session_todos_new RENAME TO session_todos;
CREATE INDEX session_todos_session ON session_todos (session_id, position);
CREATE INDEX session_todos_done ON session_todos (done_at) WHERE done_at IS NOT NULL;
CREATE INDEX session_todos_run ON session_todos (run_session_id) WHERE run_session_id IS NOT NULL;

ALTER TABLE sessions ADD COLUMN todo_link TEXT CHECK (todo_link IS NULL OR (json_valid(todo_link) AND json_type(todo_link) = 'object'));

CREATE TABLE todo_actuals (
  todo_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  folder TEXT,
  title TEXT NOT NULL,
  estimate_minutes INTEGER,
  actual_ms INTEGER NOT NULL CHECK (actual_ms >= 0),
  actual_tokens INTEGER,
  completed_at TEXT NOT NULL
) STRICT;
CREATE INDEX todo_actuals_session ON todo_actuals (session_id, completed_at);
CREATE INDEX todo_actuals_folder ON todo_actuals (folder, completed_at);
