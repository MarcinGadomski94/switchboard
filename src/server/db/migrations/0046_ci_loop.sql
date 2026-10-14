-- 0046 · the CI / pull-request feedback loop and the issue import (D109, docs/ci.md, docs/todos.md).
-- (0045 is left to the Insights lane, which was built at the same time.)
-- pr_watch: one row per worktree whose branch has a pull request the PR watcher follows.
--   worktree_id      the worktree (its session, repo and branch); removing the row's worktree record deletes it.
--   session_id       the worktree's session when the row was written (the header chip's lookup).
--   pr_number / pr_url / pr_state   the PR as gh last reported it (state: OPEN / MERGED / CLOSED).
--   checks           pending / green / red / none (no checks configured: counts as green).
--   summary          the failing / running checks, one line; NULL when green / none.
--   head_sha         the PR head the reading was for.
--   review           APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED; NULL = not required.
--   ready            1 = open, green and approved (or approval not required): the "ready to merge" Inbox item.
--   attempts         failure messages sent for this PR (at most Settings → CI → max attempts).
--   failure_sha      the head the last failure message was about (one message per red head).
--   signature        the last failure's signature (the same one twice in a row stops the loop).
--   stopped          NULL, 'cap' (attempts used up) or 'same-failure' (the breaker): no more messages until Try again.
--   checked_at / next_at   when gh was last asked, and when it is asked next.
-- todo_imports: the issues imported into a session's todo list (one row per issue per session), so a
--   re-import skips them, also after the todo was removed.
--   source           github / jira.
--   external_key     owner/repo#12 or PROJ-12.
--   url              the issue's link.
--   todo_id          the todo it became (the todo may be gone; the row stays).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE pr_watch (
  worktree_id TEXT PRIMARY KEY REFERENCES worktrees (id) ON DELETE CASCADE,
  session_id TEXT,
  pr_number INTEGER NOT NULL,
  pr_url TEXT,
  pr_state TEXT NOT NULL,
  checks TEXT NOT NULL DEFAULT 'none' CHECK (checks IN ('pending', 'green', 'red', 'none')),
  summary TEXT,
  head_sha TEXT,
  review TEXT,
  ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),
  attempts INTEGER NOT NULL DEFAULT 0,
  failure_sha TEXT,
  signature TEXT,
  stopped TEXT CHECK (stopped IS NULL OR stopped IN ('cap', 'same-failure')),
  checked_at TEXT,
  next_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX pr_watch_session ON pr_watch (session_id);

CREATE TABLE todo_imports (
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('github', 'jira')),
  external_key TEXT NOT NULL,
  url TEXT,
  todo_id TEXT,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (session_id, source, external_key)
) STRICT;
