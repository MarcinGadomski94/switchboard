-- 0056 · D166 "To review" (docs/inbox.md → *To review*): a finished turn that changed files is
-- unread until the developer reviews it (Mark reviewed, or a new message of theirs).
-- sessions gains:
--   review  JSON { pending: { since, turns, fileCount, files[] } | null, cursor: <event id> | null }
--           pending = the turns since the last review that changed files (NULL: nothing to review);
--           cursor  = the last event read for edits (the next turn's edits are read after it).
--           NULL for every session before 0056 (nothing to review; the first turn end starts it).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

ALTER TABLE sessions ADD COLUMN review TEXT;
