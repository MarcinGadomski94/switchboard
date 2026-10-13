import type { StatementSync } from 'node:sqlite';
import type { PlanAnswers, PlanChecks, PlanEdge, PlanExternalRef, PlanItemSpan, PlanItemSpanKind, PlanItemStoredState, PlanMergeMode, PlanState, PlanWaitingOn } from '../../core/plans.ts';
import type { RepoContext } from '../db/context.ts';
import { transaction } from '../db/database.ts';

/** D99 (`plans.db`): a stored plan (`plans`). */
export interface PlanRecord {
  readonly id: string;
  readonly title: string;
  readonly sourceSessionId: string;
  readonly targetBranch: string;
  readonly repos: readonly string[];
  readonly baseBranch: string;
  readonly mergeMode: PlanMergeMode | null;
  readonly maxConcurrency: number;
  readonly usageThreshold: number;
  readonly answers: PlanAnswers | null;
  readonly state: PlanState;
  readonly external: PlanExternalRef | null;
  readonly heldReason: string | null;
  /** Why the plan was paused when Switchboard paused it (Plans switched off), `null` = by the developer or not paused. */
  readonly pausedReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/** D99 (`plans.db`): a stored plan item (`plan_items`). */
export interface PlanItemRecord {
  readonly id: string;
  readonly planId: string;
  readonly todoId: string;
  readonly key: string | null;
  readonly title: string;
  readonly estimateMinutes: number | null;
  readonly hold: boolean;
  readonly solutions: readonly string[];
  readonly state: PlanItemStoredState;
  readonly reason: string | null;
  readonly note: string | null;
  readonly waitingOn: PlanWaitingOn | null;
  readonly runSessionId: string | null;
  readonly branch: string | null;
  /** The target's tip each worktree was cut from (`repo` → sha). */
  readonly cut: Readonly<Record<string, string>>;
  readonly prUrl: string | null;
  readonly checks: PlanChecks | null;
  readonly conflicts: number;
  readonly position: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly waitingSince: string | null;
  readonly mergedAt: string | null;
  readonly doneAt: string | null;
}

/** What a plan create stores. */
export type PlanCreate = Pick<PlanRecord, 'id' | 'title' | 'sourceSessionId' | 'targetBranch' | 'repos' | 'baseBranch' | 'maxConcurrency' | 'usageThreshold' | 'answers' | 'external'>;

/** The plan fields an update may change. */
export type PlanPatch = Partial<Omit<PlanRecord, 'id' | 'sourceSessionId' | 'createdAt' | 'updatedAt'>>;

/** What an item create stores. */
export type PlanItemCreate = Pick<PlanItemRecord, 'id' | 'planId' | 'todoId' | 'key' | 'title' | 'estimateMinutes' | 'hold' | 'solutions'>;

/** The item fields an update may change. */
export type PlanItemPatch = Partial<Omit<PlanItemRecord, 'id' | 'planId' | 'todoId' | 'position' | 'createdAt' | 'updatedAt'>>;

type Row = Record<string, string | number | null>;

function json<T>(value: string | number | null, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function text(value: string | number | null): string | null {
  return value === null ? null : String(value);
}

function planOf(row: Row): PlanRecord {
  return {
    id: String(row['id']),
    title: String(row['title']),
    sourceSessionId: String(row['source_session_id']),
    targetBranch: String(row['target_branch']),
    repos: json<string[]>(row['repos'] ?? null, []),
    baseBranch: String(row['base_branch']),
    mergeMode: text(row['merge_mode'] ?? null) as PlanMergeMode | null,
    maxConcurrency: Number(row['max_concurrency']),
    usageThreshold: Number(row['usage_threshold']),
    answers: json<PlanAnswers | null>(row['answers'] ?? null, null),
    state: String(row['state']) as PlanState,
    external: json<PlanExternalRef | null>(row['external'] ?? null, null),
    heldReason: text(row['held_reason'] ?? null),
    pausedReason: text(row['paused_reason'] ?? null),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
    startedAt: text(row['started_at'] ?? null),
    finishedAt: text(row['finished_at'] ?? null),
  };
}

function itemOf(row: Row): PlanItemRecord {
  return {
    id: String(row['id']),
    planId: String(row['plan_id']),
    todoId: String(row['todo_id']),
    key: text(row['key'] ?? null),
    title: String(row['title']),
    estimateMinutes: row['estimate_minutes'] === null || row['estimate_minutes'] === undefined ? null : Number(row['estimate_minutes']),
    hold: Number(row['hold']) === 1,
    solutions: json<string[]>(row['solutions'] ?? null, []),
    state: String(row['state']) as PlanItemStoredState,
    reason: text(row['reason'] ?? null),
    note: text(row['note'] ?? null),
    waitingOn: text(row['waiting_on'] ?? null) as PlanWaitingOn | null,
    runSessionId: text(row['run_session_id'] ?? null),
    branch: text(row['branch'] ?? null),
    cut: json<Record<string, string>>(row['cut'] ?? null, {}),
    prUrl: text(row['pr_url'] ?? null),
    checks: json<PlanChecks | null>(row['checks'] ?? null, null),
    conflicts: Number(row['conflicts'] ?? 0),
    position: Number(row['position']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
    startedAt: text(row['started_at'] ?? null),
    waitingSince: text(row['waiting_since'] ?? null),
    mergedAt: text(row['merged_at'] ?? null),
    doneAt: text(row['done_at'] ?? null),
  };
}

/** Plan field → column, with how its value is stored. */
const PLAN_COLUMNS: Readonly<Record<string, readonly [column: string, kind: 'text' | 'int' | 'json']>> = {
  title: ['title', 'text'],
  targetBranch: ['target_branch', 'text'],
  repos: ['repos', 'json'],
  baseBranch: ['base_branch', 'text'],
  mergeMode: ['merge_mode', 'text'],
  maxConcurrency: ['max_concurrency', 'int'],
  usageThreshold: ['usage_threshold', 'int'],
  answers: ['answers', 'json'],
  state: ['state', 'text'],
  external: ['external', 'json'],
  heldReason: ['held_reason', 'text'],
  pausedReason: ['paused_reason', 'text'],
  startedAt: ['started_at', 'text'],
  finishedAt: ['finished_at', 'text'],
};

const ITEM_COLUMNS: Readonly<Record<string, readonly [column: string, kind: 'text' | 'int' | 'json' | 'bool']>> = {
  key: ['key', 'text'],
  title: ['title', 'text'],
  estimateMinutes: ['estimate_minutes', 'int'],
  hold: ['hold', 'bool'],
  solutions: ['solutions', 'json'],
  state: ['state', 'text'],
  reason: ['reason', 'text'],
  note: ['note', 'text'],
  waitingOn: ['waiting_on', 'text'],
  runSessionId: ['run_session_id', 'text'],
  branch: ['branch', 'text'],
  cut: ['cut', 'json'],
  prUrl: ['pr_url', 'text'],
  checks: ['checks', 'json'],
  conflicts: ['conflicts', 'int'],
  startedAt: ['started_at', 'text'],
  waitingSince: ['waiting_since', 'text'],
  mergedAt: ['merged_at', 'text'],
  doneAt: ['done_at', 'text'],
};

function stored(value: unknown, kind: 'text' | 'int' | 'json' | 'bool'): string | number | null {
  if (value === null || value === undefined) return null;
  if (kind === 'json') return JSON.stringify(value);
  if (kind === 'bool') return value === true ? 1 : 0;
  if (kind === 'int') return Number(value);
  return String(value);
}

/**
 * D99: plans, their items and dependency edges (`plans`, `plan_items`, `plan_edges` in Plans'
 * own `plans.db`, `db.ts`, `docs/plans.md`). Items and edges go with their plan (`ON DELETE
 * CASCADE`). A plan's source session lives in `switchboard.db`, so the service deletes the plans
 * of a session that is gone itself ({@link PlanRepository.sourceSessionIds}).
 */
export class PlanRepository {
  readonly #ctx: RepoContext;
  readonly #statements = new Map<string, StatementSync>();

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
  }

  #statement(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#ctx.db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  // ── plans ───────────────────────────────────────────────────────────────

  async list(filter: { readonly sourceSessionId?: string; readonly states?: readonly PlanState[] } = {}): Promise<PlanRecord[]> {
    const rows = this.#statement('SELECT * FROM plans ORDER BY created_at, rowid').all() as unknown as Row[];
    return rows
      .map(planOf)
      .filter((plan) => (filter.sourceSessionId === undefined || plan.sourceSessionId === filter.sourceSessionId) && (filter.states === undefined || filter.states.includes(plan.state)));
  }

  async get(id: string): Promise<PlanRecord | null> {
    const row = this.#statement('SELECT * FROM plans WHERE id = ?').get(id) as unknown as Row | undefined;
    return row ? planOf(row) : null;
  }

  /** D99 seam for the Jira lane: the plans made from an external list. */
  async findByExternal(system: string, key: string): Promise<PlanRecord[]> {
    const rows = this.#statement("SELECT * FROM plans WHERE json_extract(external, '$.system') = ? AND json_extract(external, '$.key') = ? ORDER BY created_at, rowid").all(system, key) as unknown as Row[];
    return rows.map(planOf);
  }

  async create(input: PlanCreate): Promise<PlanRecord> {
    const now = this.#ctx.now();
    this.#statement(
      `INSERT INTO plans (id, title, source_session_id, target_branch, repos, base_branch, max_concurrency, usage_threshold, answers, external, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    ).run(
      input.id,
      input.title,
      input.sourceSessionId,
      input.targetBranch,
      JSON.stringify(input.repos),
      input.baseBranch,
      input.maxConcurrency,
      input.usageThreshold,
      input.answers === null ? null : JSON.stringify(input.answers),
      input.external === null ? null : JSON.stringify(input.external),
      now,
      now,
    );
    return (await this.get(input.id)) as PlanRecord;
  }

  async update(id: string, patch: PlanPatch): Promise<PlanRecord | null> {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, value] of Object.entries(patch)) {
      const spec = PLAN_COLUMNS[key];
      if (!spec || value === undefined) continue;
      sets.push(`${spec[0]} = ?`);
      values.push(stored(value, spec[1]));
    }
    sets.push('updated_at = ?');
    values.push(this.#ctx.now());
    this.#ctx.db.prepare(`UPDATE plans SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return this.get(id);
  }

  /** Marks the plan changed (its `updated_at`), e.g. after an item or an edge changed. */
  async touch(id: string): Promise<void> {
    this.#statement('UPDATE plans SET updated_at = ? WHERE id = ?').run(this.#ctx.now(), id);
  }

  async delete(id: string): Promise<boolean> {
    return Number(this.#statement('DELETE FROM plans WHERE id = ?').run(id).changes) > 0;
  }

  /** The distinct source sessions of the stored plans (the service prunes the plans of a deleted session). */
  async sourceSessionIds(): Promise<string[]> {
    return (this.#statement('SELECT DISTINCT source_session_id AS s FROM plans').all() as unknown as Row[]).map((row) => String(row['s']));
  }

  /** D83: a continued session's plans follow it to the fresh session. */
  async moveSource(fromSessionId: string, toSessionId: string): Promise<number> {
    return Number(this.#statement('UPDATE plans SET source_session_id = ?, updated_at = ? WHERE source_session_id = ?').run(toSessionId, this.#ctx.now(), fromSessionId).changes);
  }

  /** D83: an item whose run session was continued in a fresh one is run by the fresh session from then on. */
  async moveRunSession(fromSessionId: string, toSessionId: string): Promise<number> {
    return Number(this.#statement('UPDATE plan_items SET run_session_id = ?, updated_at = ? WHERE run_session_id = ?').run(toSessionId, this.#ctx.now(), fromSessionId).changes);
  }

  /** The distinct run sessions of the items (the service follows continued ones). */
  async runSessionIds(): Promise<string[]> {
    return (this.#statement('SELECT DISTINCT run_session_id AS s FROM plan_items WHERE run_session_id IS NOT NULL').all() as unknown as Row[]).map((row) => String(row['s']));
  }

  // ── items ───────────────────────────────────────────────────────────────

  async items(planId: string): Promise<PlanItemRecord[]> {
    return (this.#statement('SELECT * FROM plan_items WHERE plan_id = ? ORDER BY position, rowid').all(planId) as unknown as Row[]).map(itemOf);
  }

  async item(id: string): Promise<PlanItemRecord | null> {
    const row = this.#statement('SELECT * FROM plan_items WHERE id = ?').get(id) as unknown as Row | undefined;
    return row ? itemOf(row) : null;
  }

  /** The items whose run session is `sessionId` (normally one). */
  async itemsByRunSession(sessionId: string): Promise<PlanItemRecord[]> {
    return (this.#statement('SELECT * FROM plan_items WHERE run_session_id = ? ORDER BY created_at, rowid').all(sessionId) as unknown as Row[]).map(itemOf);
  }

  /** Adds an item at the end of its plan. */
  async addItem(input: PlanItemCreate): Promise<PlanItemRecord> {
    const now = this.#ctx.now();
    const last = this.#statement('SELECT MAX(position) AS p FROM plan_items WHERE plan_id = ?').get(input.planId) as { p: number | null } | undefined;
    const position = last?.p === null || last?.p === undefined ? 0 : Number(last.p) + 1;
    this.#statement(
      `INSERT INTO plan_items (id, plan_id, todo_id, key, title, estimate_minutes, hold, solutions, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.id, input.planId, input.todoId, input.key, input.title, input.estimateMinutes, input.hold ? 1 : 0, JSON.stringify(input.solutions), position, now, now);
    return (await this.item(input.id)) as PlanItemRecord;
  }

  async updateItem(id: string, patch: PlanItemPatch): Promise<PlanItemRecord | null> {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, value] of Object.entries(patch)) {
      const spec = ITEM_COLUMNS[key];
      if (!spec || value === undefined) continue;
      sets.push(`${spec[0]} = ?`);
      values.push(stored(value, spec[1]));
    }
    sets.push('updated_at = ?');
    values.push(this.#ctx.now());
    this.#ctx.db.prepare(`UPDATE plan_items SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return this.item(id);
  }

  async removeItem(id: string): Promise<boolean> {
    return Number(this.#statement('DELETE FROM plan_items WHERE id = ?').run(id).changes) > 0;
  }

  // ── edges ───────────────────────────────────────────────────────────────

  async edges(planId: string): Promise<PlanEdge[]> {
    return (this.#statement('SELECT from_item, to_item FROM plan_edges WHERE plan_id = ? ORDER BY rowid').all(planId) as unknown as Row[]).map((row) => ({ from: String(row['from_item']), to: String(row['to_item']) }));
  }

  /** Adds "`to` after `from`" (nothing when it exists). The caller checked for cycles. */
  async addEdge(planId: string, from: string, to: string): Promise<void> {
    this.#statement('INSERT OR IGNORE INTO plan_edges (plan_id, from_item, to_item) VALUES (?, ?, ?)').run(planId, from, to);
  }

  async removeEdge(planId: string, from: string, to: string): Promise<boolean> {
    return Number(this.#statement('DELETE FROM plan_edges WHERE plan_id = ? AND from_item = ? AND to_item = ?').run(planId, from, to).changes) > 0;
  }

  // ── item spans (the Timeline's history) ────────────────────────────────

  /** The plan's spans per item, oldest first, at most `cap` (the newest) per item. */
  async spans(planId: string, cap: number): Promise<Map<string, PlanItemSpan[]>> {
    const rows = this.#statement(
      'SELECT item_id, kind, started_at, ended_at FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY started_at DESC, id DESC) AS n FROM plan_item_spans WHERE plan_id = ?) WHERE n <= ? ORDER BY started_at, id',
    ).all(planId, cap) as unknown as Row[];
    const out = new Map<string, PlanItemSpan[]>();
    for (const row of rows) {
      const itemId = String(row['item_id']);
      out.set(itemId, [...(out.get(itemId) ?? []), { kind: String(row['kind']) as PlanItemSpanKind, startedAt: String(row['started_at']), endedAt: text(row['ended_at'] ?? null) }]);
    }
    return out;
  }

  /** The open spans of a plan (id, item, kind). */
  async openSpans(planId: string): Promise<Array<{ readonly id: number; readonly itemId: string; readonly kind: PlanItemSpanKind }>> {
    return (this.#statement('SELECT id, item_id, kind FROM plan_item_spans WHERE plan_id = ? AND ended_at IS NULL ORDER BY id').all(planId) as unknown as Row[]).map((row) => ({ id: Number(row['id']), itemId: String(row['item_id']), kind: String(row['kind']) as PlanItemSpanKind }));
  }

  async openSpan(planId: string, itemId: string, kind: PlanItemSpanKind, at: string): Promise<void> {
    this.#statement('INSERT INTO plan_item_spans (plan_id, item_id, kind, started_at) VALUES (?, ?, ?, ?)').run(planId, itemId, kind, at);
  }

  async closeSpan(id: number, at: string): Promise<void> {
    this.#statement('UPDATE plan_item_spans SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(at, id);
  }

  /** Runs `work` in one transaction (a whole external import). */
  inTransaction<T>(work: () => T): T {
    return transaction(this.#ctx.db, work);
  }
}
