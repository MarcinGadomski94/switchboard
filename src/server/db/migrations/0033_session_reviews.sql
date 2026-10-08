-- 0033 · review cards (D79, docs/reviews.md): when a session with changes goes idle it gets a
-- Review card, once per change set.
-- session_reviews:
--   id            the card's id (12 hex characters).
--   session_id    the session it reviews (removed with it).
--   fingerprint   a hash of the session's change set when the card was raised or last read
--                 (each repo's HEAD, uncommitted diff and untracked files): a turn end with
--                 the same fingerprint as the newest card does not raise another one.
--   state         pending (waits for the developer) / cleanup (merged or discarded, Clean up
--                 still offered) / resolved.
--   outcome       merged / committed / discarded / sent-back / dismissed once resolved; NULL
--                 while pending.
--   created_at, updated_at, resolved_at
--                 when raised, last read from git (or changed), resolved (NULL while pending).
--   data          the card as last read (JSON: mode, repos, files, commits, summary, tests,
--                 note, conflicts); the service owns its shape.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE session_reviews (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'cleanup', 'resolved')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('merged', 'committed', 'discarded', 'sent-back', 'dismissed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  CHECK ((state = 'pending') = (outcome IS NULL)),
  CHECK ((state = 'pending') = (resolved_at IS NULL))
) STRICT;

CREATE INDEX session_reviews_session ON session_reviews (session_id, created_at);
CREATE INDEX session_reviews_state ON session_reviews (state);
