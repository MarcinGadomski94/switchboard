-- 0035 · quick capture of todos (D81, docs/todos.md → Quick capture).
-- Three columns are added to session_todos (no rebuild, so this composes with any earlier
-- rebuild of the table; it assumes only the columns of 0026–0031):
--   needs_enrichment   1 = a captured item still waits for its agent to fill in its description,
--                      handover plan, priority and estimate (the card shows "✎ waiting for the agent
--                      to fill in"); the agent's todo_update on it (or the developer's own edit of
--                      those fields) sets it back to 0. Every existing row: 0.
--   captured_from      how it was captured: palette (⌘K `todo <text>` / Add todo…), selection
--                      (a chat selection's "Add to todo"), share (the phone's share sheet, D73's
--                      app as a Web Share Target); NULL for an item added any other way.
--   enrich_asked_at    when Switchboard sent the agent the one "fill it in" message for this item
--                      (its session was idle); NULL = not asked yet. At most one ask per item.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE session_todos ADD COLUMN needs_enrichment INTEGER NOT NULL DEFAULT 0 CHECK (needs_enrichment IN (0, 1));
ALTER TABLE session_todos ADD COLUMN captured_from TEXT CHECK (captured_from IS NULL OR captured_from IN ('palette', 'selection', 'share'));
ALTER TABLE session_todos ADD COLUMN enrich_asked_at TEXT;
