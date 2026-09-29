-- 0015 · the context window meter (D49, docs/chat.md → Context bar).
-- sessions:
--   context  JSON: how full the main agent's context window is and when the CLI
--            last compacted it (`ContextState` of src/core/context-meter.ts:
--            tokens, model, initModel, windows, updatedAt, compaction,
--            compactedRecently, compactTurnEnded), written by the stream
--            recorder from each main-agent usage, result and compact boundary,
--            and by a terminal-turn import. NULL = nothing seen yet (every
--            session before this migration, until its next reply).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE sessions ADD COLUMN context TEXT;
