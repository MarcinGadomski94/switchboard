import type { EventKind } from '../../../core/model.ts';
import type { CreateInput, Patch, RepoContext } from '../context.ts';
import { Table, type TableSpec, defined } from '../table.ts';

/** One event of a session: drives the chat, the timeline and the terminal tail. */
export interface EventRecord {
  /** Ascending per insert; usable as a cursor. */
  readonly id: number;
  readonly sessionId: string;
  readonly agentId: string | null;
  readonly ts: string;
  /** End of a timeline block (e.g. a tool call finished by its result). */
  readonly endTs: string | null;
  readonly kind: EventKind;
  readonly label: string;
  readonly payload: unknown;
  /** stream-json / transcript entry uuid (dedupe when importing a transcript). */
  readonly uuid: string | null;
  /** Assistant `message.id` (lines of one message are merged). */
  readonly messageId: string | null;
  /** `tool_use` id (pairs the call with its `tool_result`). */
  readonly toolUseId: string | null;
}

/** Input of {@link EventRepository.append}; `ts` defaults to now, `label` to `""`. */
export type EventCreate = CreateInput<EventRecord, 'sessionId' | 'kind', 'id'>;

/** Input of {@link EventRepository.update}. */
export type EventPatch = Patch<EventRecord, 'id' | 'sessionId'>;

/** Query of {@link EventRepository.list}. */
export interface EventQuery {
  /** Only events with `ts` after this ISO timestamp (the contract's `?since=ts`). */
  readonly sinceTs?: string;
  /** Only events with an id greater than this. */
  readonly afterId?: number;
  /** At most this many, the oldest first. */
  readonly limit?: number;
}

const SPEC: TableSpec<EventRecord> = {
  table: 'events',
  key: 'id',
  fields: {
    id: ['id', 'int'],
    sessionId: ['session_id', 'text'],
    agentId: ['agent_id', 'text'],
    ts: ['ts', 'text'],
    endTs: ['end_ts', 'text'],
    kind: ['kind', 'text'],
    label: ['label', 'text'],
    payload: ['payload', 'json'],
    uuid: ['uuid', 'text'],
    messageId: ['message_id', 'text'],
    toolUseId: ['tool_use_id', 'text'],
  },
};

/** Events of sessions. */
export class EventRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<EventRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  /** Appends an event and returns it with its id. */
  async append(input: EventCreate): Promise<EventRecord> {
    return this.#table.insert({ ...defined(input), ts: input.ts ?? this.#ctx.now() });
  }

  async get(id: number): Promise<EventRecord | null> {
    return this.#table.get(id);
  }

  /** The session's events in time order (ts, then id). */
  async list(sessionId: string, query: EventQuery = {}): Promise<EventRecord[]> {
    const where = ['session_id = ?'];
    const params: Array<string | number> = [sessionId];
    if (query.sinceTs !== undefined) {
      where.push('ts > ?');
      params.push(query.sinceTs);
    }
    if (query.afterId !== undefined) {
      where.push('id > ?');
      params.push(query.afterId);
    }
    return this.#table.select(where.join(' AND '), params, 'ts, id', query.limit);
  }

  /** The newest `limit` events of the session, returned oldest first. */
  async latest(sessionId: string, limit: number): Promise<EventRecord[]> {
    return this.#table.select('session_id = ?', [sessionId], 'ts DESC, id DESC', limit).reverse();
  }

  /** The newest event of the session for a `tool_use` id. */
  async findByToolUseId(sessionId: string, toolUseId: string): Promise<EventRecord | null> {
    return this.#table.first('session_id = ? AND tool_use_id = ?', [sessionId, toolUseId], 'id DESC');
  }

  /** `true` if the session already has an event for this stream/transcript uuid. */
  async hasUuid(sessionId: string, uuid: string): Promise<boolean> {
    return this.#table.first('session_id = ? AND uuid = ?', [sessionId, uuid]) !== null;
  }

  async update(id: number, patch: EventPatch): Promise<EventRecord | null> {
    return this.#table.update(id, patch);
  }
}
