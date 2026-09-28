-- 0009 · the session's model and effort (D31, docs/model-effort.md).
-- sessions:
--   model          the model chosen in the session header (`PUT /api/sessions/{id}/model`),
--                  passed as `--model` on every spawn (new, resume, restart recovery,
--                  attach, moves) and sent to a live process as `set_model`. NULL = the
--                  CLI's default (no `--model`), as for every session before this migration.
--   effort         the effort level, passed as `--effort` and sent to a live process as
--                  `apply_flag_settings {effortLevel}`. NULL = the CLI's default.
--   model_options  JSON: the models the session's last claude process reported in its
--                  `initialize` reply (`[{value, label, description?, efforts?}]`, read by
--                  src/core/model-choice.ts); replaced by each new process that reports
--                  a list, kept after the process ends. NULL = no process reported one yet
--                  (the pickers are disabled; the demo seed).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE sessions ADD COLUMN model TEXT;
ALTER TABLE sessions ADD COLUMN effort TEXT;
ALTER TABLE sessions ADD COLUMN model_options TEXT;
