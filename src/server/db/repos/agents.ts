import { randomUUID } from 'node:crypto';
import type { AgentKind, SessionStatus } from '../../../core/model.ts';
import type { CreateInput, Patch, RepoContext } from '../context.ts';
import { Table, type TableSpec, defined } from '../table.ts';

/** An agent of a session: the main agent, or one per Agent/Task tool call (gap #8). */
export interface AgentRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: AgentKind;
  readonly name: string;
  readonly description: string | null;
  /** Solution folder it works in (workspace-relative), when known. */
  readonly solutionPath: string | null;
  readonly branch: string | null;
  readonly status: SessionStatus;
  /** Short status copy next to the dot, when there is one. */
  readonly statusText: string | null;
  /** The Agent/Task `tool_use` id that started it (subagent lines carry it as `parent_tool_use_id`). */
  readonly toolUseId: string | null;
  /** The CLI's task id (`system/task_started`; a permission request's `agent_id`). */
  readonly taskId: string | null;
  readonly subagentType: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endedAt: string | null;
}

/** Input of {@link AgentRepository.create}; `kind` defaults to `subagent`, `status` to `run`. */
export type AgentCreate = CreateInput<AgentRecord, 'sessionId' | 'name', 'createdAt' | 'updatedAt'>;

/** Input of {@link AgentRepository.update}. */
export type AgentPatch = Patch<AgentRecord, 'id' | 'sessionId' | 'createdAt' | 'updatedAt'>;

const SPEC: TableSpec<AgentRecord> = {
  table: 'agents',
  key: 'id',
  fields: {
    id: ['id', 'text'],
    sessionId: ['session_id', 'text'],
    kind: ['kind', 'text'],
    name: ['name', 'text'],
    description: ['description', 'text'],
    solutionPath: ['solution_path', 'text'],
    branch: ['branch', 'text'],
    status: ['status', 'text'],
    statusText: ['status_text', 'text'],
    toolUseId: ['tool_use_id', 'text'],
    taskId: ['task_id', 'text'],
    subagentType: ['subagent_type', 'text'],
    createdAt: ['created_at', 'text'],
    updatedAt: ['updated_at', 'text'],
    endedAt: ['ended_at', 'text'],
  },
};

/** Agents of sessions. */
export class AgentRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<AgentRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  /**
   * D95: each session's agents as last read (`toSession` reads them for every
   * `sessionUpdated`, hundreds of rows in a long session); every write through this
   * repository drops its session's entry.
   */
  readonly #bySession = new Map<string, { readonly mark: string; readonly list: readonly AgentRecord[] }>();

  /** Stores a new agent; a `toolUseId` is unique per session. */
  async create(input: AgentCreate): Promise<AgentRecord> {
    const ts = this.#ctx.now();
    const record = this.#table.insert({ ...defined(input), id: input.id ?? randomUUID(), createdAt: ts, updatedAt: ts });
    this.#bySession.delete(record.sessionId);
    return record;
  }

  async get(id: string): Promise<AgentRecord | null> {
    return this.#table.get(id);
  }

  /** The session's agents in creation order (D95: a new array each call, from memory while nothing was written). */
  async listBySession(sessionId: string): Promise<AgentRecord[]> {
    // A cheap check that nothing changed behind the repository's back (a session's delete cascades to its agents).
    const mark = this.#mark(sessionId);
    let list = this.#bySession.get(sessionId)?.mark === mark ? this.#bySession.get(sessionId)?.list : undefined;
    if (!list) {
      list = this.#table.select('session_id = ?', [sessionId], 'created_at, rowid');
      this.#bySession.delete(sessionId);
      this.#bySession.set(sessionId, { mark, list });
      // Bounded: the most recently read sessions.
      for (const oldest of this.#bySession.keys()) {
        if (this.#bySession.size <= 64) break;
        this.#bySession.delete(oldest);
      }
    }
    return [...list];
  }

  /** D95: the session's main agent (the first in creation order), without reading its subagents. */
  async mainOf(sessionId: string): Promise<AgentRecord | null> {
    return this.#table.first("session_id = ? AND kind = 'main'", [sessionId], 'created_at, rowid');
  }

  async findByToolUseId(sessionId: string, toolUseId: string): Promise<AgentRecord | null> {
    return this.#table.first('session_id = ? AND tool_use_id = ?', [sessionId, toolUseId]);
  }

  async findByTaskId(sessionId: string, taskId: string): Promise<AgentRecord | null> {
    return this.#table.first('session_id = ? AND task_id = ?', [sessionId, taskId], 'created_at DESC, rowid DESC');
  }

  async update(id: string, patch: AgentPatch): Promise<AgentRecord | null> {
    const record = this.#table.update(id, { ...patch, updatedAt: this.#ctx.now() });
    if (record) {
      // The main agent's status flips with every turn: the kept list takes the new row instead of being read again.
      const cached = this.#bySession.get(record.sessionId);
      const at = cached ? cached.list.findIndex((agent) => agent.id === record.id) : -1;
      if (cached && at >= 0) this.#bySession.set(record.sessionId, { mark: this.#mark(record.sessionId), list: cached.list.with(at, record) });
      else this.#bySession.delete(record.sessionId);
    }
    return record;
  }

  /** D95: what changes when the session's agent rows change (count, newest row, newest update). */
  #mark(sessionId: string): string {
    const row = this.#table.statement('SELECT COUNT(*) AS n, MAX(rowid) AS r, MAX(updated_at) AS u FROM agents WHERE session_id = ?').get(sessionId);
    return `${String(row?.['n'])}:${String(row?.['r'])}:${String(row?.['u'])}`;
  }

  async delete(id: string): Promise<boolean> {
    const record = this.#table.get(id);
    if (record) this.#bySession.delete(record.sessionId);
    return this.#table.delete(id);
  }
}
