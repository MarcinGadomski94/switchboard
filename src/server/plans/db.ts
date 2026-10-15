import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db/database.ts';
import { type Migration, makeMigration, migrate } from '../db/migrate.ts';
import { PlanRepository } from './repo.ts';

/**
 * D99 · Plans' own SQLite file (`docs/plans.md` → *Storage*): `<dataDir>/plans.db`,
 * separate from `switchboard.db` so Plans can be removed by deleting the file
 * (`docs/plans-removal.md`). It is opened only while Plans is switched on (and created
 * then); it has its own small migration list, run by the main database's runner
 * (`db/migrate.ts`, the same one Team's `team.db` uses).
 *
 * A plan's source session and its items' run sessions live in `switchboard.db`: they are
 * plain ids here (no foreign key across files); the service deletes the plans of a source
 * session that is gone.
 */

/** The file inside the data folder. */
export const PLANS_DB_FILE = 'plans.db';

/** Plans' migrations (never edited once released; add a new one). */
export const PLANS_MIGRATIONS: readonly Migration[] = [
  makeMigration(
    1,
    'plans',
    `-- D99: Plans (docs/plans.md): todo items grouped into a dependency graph that a scheduler starts
-- as todo runs (D76) by itself, each into the plan's target branch.
-- plans:
--   id                 10 hex characters (the service makes them).
--   title              the plan's name.
--   source_session_id  the session (switchboard.db) whose todo list holds the items; the service
--                      deletes the plan when that session is deleted.
--   target_branch      the branch every item's work is merged into (the epic feature branch).
--   repos              JSON list of the solution names (a workspace) or the one repo name (a repo folder).
--   base_branch        the branch the target is merged into at the end, by the developer (default dev).
--   merge_mode         agents | agents-with-holds | developer; NULL until the plan is started (no default).
--   max_concurrency    at most this many items run at once (default 3).
--   usage_threshold    no new item starts while its account is at or above this percent (default 85).
--   answers            JSON of the plan-level start answers (work type, mode, phase, coordination, notes).
--   state              draft | running | paused | done | cancelled.
--   external           JSON {system, key} of the list it came from (the Jira lane), NULL = none.
--   held_reason        why new starts are held right now (usage), NULL = not held.
--   paused_reason      why Switchboard paused it (Plans was switched off), NULL = the developer paused it / not paused.
-- plan_items: one todo of the source session's list, its run and its merge (see repo.ts).
-- plan_edges: item to_item runs after item from_item.
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
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
  paused_reason TEXT,
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
`,
  ),
  makeMigration(
    2,
    'plan_item_spans',
    `-- D99 (the Plans page's Timeline): each item's history as spans of one kind, start to end.
-- kind: running (its agent works) | waiting-you (a question, its Review card, a second conflict, a stopped session)
--       | waiting-dependency (an item it runs after is not done) | paused-usage (ready, held by the usage threshold)
--       | paused-plan (the plan is paused, also by the switch). ended_at NULL = open (one open span per item at most).
CREATE TABLE plan_item_spans (
  id INTEGER PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('running', 'waiting-you', 'waiting-dependency', 'paused-usage', 'paused-plan')),
  started_at TEXT NOT NULL,
  ended_at TEXT
) STRICT;
CREATE INDEX plan_item_spans_item ON plan_item_spans (item_id, started_at);
CREATE INDEX plan_item_spans_plan_open ON plan_item_spans (plan_id) WHERE ended_at IS NULL;
`,
  ),
  makeMigration(
    3,
    'plans_any_target',
    `-- D99 follow-up 2026-10-15 (plans for anything, docs/plans.md): any target branch, or none.
-- plans.target_branch: '' (empty) = no target branch (a plan without a merge step); the column stays NOT NULL.
-- plans.no_merge: 1 = the merge mode is none (no merge step: an item is done when its todo is done);
--   merge_mode is then NULL (its CHECK predates none). 0 = merge_mode says the mode (NULL = a draft).
-- plans.allow_protected_target: 1 = the developer acknowledged that agents merge straight into a
--   protected target (dev, develop, main, master, the default or a protected branch).
ALTER TABLE plans ADD COLUMN no_merge INTEGER NOT NULL DEFAULT 0 CHECK (no_merge IN (0, 1));
ALTER TABLE plans ADD COLUMN allow_protected_target INTEGER NOT NULL DEFAULT 0 CHECK (allow_protected_target IN (0, 1));
`,
  ),
];

/** The Plans database: one connection and its repository. */
export class PlansDb {
  readonly #db: DatabaseSync;
  readonly file: string;
  readonly plans: PlanRepository;
  #closed = false;

  private constructor(db: DatabaseSync, file: string, now: () => string) {
    this.#db = db;
    this.file = file;
    this.plans = new PlanRepository({ db, now });
  }

  /**
   * Opens (creating when missing) `<dataDir>/plans.db` and brings it up to date.
   * @throws when the file cannot be opened or a migration fails (a broken file): Plans then answers 503 and runs nothing.
   */
  static async open(dataDir: string, now: () => string = () => new Date().toISOString(), migrations: readonly Migration[] = PLANS_MIGRATIONS): Promise<PlansDb> {
    const file = path.join(dataDir, PLANS_DB_FILE);
    const db = await openDatabase(file);
    try {
      migrate(db, migrations);
      // A quick read of every table: a file that is not a database (or lost a table) fails here, not later.
      for (const table of ['plans', 'plan_items', 'plan_edges', 'plan_item_spans']) db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    } catch (error) {
      db.close();
      throw error;
    }
    return new PlansDb(db, file, now);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  get closed(): boolean {
    return this.#closed;
  }
}
