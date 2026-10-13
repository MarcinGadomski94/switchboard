-- 0043 · Plans (D99, docs/plans.md): todo items grouped into a dependency graph that a
-- scheduler starts as todo runs (D76) by itself, each into the plan's target branch.
-- plans:
--   id                 10 hex characters (the service makes them).
--   title              the plan's name.
--   source_session_id  the session whose todo list holds the items (runs are cut from its folder);
--                      the plan goes with the session.
--   target_branch      the branch every item's work is merged into (the epic feature branch).
--   repos              JSON list of the solution names (a workspace) or the one repo name (a repo folder)
--                      the target branch lives in.
--   base_branch        the branch the target is merged into at the end, by the developer (default dev).
--   merge_mode         agents | agents-with-holds | developer; NULL until the plan is started (the
--                      developer must choose: there is no default).
--   max_concurrency    at most this many items run at once (default 3).
--   usage_threshold    no new item starts while the account it would use is at or above this percent
--                      of its 5-hour or weekly window (default 85).
--   answers            JSON of the plan-level start answers (work type, mode, phase, coordination, notes).
--   state              draft | running | paused | done | cancelled.
--   external           JSON {system, key} of the list it came from (the Jira lane), NULL = none.
--   held_reason        why new starts are held right now (usage), NULL = not held.
--   started_at / finished_at  when it was first started / became done or cancelled.
-- plan_items:
--   id                 10 hex characters.
--   plan_id            its plan; the rows go with the plan.
--   todo_id            the todo item it runs (in the source session's list); not a foreign key: a done
--                      todo is removed an hour later and the plan item keeps its own record.
--   key                optional ticket key (PROJ-123); names the item's branch with its slug.
--   title              the todo's title when it was added (kept after the todo is gone).
--   estimate_minutes   the todo's estimate when it was added or last read (critical path, time left).
--   hold               agents-with-holds: this item waits for the developer's Merge.
--   solutions          JSON list of the plan's repos this item works in (empty = all of them).
--   state              pending | running | done | failed.
--   reason             why it failed (discarded, could not start, ...), NULL otherwise.
--   note               a remark shown on the item (checks failed, no remote, ...), NULL = none.
--   waiting_on         review | checks | question | conflict while it waits on one of them, else NULL.
--   run_session_id     the session its run started; NULL before it starts. Not a foreign key (kept as history).
--   branch             the run's worktree branch.
--   cut                JSON {repo: sha} of the target branch's tip each worktree was cut from.
--   pr_url             the pull request last seen for its branch.
--   checks             JSON {state, summary, sha} of the last checks read; NULL = none read.
--   conflicts          how many times a conflict with the target branch was found (1 = the agent was
--                      asked to rebase; 2 = the developer was asked in the Inbox).
--   position           order in the plan.
--   started_at / waiting_since / merged_at / done_at   the timeline.
-- plan_edges: item to_item runs after item from_item (from_item is a dependency of to_item).
-- Never edit this file once it is committed: add a new NNNN_name.sql instead.

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  target_branch TEXT NOT NULL,
  repos TEXT NOT NULL DEFAULT '[]',
  base_branch TEXT NOT NULL DEFAULT 'dev',
  merge_mode TEXT CHECK (merge_mode IS NULL OR merge_mode IN ('agents', 'agents-with-holds', 'developer')),
  max_concurrency INTEGER NOT NULL DEFAULT 3,
  usage_threshold INTEGER NOT NULL DEFAULT 85,
  answers TEXT,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'running', 'paused', 'done', 'cancelled')),
  external TEXT,
  held_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
) STRICT;

CREATE INDEX plans_source ON plans (source_session_id);

CREATE TABLE plan_items (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  todo_id TEXT NOT NULL,
  key TEXT,
  title TEXT NOT NULL,
  estimate_minutes INTEGER,
  hold INTEGER NOT NULL DEFAULT 0 CHECK (hold IN (0, 1)),
  solutions TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'done', 'failed')),
  reason TEXT,
  note TEXT,
  waiting_on TEXT CHECK (waiting_on IS NULL OR waiting_on IN ('review', 'checks', 'question', 'conflict')),
  run_session_id TEXT,
  branch TEXT,
  cut TEXT,
  pr_url TEXT,
  checks TEXT,
  conflicts INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  waiting_since TEXT,
  merged_at TEXT,
  done_at TEXT
) STRICT;

CREATE INDEX plan_items_plan ON plan_items (plan_id, position);
CREATE INDEX plan_items_run ON plan_items (run_session_id);
CREATE UNIQUE INDEX plan_items_todo ON plan_items (plan_id, todo_id);

CREATE TABLE plan_edges (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  from_item TEXT NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
  to_item TEXT NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
  PRIMARY KEY (plan_id, from_item, to_item),
  CHECK (from_item != to_item)
) STRICT;
