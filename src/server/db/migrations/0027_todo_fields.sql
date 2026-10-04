-- 0027 · a todo item's title, description and handover plan (D69, docs/todos.md).
-- session_todos (0026) gets three fields in place of its single text:
--   title        the D68 column `text`, renamed (its non-empty check follows it). One short
--                line, 1–120 characters (checked by the service).
--   description  for the developer: plain, brief Markdown, up to 4,000 characters; NULL = none.
--   plan         the handover plan for an AI agent (context, files, steps, acceptance
--                criteria), Markdown, up to 8,000 characters; NULL = none.
-- An existing text that is not one short line (several lines, or longer than 120
-- characters) keeps all of it as the description; its title is its first line, cut to
-- 119 characters + '…' (the same split as legacyTodoFields in src/core/todos.ts).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE session_todos RENAME COLUMN text TO title;
ALTER TABLE session_todos ADD COLUMN description TEXT;
ALTER TABLE session_todos ADD COLUMN plan TEXT;

UPDATE session_todos SET description = title WHERE instr(title, char(10)) > 0 OR length(title) > 120;
UPDATE session_todos SET title = trim(substr(title, 1, instr(title, char(10)) - 1), ' ' || char(9) || char(13)) WHERE instr(title, char(10)) > 0;
UPDATE session_todos SET title = substr(title, 1, 119) || '…' WHERE length(title) > 120;
