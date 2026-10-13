import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_JIRA_TRANSITIONS, JIRA_ACTIVITY_MAX, type JiraSyncMode, type JiraTransitionNames, type PlanJiraActivity } from '../../../core/plans-jira.ts';
import { transaction } from '../../db/database.ts';

/**
 * D99-Jira · the Jira tables, in Plans' own database (`plans.db`, `docs/plans.md` →
 * *Storage*): created when missing (`CREATE TABLE IF NOT EXISTS`, so they never take a number
 * from the core's migration list) and dropped with the file when Plans is removed.
 *
 * - `plan_jira`: one row per imported plan: the epic, the base URL it came from, the sync
 *   mode, the transition names, the last refresh;
 * - `plan_jira_items`: one row per item: its issue key, the status at import and as last read,
 *   the drift and the last soft failure, the question episode the write mode is in;
 * - `plan_jira_writes`: one row per write event (`start:<run>`, `pr-transition:<url>`, …):
 *   `done` / `soft` (a missing transition: never retried) / `pending` (a transient failure,
 *   retried) with its attempts, so a retry never writes twice;
 * - `plan_jira_activity`: what the sync did, newest {@link JIRA_ACTIVITY_MAX} per plan;
 * - `plan_edge_proposals`: dependencies the source session's agent proposed
 *   (`plan_propose_dependencies`), pending / accepted / rejected, for any plan (not only Jira's).
 *
 * No secret is stored here: the credentials live in the keychain or the environment.
 */
export const PLAN_JIRA_SCHEMA = `
CREATE TABLE IF NOT EXISTS plan_jira (
  plan_id          TEXT PRIMARY KEY,
  epic_key         TEXT NOT NULL,
  base_url         TEXT NOT NULL,
  sync             TEXT NOT NULL DEFAULT 'off' CHECK (sync IN ('off', 'read-only', 'write')),
  transitions      TEXT NOT NULL CHECK (json_valid(transitions)),
  last_refresh_at  TEXT,
  created_at       TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS plan_jira_items (
  item_id           TEXT PRIMARY KEY,
  plan_id           TEXT NOT NULL REFERENCES plan_jira (plan_id) ON DELETE CASCADE,
  issue_key         TEXT NOT NULL,
  status_at_import  TEXT,
  status            TEXT,
  status_category   TEXT,
  summary           TEXT,
  refreshed_at      TEXT,
  drift             TEXT,
  sync_note         TEXT,
  question_open     INTEGER NOT NULL DEFAULT 0,
  question_count    INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS plan_jira_items_plan ON plan_jira_items (plan_id);
CREATE TABLE IF NOT EXISTS plan_jira_writes (
  item_id    TEXT NOT NULL,
  event      TEXT NOT NULL,
  plan_id    TEXT NOT NULL REFERENCES plan_jira (plan_id) ON DELETE CASCADE,
  state      TEXT NOT NULL CHECK (state IN ('pending', 'done', 'soft', 'failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  at         TEXT NOT NULL,
  PRIMARY KEY (item_id, event)
) STRICT;
CREATE TABLE IF NOT EXISTS plan_jira_activity (
  id        TEXT PRIMARY KEY,
  plan_id   TEXT NOT NULL REFERENCES plan_jira (plan_id) ON DELETE CASCADE,
  at        TEXT NOT NULL,
  item_id   TEXT,
  issue_key TEXT,
  kind      TEXT NOT NULL,
  text      TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS plan_jira_activity_plan_at ON plan_jira_activity (plan_id, at);
CREATE TABLE IF NOT EXISTS plan_edge_proposals (
  id          TEXT PRIMARY KEY,
  plan_id     TEXT NOT NULL,
  from_item   TEXT NOT NULL,
  to_item     TEXT NOT NULL,
  reason      TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'rejected')),
  note        TEXT,
  created_at  TEXT NOT NULL,
  decided_at  TEXT,
  UNIQUE (plan_id, from_item, to_item)
) STRICT;
CREATE INDEX IF NOT EXISTS plan_edge_proposals_plan ON plan_edge_proposals (plan_id);
`;

/** A plan's Jira row. */
export interface PlanJiraRecord {
  readonly planId: string;
  readonly epicKey: string;
  readonly baseUrl: string;
  readonly sync: JiraSyncMode;
  readonly transitions: JiraTransitionNames;
  readonly lastRefreshAt: string | null;
  readonly createdAt: string;
}

/** An item's Jira row. */
export interface PlanJiraItemRecord {
  readonly itemId: string;
  readonly planId: string;
  readonly key: string;
  readonly statusAtImport: string | null;
  readonly status: string | null;
  readonly statusCategory: string | null;
  readonly summary: string | null;
  readonly refreshedAt: string | null;
  readonly drift: string | null;
  readonly syncNote: string | null;
  readonly questionOpen: boolean;
  readonly questionCount: number;
}

/** A proposal's row. */
export interface PlanEdgeProposalRecord {
  readonly id: string;
  readonly planId: string;
  readonly fromItemId: string;
  readonly toItemId: string;
  readonly reason: string;
  readonly state: 'pending' | 'accepted' | 'rejected';
  readonly note: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

/** A write event's row. */
export interface PlanJiraWriteRecord {
  readonly state: 'pending' | 'done' | 'soft' | 'failed';
  readonly attempts: number;
}

type Row = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readTransitions(value: unknown): JiraTransitionNames {
  try {
    const parsed = JSON.parse(String(value)) as Record<string, unknown>;
    return {
      inProgress: typeof parsed['inProgress'] === 'string' ? parsed['inProgress'] : DEFAULT_JIRA_TRANSITIONS.inProgress,
      inReview: typeof parsed['inReview'] === 'string' ? parsed['inReview'] : DEFAULT_JIRA_TRANSITIONS.inReview,
    };
  } catch {
    return DEFAULT_JIRA_TRANSITIONS;
  }
}

function planRow(row: Row): PlanJiraRecord {
  return {
    planId: String(row['plan_id']),
    epicKey: String(row['epic_key']),
    baseUrl: String(row['base_url']),
    sync: String(row['sync']) as JiraSyncMode,
    transitions: readTransitions(row['transitions']),
    lastRefreshAt: text(row['last_refresh_at']),
    createdAt: String(row['created_at']),
  };
}

function itemRow(row: Row): PlanJiraItemRecord {
  return {
    itemId: String(row['item_id']),
    planId: String(row['plan_id']),
    key: String(row['issue_key']),
    statusAtImport: text(row['status_at_import']),
    status: text(row['status']),
    statusCategory: text(row['status_category']),
    summary: text(row['summary']),
    refreshedAt: text(row['refreshed_at']),
    drift: text(row['drift']),
    syncNote: text(row['sync_note']),
    questionOpen: Number(row['question_open']) === 1,
    questionCount: Number(row['question_count']),
  };
}

/** The Jira tables over a `plans.db` connection (synchronous `node:sqlite` behind async methods, like the main store). */
export class PlanJiraStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    db.exec(PLAN_JIRA_SCHEMA);
  }

  #iso(): string {
    return this.#now().toISOString();
  }

  /** Records an imported plan and its items (one transaction). */
  async createPlan(input: { readonly planId: string; readonly epicKey: string; readonly baseUrl: string; readonly sync: JiraSyncMode; readonly transitions: JiraTransitionNames; readonly items: ReadonlyArray<{ readonly itemId: string; readonly key: string; readonly status: string | null; readonly statusCategory: string | null; readonly summary: string }> }): Promise<void> {
    const at = this.#iso();
    transaction(this.#db, () => {
      this.#db.prepare('INSERT INTO plan_jira (plan_id, epic_key, base_url, sync, transitions, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(input.planId, input.epicKey, input.baseUrl, input.sync, JSON.stringify(input.transitions), at);
      const insert = this.#db.prepare('INSERT INTO plan_jira_items (item_id, plan_id, issue_key, status_at_import, status, status_category, summary) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const item of input.items) insert.run(item.itemId, input.planId, item.key, item.status, item.status, item.statusCategory, item.summary);
    });
  }

  async plan(planId: string): Promise<PlanJiraRecord | null> {
    const row = this.#db.prepare('SELECT * FROM plan_jira WHERE plan_id = ?').get(planId) as Row | undefined;
    return row ? planRow(row) : null;
  }

  async plans(): Promise<PlanJiraRecord[]> {
    return (this.#db.prepare('SELECT * FROM plan_jira ORDER BY created_at').all() as Row[]).map(planRow);
  }

  async updatePlan(planId: string, patch: { readonly sync?: JiraSyncMode; readonly transitions?: JiraTransitionNames; readonly lastRefreshAt?: string }): Promise<void> {
    if (patch.sync !== undefined) this.#db.prepare('UPDATE plan_jira SET sync = ? WHERE plan_id = ?').run(patch.sync, planId);
    if (patch.transitions !== undefined) this.#db.prepare('UPDATE plan_jira SET transitions = ? WHERE plan_id = ?').run(JSON.stringify(patch.transitions), planId);
    if (patch.lastRefreshAt !== undefined) this.#db.prepare('UPDATE plan_jira SET last_refresh_at = ? WHERE plan_id = ?').run(patch.lastRefreshAt, planId);
  }

  /** Forgets a plan (its plan was deleted): items, writes and activity go with it. */
  async deletePlan(planId: string): Promise<void> {
    this.#db.prepare('DELETE FROM plan_jira WHERE plan_id = ?').run(planId);
    this.#db.prepare('DELETE FROM plan_edge_proposals WHERE plan_id = ?').run(planId);
  }

  /** Adds a pending proposal; `false` when the pair was proposed before (any state). */
  async addProposal(input: { readonly id: string; readonly planId: string; readonly fromItemId: string; readonly toItemId: string; readonly reason: string }): Promise<boolean> {
    const result = this.#db
      .prepare('INSERT INTO plan_edge_proposals (id, plan_id, from_item, to_item, reason, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (plan_id, from_item, to_item) DO NOTHING')
      .run(input.id, input.planId, input.fromItemId, input.toItemId, input.reason, this.#iso());
    return Number(result.changes) > 0;
  }

  /** A plan's proposals, oldest first. */
  async proposals(planId: string): Promise<PlanEdgeProposalRecord[]> {
    return (this.#db.prepare('SELECT * FROM plan_edge_proposals WHERE plan_id = ? ORDER BY created_at, rowid').all(planId) as Row[]).map((row) => ({
      id: String(row['id']),
      planId: String(row['plan_id']),
      fromItemId: String(row['from_item']),
      toItemId: String(row['to_item']),
      reason: String(row['reason']),
      state: String(row['state']) as PlanEdgeProposalRecord['state'],
      note: text(row['note']),
      createdAt: String(row['created_at']),
      decidedAt: text(row['decided_at']),
    }));
  }

  async decideProposal(id: string, patch: { readonly state: PlanEdgeProposalRecord['state']; readonly note: string | null }): Promise<void> {
    this.#db.prepare('UPDATE plan_edge_proposals SET state = ?, note = ?, decided_at = ? WHERE id = ?').run(patch.state, patch.note, patch.state === 'pending' ? null : this.#iso(), id);
  }

  async items(planId: string): Promise<PlanJiraItemRecord[]> {
    return (this.#db.prepare('SELECT * FROM plan_jira_items WHERE plan_id = ? ORDER BY rowid').all(planId) as Row[]).map(itemRow);
  }

  async updateItem(itemId: string, patch: Partial<Pick<PlanJiraItemRecord, 'status' | 'statusCategory' | 'summary' | 'refreshedAt' | 'drift' | 'syncNote' | 'questionOpen' | 'questionCount'>>): Promise<void> {
    const columns: Record<string, string> = { status: 'status', statusCategory: 'status_category', summary: 'summary', refreshedAt: 'refreshed_at', drift: 'drift', syncNote: 'sync_note', questionOpen: 'question_open', questionCount: 'question_count' };
    for (const [field, value] of Object.entries(patch)) {
      const column = columns[field];
      if (!column || value === undefined) continue;
      this.#db.prepare(`UPDATE plan_jira_items SET ${column} = ? WHERE item_id = ?`).run(typeof value === 'boolean' ? (value ? 1 : 0) : (value as string | number | null), itemId);
    }
  }

  async write(itemId: string, event: string): Promise<PlanJiraWriteRecord | null> {
    const row = this.#db.prepare('SELECT state, attempts FROM plan_jira_writes WHERE item_id = ? AND event = ?').get(itemId, event) as Row | undefined;
    return row ? { state: String(row['state']) as PlanJiraWriteRecord['state'], attempts: Number(row['attempts']) } : null;
  }

  async setWrite(planId: string, itemId: string, event: string, state: PlanJiraWriteRecord['state'], attempts: number): Promise<void> {
    this.#db
      .prepare('INSERT INTO plan_jira_writes (item_id, event, plan_id, state, attempts, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (item_id, event) DO UPDATE SET state = excluded.state, attempts = excluded.attempts, at = excluded.at')
      .run(itemId, event, planId, state, attempts, this.#iso());
  }

  /** Adds an activity line (the oldest beyond {@link JIRA_ACTIVITY_MAX} go). */
  async addActivity(planId: string, entry: Omit<PlanJiraActivity, 'id' | 'at'>): Promise<PlanJiraActivity> {
    const line: PlanJiraActivity = { id: randomBytes(5).toString('hex'), at: this.#iso(), ...entry };
    transaction(this.#db, () => {
      this.#db.prepare('INSERT INTO plan_jira_activity (id, plan_id, at, item_id, issue_key, kind, text) VALUES (?, ?, ?, ?, ?, ?, ?)').run(line.id, planId, line.at, line.itemId, line.key, line.kind, line.text);
      this.#db
        .prepare('DELETE FROM plan_jira_activity WHERE plan_id = ? AND id NOT IN (SELECT id FROM plan_jira_activity WHERE plan_id = ? ORDER BY at DESC, rowid DESC LIMIT ?)')
        .run(planId, planId, JIRA_ACTIVITY_MAX);
    });
    return line;
  }

  /** Newest first. */
  async activity(planId: string): Promise<PlanJiraActivity[]> {
    return (this.#db.prepare('SELECT * FROM plan_jira_activity WHERE plan_id = ? ORDER BY at DESC, rowid DESC').all(planId) as Row[]).map((row) => ({
      id: String(row['id']),
      at: String(row['at']),
      itemId: text(row['item_id']),
      key: text(row['issue_key']),
      kind: String(row['kind']) as PlanJiraActivity['kind'],
      text: String(row['text']),
    }));
  }
}
