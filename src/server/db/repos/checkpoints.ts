import type { RepoContext } from '../context.ts';
import { Table, type TableSpec } from '../table.ts';

/** D80: what a checkpoint row was taken for (`turn_checkpoints.kind`, migration 0034). */
export type CheckpointKind = 'turn' | 'before-revert' | 'before-redo';

/** D80: one working tree's checkpoint (`turn_checkpoints`, migration 0034, `docs/undo.md`). */
export interface CheckpointRecord {
  readonly id: number;
  readonly sessionId: string;
  readonly kind: CheckpointKind;
  /** The turn (1 = the session's first user message); for a safety row, the turn the revert went back to. */
  readonly turnSeq: number;
  /** The user message's event (a turn), the chat divider's event (a safety row); `null` until known. */
  readonly eventId: number | null;
  /** The rows of one capture (one per working tree). */
  readonly groupId: string;
  /** The working tree's top-level folder. */
  readonly repoPath: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly tree: string;
  /** The developer's index (staged) tree at that moment; `null` when it could not be written. */
  readonly indexTree: string | null;
  /** HEAD's commit; `null` before the repo's first commit. */
  readonly head: string | null;
  /** The checked-out branch; `null` for a detached HEAD. */
  readonly branch: string | null;
  readonly createdAt: string;
}

/** Input of {@link CheckpointRepository.create}. */
export type CheckpointCreate = Omit<CheckpointRecord, 'id' | 'createdAt'> & { readonly createdAt?: string };

const SPEC: TableSpec<CheckpointRecord> = {
  table: 'turn_checkpoints',
  key: 'id',
  fields: {
    id: ['id', 'int'],
    sessionId: ['session_id', 'text'],
    kind: ['kind', 'text'],
    turnSeq: ['turn_seq', 'int'],
    eventId: ['event_id', 'int'],
    groupId: ['group_id', 'text'],
    repoPath: ['repo_path', 'text'],
    ref: ['ref', 'text'],
    commitSha: ['commit_sha', 'text'],
    tree: ['tree', 'text'],
    indexTree: ['index_tree', 'text'],
    head: ['head', 'text'],
    branch: ['branch', 'text'],
    createdAt: ['created_at', 'text'],
  },
};

/** D80: the checkpoint index (the refs themselves live in the session's repos). */
export class CheckpointRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<CheckpointRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  async create(input: CheckpointCreate): Promise<CheckpointRecord> {
    return this.#table.insert({ ...input, createdAt: input.createdAt ?? this.#ctx.now() });
  }

  /** A session's rows of `kind`, oldest first. */
  async listOf(sessionId: string, kind?: CheckpointKind): Promise<CheckpointRecord[]> {
    return kind === undefined
      ? this.#table.select('session_id = ?', [sessionId], 'id')
      : this.#table.select('session_id = ? AND kind = ?', [sessionId, kind], 'id');
  }

  /** The rows of one group, in order. */
  async group(groupId: string): Promise<CheckpointRecord[]> {
    return this.#table.select('group_id = ?', [groupId], 'id');
  }

  /** The turn rows of a session's turn `turnSeq` (one per working tree). */
  async turn(sessionId: string, turnSeq: number): Promise<CheckpointRecord[]> {
    return this.#table.select('session_id = ? AND kind = ? AND turn_seq = ?', [sessionId, 'turn', turnSeq], 'id');
  }

  /** The newest row of the session in `repoPath` (any kind): the dedupe of unchanged trees starts from it. */
  async latestIn(sessionId: string, repoPath: string): Promise<CheckpointRecord | null> {
    return this.#table.first('session_id = ? AND repo_path = ?', [sessionId, repoPath], 'id DESC');
  }

  /** The newest safety group (`before-revert` / `before-redo`) of the session, its rows. */
  async latestSafety(sessionId: string): Promise<CheckpointRecord[]> {
    const newest = this.#table.first("session_id = ? AND kind <> 'turn'", [sessionId], 'id DESC');
    return newest ? this.group(newest.groupId) : [];
  }

  /** Sets the event of a group's rows (the chat divider of a revert, once written). */
  async setGroupEvent(groupId: string, eventId: number): Promise<void> {
    this.#table.statement('UPDATE turn_checkpoints SET event_id = ? WHERE group_id = ?').run(eventId, groupId);
  }

  /** The ids of the sessions that have rows. */
  async sessionIds(): Promise<string[]> {
    return this.#table.statement('SELECT DISTINCT session_id FROM turn_checkpoints ORDER BY session_id').all().map((row) => String(row['session_id']));
  }

  async delete(id: number): Promise<boolean> {
    return this.#table.delete(id);
  }
}
