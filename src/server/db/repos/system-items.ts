import { randomUUID } from 'node:crypto';
import type { SessionStatus, SystemItemState } from '../../../core/model.ts';
import { type CreateInput, type Patch, type RepoContext, placeholders } from '../context.ts';
import { transaction } from '../database.ts';
import { StoreError, Table, type TableSpec, defined } from '../table.ts';

/** A solution + branch chip of an Inbox item. */
export interface BranchRef {
  readonly solution: string;
  readonly branch: string;
}

/** An action button of a system item; `id` is the `{action}` of `/api/inbox/{id}/actions/{action}`. */
export interface InboxAction {
  readonly id: string;
  readonly label: string;
}

/** An Inbox item the service raises itself (M3.3): a failed scheduled run, a removable worktree, … */
export interface SystemItemRecord {
  readonly id: string;
  /** What raised it, e.g. `schedule-run-failed`, `worktree-removable`. */
  readonly kind: string;
  /** Shown as the item's source (schedule name, `worktrees`, …). */
  readonly source: string;
  /** Status dot color. */
  readonly status: SessionStatus;
  readonly title: string;
  readonly detail: string;
  readonly branches: BranchRef[];
  /** In display order; the first is primary. */
  readonly actions: InboxAction[];
  readonly sessionId: string | null;
  readonly scheduleId: string | null;
  readonly scheduleRunId: string | null;
  readonly worktreeId: string | null;
  readonly payload: unknown;
  readonly state: SystemItemState;
  /** The action that closed it. */
  readonly closedAction: string | null;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

/** Input of {@link SystemItemRepository.create}; `status` defaults to `need`, `state` to `open`. */
export type SystemItemCreate = CreateInput<
  SystemItemRecord,
  'kind' | 'source' | 'title',
  'state' | 'closedAction' | 'closedAt'
>;

/** Input of {@link SystemItemRepository.update}. */
export type SystemItemPatch = Patch<SystemItemRecord, 'id' | 'createdAt' | 'state' | 'closedAction' | 'closedAt'>;

const SPEC: TableSpec<SystemItemRecord> = {
  table: 'system_items',
  key: 'id',
  fields: {
    id: ['id', 'text'],
    kind: ['kind', 'text'],
    source: ['source', 'text'],
    status: ['status', 'text'],
    title: ['title', 'text'],
    detail: ['detail', 'text'],
    branches: ['branches', 'json'],
    actions: ['actions', 'json'],
    sessionId: ['session_id', 'text'],
    scheduleId: ['schedule_id', 'text'],
    scheduleRunId: ['schedule_run_id', 'text'],
    worktreeId: ['worktree_id', 'text'],
    payload: ['payload', 'json'],
    state: ['state', 'text'],
    closedAction: ['closed_action', 'text'],
    createdAt: ['created_at', 'text'],
    closedAt: ['closed_at', 'text'],
  },
};

/** System Inbox items. */
export class SystemItemRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<SystemItemRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  async create(input: SystemItemCreate): Promise<SystemItemRecord> {
    return this.#table.insert({
      ...defined(input),
      id: input.id ?? randomUUID(),
      createdAt: input.createdAt ?? this.#ctx.now(),
    });
  }

  async get(id: string): Promise<SystemItemRecord | null> {
    return this.#table.get(id);
  }

  /** Items, newest first. */
  async list(states?: readonly SystemItemState[]): Promise<SystemItemRecord[]> {
    if (states) {
      if (states.length === 0) return [];
      return this.#table.select(`state IN (${placeholders(states.length)})`, states, 'created_at DESC, rowid DESC');
    }
    return this.#table.select('', [], 'created_at DESC, rowid DESC');
  }

  async update(id: string, patch: SystemItemPatch): Promise<SystemItemRecord | null> {
    return this.#table.update(id, patch);
  }

  /**
   * Closes an open item with the action taken.
   * @throws {StoreError} `not-found`, or `conflict` when it is already closed.
   */
  async close(id: string, action: string): Promise<SystemItemRecord> {
    return transaction(this.#ctx.db, () => {
      const item = this.#table.get(id);
      if (!item) throw new StoreError('not-found', `system item ${id} not found`);
      if (item.state !== 'open') throw new StoreError('conflict', `system item ${id} is already closed`);
      const updated = this.#table.update(id, { state: 'closed', closedAction: action, closedAt: this.#ctx.now() });
      if (!updated) throw new StoreError('not-found', `system item ${id} not found`);
      return updated;
    });
  }
}
