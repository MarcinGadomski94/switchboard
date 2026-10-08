-- 0037 · the interactive tutorial (D85, docs/tutorial.md): which tours this machine has seen.
-- tutorial_tours:
--   tour        'main' (the main tour) or a What's-new feature id (src/core/tutorial.ts → WHATS_NEW).
--   status      pending (opens by itself when the UI loads) / completed (Next on its last step) /
--               skipped (Skip tour or Esc). A tour with no row was never queued (a replay still works).
--   version     the Switchboard version when the row was last written.
--   updated_at  when it was queued, finished or skipped.
-- settings 'tutorial.lastVersion' (a JSON string; the service's own key, not a preference): the
-- version the tutorial system last ran on. Set here only for an install that already has data
-- (a session, a schedule, a saved folder or a finished setup): it starts from 1.12.0, the last
-- version before the tutorial, so it gets the What's-new mini-tours of what came after and not
-- the main tour. A brand-new database gets no row; the service then queues the main tour.
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE tutorial_tours (
  tour        TEXT PRIMARY KEY,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'skipped')),
  version     TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;

INSERT INTO settings (key, value, updated_at)
SELECT 'tutorial.lastVersion', '"1.12.0"', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM sessions)
   OR EXISTS (SELECT 1 FROM schedules)
   OR EXISTS (SELECT 1 FROM folders)
   OR EXISTS (SELECT 1 FROM settings WHERE key = 'setup.completedAt');
