import type { EventKind } from '../../../core/model.ts';
import type { CreateInput, Patch, RepoContext } from '../context.ts';
import { Table, type TableSpec, defined } from '../table.ts';
import { EventMemo, payloadType } from '../event-memo.ts';

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

/** D95: how many writes per session {@link EventRepository.changedSince} can name. */
export const EVENT_CHANGE_LOG_LIMIT = 4096;

/** Events of sessions. */
export class EventRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<EventRecord>;
  /** D95: per session, its write revision in this process and the ids of its newest writes. */
  readonly #changes = new Map<string, { revision: number; log: Array<{ readonly revision: number; readonly id: number }> }>();

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  /** Appends an event and returns it with its id. */
  async append(input: EventCreate): Promise<EventRecord> {
    const record = this.#table.insert({ ...defined(input), ts: input.ts ?? this.#ctx.now() });
    this.#changed(record);
    return record;
  }

  /**
   * D95 (`docs/performance.md` → *Incremental derivations*): the session's write
   * revision: 0 until an event of it is appended or updated in this process, then one
   * more per write. Every write to `events` goes through this repository, so a value
   * derived from a session's events at revision r stays true while the revision is r.
   */
  async revision(sessionId: string): Promise<number> {
    return this.#changes.get(sessionId)?.revision ?? 0;
  }

  /**
   * D95: the ids of the session's events appended or updated after `revision`
   * (each once, in write order); `null` when the log (the newest
   * {@link EVENT_CHANGE_LOG_LIMIT} writes) no longer reaches back that far, or
   * `revision` is from the future (read everything again then).
   */
  async changedSince(sessionId: string, revision: number): Promise<number[] | null> {
    const entry = this.#changes.get(sessionId);
    const current = entry?.revision ?? 0;
    if (revision === current) return [];
    if (!entry || revision > current) return null;
    const first = entry.log[0];
    if (!first || first.revision > revision + 1) return null;
    const ids = new Set<number>();
    for (const change of entry.log) if (change.revision > revision) ids.add(change.id);
    return [...ids];
  }

  /** D95: the session's events with these ids (in no particular order; unknown ids are left out). */
  async byIds(sessionId: string, ids: readonly number[]): Promise<EventRecord[]> {
    if (ids.length === 0) return [];
    // One prepared statement for any number of ids (the statement cache is keyed by SQL text).
    return this.#table.select('session_id = ? AND id IN (SELECT value FROM json_each(?))', [sessionId, JSON.stringify(ids)], 'id');
  }

  #changed(record: Pick<EventRecord, 'sessionId' | 'id'>): void {
    let entry = this.#changes.get(record.sessionId);
    if (!entry) {
      entry = { revision: 0, log: [] };
      this.#changes.set(record.sessionId, entry);
    }
    entry.revision += 1;
    entry.log.push({ revision: entry.revision, id: record.id });
    if (entry.log.length > EVENT_CHANGE_LOG_LIMIT * 2) entry.log.splice(0, entry.log.length - EVENT_CHANGE_LOG_LIMIT);
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

  /**
   * D95 (`docs/performance.md` → *Paged events*): a page of the session's events in
   * time order (ts, then id): the newest `limit` of those matching, returned oldest
   * first. `before` = only events older than that one (ts, then id: the oldest event
   * of the page already loaded); `sinceTs` as in {@link list}; `agent` = only the
   * events of that agent plus the call that started it (`toolUseId`). Without
   * `limit`: every matching event.
   */
  async page(
    sessionId: string,
    query: {
      readonly limit?: number;
      readonly before?: Pick<EventRecord, 'ts' | 'id'>;
      readonly sinceTs?: string;
      readonly agent?: { readonly id: string; readonly toolUseId: string | null };
    },
  ): Promise<EventRecord[]> {
    const where = ['session_id = ?'];
    const params: Array<string | number> = [sessionId];
    if (query.sinceTs !== undefined) {
      where.push('ts > ?');
      params.push(query.sinceTs);
    }
    if (query.before) {
      where.push('(ts < ? OR (ts = ? AND id < ?))');
      params.push(query.before.ts, query.before.ts, query.before.id);
    }
    if (query.agent) {
      if (query.agent.toolUseId) {
        where.push('(agent_id = ? OR tool_use_id = ?)');
        params.push(query.agent.id, query.agent.toolUseId);
      } else {
        where.push('agent_id = ?');
        params.push(query.agent.id);
      }
    }
    if (query.limit === undefined) return this.#table.select(where.join(' AND '), params, 'ts, id');
    return this.#table.select(where.join(' AND '), params, 'ts DESC, id DESC', query.limit).reverse();
  }

  /** The newest `limit` events of the session, returned oldest first. */
  async latest(sessionId: string, limit: number): Promise<EventRecord[]> {
    return this.#table.select('session_id = ?', [sessionId], 'ts DESC, id DESC', limit).reverse();
  }

  /**
   * D21: a page of the session's assistant-text events (`payload.type` =
   * `assistant`), newest first (ts, then id), for the printed status table
   * (`src/server/sessions/reported-table.ts`):
   * - `agentId`: only events of that agent or of none (the chat's main
   *   conversation); `null` = every agent;
   * - `words`: only payloads containing every word (SQL `LIKE`, ASCII
   *   case-insensitive), a cheap pre-filter;
   * - `before`: only events older than that one (the last of the previous page).
   */
  async assistantTextsNewestFirst(
    sessionId: string,
    query: { readonly agentId: string | null; readonly words: readonly string[]; readonly before?: Pick<EventRecord, 'ts' | 'id'>; readonly limit: number },
  ): Promise<EventRecord[]> {
    const where = ['session_id = ?', "json_extract(payload, '$.type') = 'assistant'"];
    const params: Array<string | number> = [sessionId];
    if (query.agentId !== null) {
      where.push('(agent_id IS NULL OR agent_id = ?)');
      params.push(query.agentId);
    }
    for (const word of query.words) {
      where.push("payload LIKE ? ESCAPE '\\'");
      params.push(`%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    if (query.before) {
      where.push('(ts < ? OR (ts = ? AND id < ?))');
      params.push(query.before.ts, query.before.ts, query.before.id);
    }
    return this.#table.select(where.join(' AND '), params, 'ts DESC, id DESC', query.limit);
  }

  /**
   * D79: the session's newest calls of tool `name` (`payload.type` = `tool`), newest
   * first (ts, then id), at most `limit` (the review card's test status).
   */
  async toolCallsNewestFirst(sessionId: string, name: string, limit: number): Promise<EventRecord[]> {
    return this.#table.select("session_id = ? AND json_extract(payload, '$.type') = 'tool' AND json_extract(payload, '$.name') = ?", [sessionId, name], 'ts DESC, id DESC', limit);
  }

  /**
   * D90: the distinct file paths the session's file-editing tool calls named
   * (`payload.type` = `tool`, `payload.name` one of `names`; `input.file_path`, or
   * `input.notebook_path` for NotebookEdit), as written (absolute or cwd-relative).
   */
  async editedFilePaths(sessionId: string, names: readonly string[]): Promise<string[]> {
    if (names.length === 0) return [];
    const marks = names.map(() => '?').join(', ');
    return this.#table
      .statement(
        `SELECT DISTINCT COALESCE(json_extract(payload, '$.input.file_path'), json_extract(payload, '$.input.notebook_path')) AS p FROM events ` +
          `WHERE session_id = ? AND json_extract(payload, '$.type') = 'tool' AND json_extract(payload, '$.name') IN (${marks})`,
      )
      .all(sessionId, ...names)
      .map((row) => row['p'])
      .filter((value): value is string => typeof value === 'string' && value !== '');
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
    const record = this.#table.update(id, patch);
    if (record) this.#changed(record);
    return record;
  }

  /** D80: how many user messages (`payload.type` `user`) the session has up to event `uptoId` (all when omitted): a turn's number. */
  async countUserMessages(sessionId: string, uptoId?: number): Promise<number> {
    // D95: the whole session's count is kept until a user message is written (it scans every payload).
    if (uptoId === undefined) return this.#userCounts.get(this, sessionId, '', () => this.#countUserMessages(sessionId, Number.MAX_SAFE_INTEGER));
    return this.#countUserMessages(sessionId, uptoId);
  }

  readonly #userCounts = new EventMemo<number>((event) => payloadType(event) === 'user');

  async #countUserMessages(sessionId: string, uptoId: number): Promise<number> {
    const row = this.#table
      .statement("SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND id <= ? AND json_extract(payload, '$.type') = 'user'")
      .get(sessionId, uptoId);
    return Number(row?.['n'] ?? 0);
  }
}
