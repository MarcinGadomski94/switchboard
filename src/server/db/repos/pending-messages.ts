import type { CreateInput, RepoContext } from '../context.ts';
import { Table, type TableSpec, defined } from '../table.ts';

/**
 * A user message owed to a session the next time its process runs: answers to a
 * stale question batch, the "Switchboard restarted" note of a `need` session, …
 */
export interface PendingMessageRecord {
  readonly id: number;
  readonly sessionId: string;
  /** e.g. `stale-answers`, `restart-note`, `user`. */
  readonly kind: string;
  readonly text: string;
  readonly batchId: string | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
}

/** Input of {@link PendingMessageRepository.enqueue}. */
export type PendingMessageCreate = CreateInput<PendingMessageRecord, 'sessionId' | 'kind' | 'text', 'id' | 'deliveredAt'>;

const SPEC: TableSpec<PendingMessageRecord> = {
  table: 'pending_messages',
  key: 'id',
  fields: {
    id: ['id', 'int'],
    sessionId: ['session_id', 'text'],
    kind: ['kind', 'text'],
    text: ['text', 'text'],
    batchId: ['batch_id', 'text'],
    createdAt: ['created_at', 'text'],
    deliveredAt: ['delivered_at', 'text'],
  },
};

/** The per-session outbox of messages to send when the session next runs. */
export class PendingMessageRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<PendingMessageRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  async enqueue(input: PendingMessageCreate): Promise<PendingMessageRecord> {
    return this.#table.insert({ ...defined(input), createdAt: input.createdAt ?? this.#ctx.now() });
  }

  /** The session's undelivered messages, oldest first. */
  async pending(sessionId: string): Promise<PendingMessageRecord[]> {
    return this.#table.select('session_id = ? AND delivered_at IS NULL', [sessionId], 'id');
  }

  async markDelivered(id: number): Promise<PendingMessageRecord | null> {
    return this.#table.update(id, { deliveredAt: this.#ctx.now() });
  }
}
