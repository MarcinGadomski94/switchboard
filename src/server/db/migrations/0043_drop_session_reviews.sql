-- 0043 · review cards removed (D102 supersedes D79, docs/decisions.md).
-- session_reviews (0033) is dropped with its indexes: nothing reads it any more.
-- Todo items still in review (D76's state, 0032) become done: a run item marked done now goes
-- straight to done. Their done time is now, so the done hour removes them like any other done
-- item; their actuals (todo_actuals) were recorded when they went into review and stay.
-- session_todos keeps 'review' in its state CHECK (changing a CHECK needs a table rebuild, as
-- 0031 / 0032 did): nothing writes it any more, and a value read back is treated as done.
-- The review cards' drafts (D88 keys review:<id> and commit:<id>) and the setting
-- sessions.reviewCards are deleted.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

UPDATE session_todos
  SET state = 'done',
      done_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE state = 'review';

DROP INDEX IF EXISTS session_reviews_session;
DROP INDEX IF EXISTS session_reviews_state;
DROP TABLE IF EXISTS session_reviews;

DELETE FROM session_drafts WHERE field LIKE 'review:%' OR field LIKE 'commit:%';

DELETE FROM settings WHERE key = 'sessions.reviewCards';
