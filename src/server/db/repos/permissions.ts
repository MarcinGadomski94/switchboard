import { randomUUID } from 'node:crypto';
import type { PermissionDecision, PermissionState } from '../../../core/model.ts';
import { type CreateInput, type RepoContext, placeholders } from '../context.ts';
import { transaction } from '../database.ts';
import { StoreError, Table, type TableSpec, defined } from '../table.ts';

/** A `can_use_tool` request for a tool other than AskUserQuestion: an Inbox permission item (D6). */
export interface PermissionRequestRecord {
  /** The Inbox item id. */
  readonly id: string;
  readonly sessionId: string;
  /** The control_request's `request_id`. */
  readonly requestId: string;
  readonly toolUseId: string | null;
  readonly toolName: string;
  /** The tool input verbatim. */
  readonly input: unknown;
  readonly description: string | null;
  readonly decisionReason: string | null;
  /** The request's `agent_id` (a subagent's task id) when a subagent asks. */
  readonly agentId: string | null;
  readonly state: PermissionState;
  readonly decision: PermissionDecision | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly staleAt: string | null;
  /**
   * D48 P4 (migration 0017): a hooked terminal session's request: the
   * PermissionRequest hook's `permission_suggestions` (`[]` when none), sent as
   * `updatedPermissions` by "Always allow"; `null` for a supervised process's
   * request (D6: Allow once / Deny only).
   */
  readonly hookSuggestions: readonly unknown[] | null;
}

/** Input of {@link PermissionRepository.create}; `id` defaults to a random UUID, `state` to `open`. */
export type PermissionRequestCreate = CreateInput<
  PermissionRequestRecord,
  'sessionId' | 'requestId' | 'toolName' | 'input',
  'state' | 'decision' | 'decidedAt' | 'staleAt'
>;

/** Filter of {@link PermissionRepository.list}. */
export interface PermissionFilter {
  readonly sessionId?: string;
  readonly states?: readonly PermissionState[];
}

const SPEC: TableSpec<PermissionRequestRecord> = {
  table: 'permission_requests',
  key: 'id',
  fields: {
    id: ['id', 'text'],
    sessionId: ['session_id', 'text'],
    requestId: ['request_id', 'text'],
    toolUseId: ['tool_use_id', 'text'],
    toolName: ['tool_name', 'text'],
    input: ['input', 'json'],
    description: ['description', 'text'],
    decisionReason: ['decision_reason', 'text'],
    agentId: ['agent_id', 'text'],
    state: ['state', 'text'],
    decision: ['decision', 'text'],
    createdAt: ['created_at', 'text'],
    decidedAt: ['decided_at', 'text'],
    staleAt: ['stale_at', 'text'],
    hookSuggestions: ['hook_suggestions', 'json'],
  },
};

/** Permission requests. */
export class PermissionRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<PermissionRequestRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  /** Stores a new open request; `requestId` is unique per session. */
  async create(input: PermissionRequestCreate): Promise<PermissionRequestRecord> {
    return this.#table.insert({
      ...defined(input),
      id: input.id ?? randomUUID(),
      createdAt: input.createdAt ?? this.#ctx.now(),
    });
  }

  async get(id: string): Promise<PermissionRequestRecord | null> {
    return this.#table.get(id);
  }

  async getByRequestId(sessionId: string, requestId: string): Promise<PermissionRequestRecord | null> {
    return this.#table.first('session_id = ? AND request_id = ?', [sessionId, requestId]);
  }

  /** Requests, oldest first. */
  async list(filter: PermissionFilter = {}): Promise<PermissionRequestRecord[]> {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.sessionId !== undefined) {
      where.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.states) {
      if (filter.states.length === 0) return [];
      where.push(`state IN (${placeholders(filter.states.length)})`);
      params.push(...filter.states);
    }
    return this.#table.select(where.join(' AND '), params, 'created_at, rowid');
  }

  /**
   * Records the developer's decision on an open request.
   * @throws {StoreError} `not-found`, or `conflict` when it is not open (decided or stale).
   */
  async decide(id: string, decision: PermissionDecision): Promise<PermissionRequestRecord> {
    return transaction(this.#ctx.db, () => {
      const request = this.#table.get(id);
      if (!request) throw new StoreError('not-found', `permission request ${id} not found`);
      if (request.state !== 'open') throw new StoreError('conflict', `permission request ${id} is ${request.state}`);
      const updated = this.#table.update(id, { state: 'decided', decision, decidedAt: this.#ctx.now() });
      if (!updated) throw new StoreError('not-found', `permission request ${id} not found`);
      return updated;
    });
  }

  /** Marks an open request stale (it closes without a decision); other states are left alone. */
  async markStale(id: string): Promise<PermissionRequestRecord | null> {
    return transaction(this.#ctx.db, () => {
      const request = this.#table.get(id);
      if (!request || request.state !== 'open') return request;
      return this.#table.update(id, { state: 'stale', staleAt: this.#ctx.now() });
    });
  }
}
