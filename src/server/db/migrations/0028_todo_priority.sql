-- 0028 · a todo item's priority and estimate; its plan is mandatory (D70, docs/todos.md).
-- session_todos (0026, 0027) gets two columns and its empty plans filled:
--   priority          urgent / high / medium / low; existing items are medium. Open items
--                     sort by it (urgent first), their position within a level.
--   estimate_minutes  how long an AI agent would take to do the item (development time),
--                     whole minutes 1–10,080; NULL = not estimated (every existing item).
--   plan              (0027) now mandatory: an item with nothing to plan says 'No plan' (an
--                     agent: 'No plan: <reason>'). Existing items without one get 'No plan'.
--                     The column stays nullable (no table rebuild); the service never stores
--                     an empty plan.
-- Titles and descriptions are not touched (0027's split of long texts stays as it is).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE session_todos ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('urgent', 'high', 'medium', 'low'));
ALTER TABLE session_todos ADD COLUMN estimate_minutes INTEGER CHECK (estimate_minutes IS NULL OR (estimate_minutes BETWEEN 1 AND 10080));

UPDATE session_todos SET plan = 'No plan' WHERE plan IS NULL OR trim(plan, ' ' || char(9) || char(10) || char(13)) = '';
