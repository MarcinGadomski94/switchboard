-- 0052 · D147 an item's actual time is its agent's working time (docs/todos.md → Actual vs.
-- estimate (D78, D147)). D78's actual_ms (the time an item spent in progress) is kept as its
-- "open time"; the working time counts only while the session working on the item (its run
-- session's, else its own) is working (status run), split equally among that session's items
-- in progress at the time.
-- session_todos gains:
--   working_ms               the working time so far (closed working spans), ms. NULL = no working
--                            clock: the item was finished before D147 (its time is open time only).
--   working_span_started_at  when its current working span began (in progress and its session
--                            working); NULL otherwise.
--   working_share            how many items share that span (the session's items in progress with
--                            a working clock, each gets 1/share of its time); NULL with no span.
-- todo_actuals gains:
--   working_ms               the completed item's working time; NULL for an open-time-only row.
--   measure                  working (working_ms is what calibration and Insights' accuracy use) or
--                            open (only the D78 open time is known: excluded from calibration).
-- Every existing todo_actuals row is open-time only (measure open, working_ms NULL). Items not done
-- that were ever in progress start their working clock now (working_ms 0, no span open: the work
-- clock opens it when their session next works); their open time stays as history in actual_ms.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE session_todos ADD COLUMN working_ms INTEGER CHECK (working_ms IS NULL OR working_ms >= 0);
ALTER TABLE session_todos ADD COLUMN working_span_started_at TEXT;
ALTER TABLE session_todos ADD COLUMN working_share INTEGER CHECK (working_share IS NULL OR working_share >= 1);

UPDATE session_todos SET working_ms = 0 WHERE state IN ('open', 'in_progress') AND started_first_at IS NOT NULL;

ALTER TABLE todo_actuals ADD COLUMN working_ms INTEGER CHECK (working_ms IS NULL OR working_ms >= 0);
ALTER TABLE todo_actuals ADD COLUMN measure TEXT NOT NULL DEFAULT 'open' CHECK (measure IN ('open', 'working'));
