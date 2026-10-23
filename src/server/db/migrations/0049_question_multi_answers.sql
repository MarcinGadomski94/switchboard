-- 0049 · D128: a multi-select question keeps every choice (docs/questions.md → Multi-select answers).
-- questions.answer_indexes  JSON array of the picked option indexes, in option order, for a
--   multi-select answer (may be [] when the answer is only the developer's own words); NULL for a
--   single-select answer, an unanswered question and every row answered before 0049.
-- questions.answer_own      the developer's own words ("Other…", trimmed) given with a multi-select
--   answer; NULL otherwise. A single-select own answer stays as D39 stores it (answer_label with no
--   answer_index).
-- answer_index keeps the first picked index and answer_label the answer string sent to the CLI
-- (the labels and the own words joined the CLI's way), so readers before 0049 still see an answer.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE questions ADD COLUMN answer_indexes TEXT;
ALTER TABLE questions ADD COLUMN answer_own TEXT;
