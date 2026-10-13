import type { SQLInputValue, StatementSync } from 'node:sqlite';
import { type SearchScope, eventSearchText } from '../../../core/search.ts';
import type { RepoContext } from '../context.ts';
import { transaction } from '../database.ts';

/**
 * D97 (`docs/search.md` → *The index*): the full-text index of migration 0042.
 * `search_fts` (FTS5, contentless with deletes) holds the events under their own id
 * (written here when the events repository writes an event) and the
 * `search_items` rows (sessions, artifacts, todos, History; kept by triggers on
 * their tables) under minus their id. Deletes of any source reach the index through
 * triggers. This class indexes events, runs the backfill's steps and answers the
 * queries; it never decides what a query means (`core/search.ts`).
 */

/** The `search_items` kinds the backfill walks, with the source view of each. */
export const SEARCH_ITEM_SOURCES = [
  ['session', 'search_src_sessions'],
  ['todo', 'search_src_todos'],
  ['artifact', 'search_src_artifacts'],
  ['history', 'search_src_history'],
] as const;

/** A `search_items` kind. */
export type SearchItemKind = (typeof SEARCH_ITEM_SOURCES)[number][0];

/**
 * What the index holds for an event is versioned: when {@link eventSearchText}'s
 * rules change, this goes up and the backfill indexes every event again.
 */
export const SEARCH_INDEX_VERSION = 1;

/** Weights of bm25 per column: a title match counts four times a body match. */
const BM25 = 'bm25(search_fts, 4.0, 1.0)';

/** The recency boost: up to 1.5 × for something from today, fading over about two weeks (bm25 is negative: more negative ranks higher). */
function boosted(tsColumn: string): string {
  return `${BM25} * (1.0 + 0.5 * exp(-max(0.0, julianday('now') - julianday(${tsColumn})) / 14.0))`;
}

/** A hit before its text is read: which row and how it ranks. */
export interface SearchHit {
  /** `e` = an event (`key` its id), `i` = a `search_items` row (`key` its id). */
  readonly source: 'e' | 'i';
  readonly key: number;
  readonly score: number;
}

/** An event hit's row. */
export interface SearchEventRow {
  readonly id: number;
  readonly sessionId: string;
  readonly agentId: string | null;
  /** The agent's kind (`main`, `subagent`, `workflow`); `null` without an agent. */
  readonly agentKind: string | null;
  readonly ts: string;
  readonly payload: unknown;
  readonly sessionTitle: string | null;
}

/** A `search_items` hit's row. */
export interface SearchItemRow {
  readonly id: number;
  readonly kind: SearchItemKind;
  readonly ref: string;
  readonly sessionId: string | null;
  readonly link: string | null;
  readonly title: string;
  readonly body: string;
  readonly ts: string;
  readonly sessionTitle: string | null;
}

/** The kinds of `search_items` each scope reads; `sessions` reads the events too. */
const SCOPE_KINDS: Record<SearchScope, SearchItemKind> = { sessions: 'session', artifacts: 'artifact', todos: 'todo', history: 'history' };

/** History rows of conversations that became sessions here are not shown (the session is). */
const HISTORY_NOT_A_SESSION = `(i.kind <> 'history' OR i.link IS NULL OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.claude_session_id = i.link))`;

/** The search index. */
export class SearchRepository {
  readonly #ctx: RepoContext;
  readonly #statements = new Map<string, StatementSync>();
  #onError: (error: unknown) => void = (error) => console.error('switchboard search index:', error);

  /** `false` for a database without migration 0042 (tests that apply their own migrations): nothing is indexed. */
  readonly enabled: boolean;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.enabled = ctx.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'search_fts'").get() !== undefined;
  }

  /** Where indexing errors go (the event is stored either way). */
  set onError(handler: (error: unknown) => void) {
    this.#onError = handler;
  }

  #statement(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#ctx.db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  // ── events ─────────────────────────────────────────────────────────────

  /**
   * Indexes an event just written (`created` = appended: nothing to replace). An
   * update replaces its entry, or removes it when the event no longer has text. A
   * failure is reported, never thrown: the event is stored either way, and the next
   * write of it (or a rebuild) indexes it.
   */
  indexEvent(event: { readonly id: number; readonly payload: unknown }, created: boolean): void {
    if (!this.enabled) return;
    try {
      const text = eventSearchText(event.payload);
      // Delete + insert rather than INSERT OR REPLACE (see migration 0042: an outer conflict policy would win over it).
      if (!created) this.#statement('DELETE FROM search_fts WHERE rowid = ?').run(event.id);
      if (text === '') return;
      this.#statement("INSERT INTO search_fts (rowid, title, body) VALUES (?, '', ?)").run(event.id, text);
    } catch (error) {
      this.#onError(error);
    }
  }

  /**
   * Backfill step: indexes the events with `after < id <= upto`, at most `limit`, in id
   * order (an event already indexed by its write is replaced with the same entry).
   * Returns the last id done (`after` when none was left) and how many were read.
   */
  backfillEvents(after: number, upto: number, limit: number): { readonly last: number; readonly read: number } {
    const rows = this.#statement('SELECT id, payload FROM events WHERE id > ? AND id <= ? ORDER BY id LIMIT ?').all(after, upto, limit);
    const drop = this.#statement('DELETE FROM search_fts WHERE rowid = ?');
    const put = this.#statement("INSERT INTO search_fts (rowid, title, body) VALUES (?, '', ?)");
    let last = after;
    transaction(this.#ctx.db, () => {
      for (const row of rows) {
        const id = Number(row['id']);
        last = id;
        let payload: unknown = null;
        try {
          payload = JSON.parse(String(row['payload']));
        } catch {
          continue;
        }
        const text = eventSearchText(payload);
        drop.run(id);
        if (text !== '') put.run(id, text);
      }
    });
    return { last, read: rows.length };
  }

  // ── items (sessions, todos, artifacts, History) ────────────────────────

  /**
   * Backfill step: upserts the `search_items` rows of a source whose rowid is after
   * `after`, at most `limit` (the triggers keep them from then on). Returns the last
   * source rowid done and how many were read.
   */
  backfillItems(kind: SearchItemKind, after: number, limit: number): { readonly last: number; readonly read: number } {
    const view = SEARCH_ITEM_SOURCES.find(([k]) => k === kind)?.[1];
    if (!view) throw new Error(`unknown search item kind ${kind}`);
    const rows = this.#statement(`SELECT src FROM ${view} WHERE src > ? ORDER BY src LIMIT ?`).all(after, limit);
    if (rows.length === 0) return { last: after, read: 0 };
    const last = Number(rows[rows.length - 1]?.['src']);
    this.#statement(
      `INSERT INTO search_items (kind, ref, session_id, link, title, body, ts)
         SELECT ?, ref, session_id, link, title, body, ts FROM ${view} WHERE src > ? AND src <= ?
       ON CONFLICT (kind, ref) DO UPDATE SET session_id = excluded.session_id, link = excluded.link, title = excluded.title, body = excluded.body, ts = excluded.ts`,
    ).run(kind, after, last);
    return { last, read: rows.length };
  }

  /** How many rows a source has after `after` (the backfill's totals). */
  countItems(kind: SearchItemKind, after = 0): number {
    const view = SEARCH_ITEM_SOURCES.find(([k]) => k === kind)?.[1];
    if (!view) return 0;
    return Number(this.#statement(`SELECT COUNT(*) AS n FROM ${view} WHERE src > ?`).get(after)?.['n'] ?? 0);
  }

  /** How many events have `after < id <= upto`. */
  countEvents(after: number, upto: number): number {
    return Number(this.#statement('SELECT COUNT(*) AS n FROM events WHERE id > ? AND id <= ?').get(after, upto)?.['n'] ?? 0);
  }

  /** The newest event id (0 without events). */
  maxEventId(): number {
    return Number(this.#statement('SELECT COALESCE(MAX(id), 0) AS n FROM events').get()?.['n'] ?? 0);
  }

  // ── state ──────────────────────────────────────────────────────────────

  getState(key: string): string | null {
    const row = this.#statement('SELECT value FROM search_state WHERE key = ?').get(key);
    return row ? String(row['value']) : null;
  }

  setState(key: string, value: string): void {
    this.#statement('INSERT INTO search_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Empties the event part of the index (a new {@link SEARCH_INDEX_VERSION}: the backfill writes it again). */
  clearEvents(): void {
    this.#statement('DELETE FROM search_fts WHERE rowid > 0').run();
  }

  // ── queries ────────────────────────────────────────────────────────────

  /** The filters of a query: `sessionId` = only that session's events and items. */
  #where(scope: SearchScope, sessionId: string | null): { readonly join: string; readonly where: string; readonly params: SQLInputValue[] } {
    const params: SQLInputValue[] = [];
    if (scope === 'sessions') {
      // Events (rowid > 0) and session rows; one FTS scan.
      let where = `((f.rowid > 0 AND e.id IS NOT NULL) OR (f.rowid < 0 AND i.kind = 'session'))`;
      if (sessionId !== null) {
        where += ' AND COALESCE(e.session_id, i.session_id) = ?';
        params.push(sessionId);
      }
      return { join: 'LEFT JOIN events e ON f.rowid > 0 AND e.id = f.rowid LEFT JOIN search_items i ON f.rowid < 0 AND i.id = -f.rowid', where, params };
    }
    let where = `f.rowid < 0 AND i.kind = ? AND ${HISTORY_NOT_A_SESSION}`;
    params.push(SCOPE_KINDS[scope]);
    if (sessionId !== null) {
      where += ' AND i.session_id = ?';
      params.push(sessionId);
    }
    return { join: 'JOIN search_items i ON i.id = -f.rowid', where, params };
  }

  /** How many matches each scope has. */
  counts(match: string, scopes: readonly SearchScope[], sessionId: string | null): Map<SearchScope, number> {
    const counts = new Map<SearchScope, number>();
    for (const scope of scopes) {
      const { join, where, params } = this.#where(scope, sessionId);
      const row = this.#statement(`SELECT COUNT(*) AS n FROM search_fts f ${join} WHERE search_fts MATCH ? AND ${where}`).get(match, ...params);
      counts.set(scope, Number(row?.['n'] ?? 0));
    }
    return counts;
  }

  /** A page of a scope's hits, best first (score, then newest row). */
  hits(match: string, scope: SearchScope, sessionId: string | null, offset: number, limit: number): SearchHit[] {
    const { join, where, params } = this.#where(scope, sessionId);
    const ts = scope === 'sessions' ? 'COALESCE(e.ts, i.ts)' : 'i.ts';
    const rows = this.#statement(
      `SELECT f.rowid AS rid, ${boosted(ts)} AS score FROM search_fts f ${join} WHERE search_fts MATCH ? AND ${where} ORDER BY score, f.rowid DESC LIMIT ? OFFSET ?`,
    ).all(match, ...params, limit, offset);
    return rows.map((row) => {
      const rid = Number(row['rid']);
      return { source: rid > 0 ? 'e' : 'i', key: Math.abs(rid), score: Number(row['score']) };
    });
  }

  /** The rows of event hits (with their session's display title and agent kind). */
  eventRows(ids: readonly number[]): Map<number, SearchEventRow> {
    const out = new Map<number, SearchEventRow>();
    if (ids.length === 0) return out;
    const rows = this.#statement(
      `SELECT e.id, e.session_id, e.agent_id, e.ts, e.payload, a.kind AS agent_kind, COALESCE(NULLIF(s.title, ''), s.name) AS session_title
       FROM events e LEFT JOIN agents a ON a.id = e.agent_id LEFT JOIN sessions s ON s.id = e.session_id
       WHERE e.id IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(ids));
    for (const row of rows) {
      let payload: unknown = null;
      try {
        payload = JSON.parse(String(row['payload']));
      } catch {
        payload = null;
      }
      out.set(Number(row['id']), {
        id: Number(row['id']),
        sessionId: String(row['session_id']),
        agentId: row['agent_id'] === null ? null : String(row['agent_id']),
        agentKind: row['agent_kind'] === null || row['agent_kind'] === undefined ? null : String(row['agent_kind']),
        ts: String(row['ts']),
        payload,
        sessionTitle: row['session_title'] === null || row['session_title'] === undefined ? null : String(row['session_title']),
      });
    }
    return out;
  }

  /** The rows of item hits (with their session's display title). */
  itemRows(ids: readonly number[]): Map<number, SearchItemRow> {
    const out = new Map<number, SearchItemRow>();
    if (ids.length === 0) return out;
    const rows = this.#statement(
      `SELECT i.id, i.kind, i.ref, i.session_id, i.link, i.title, i.body, i.ts, COALESCE(NULLIF(s.title, ''), s.name) AS session_title
       FROM search_items i LEFT JOIN sessions s ON s.id = i.session_id
       WHERE i.id IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(ids));
    for (const row of rows) {
      out.set(Number(row['id']), {
        id: Number(row['id']),
        kind: String(row['kind']) as SearchItemKind,
        ref: String(row['ref']),
        sessionId: row['session_id'] === null ? null : String(row['session_id']),
        link: row['link'] === null ? null : String(row['link']),
        title: String(row['title']),
        body: String(row['body']),
        ts: String(row['ts']),
        sessionTitle: row['session_title'] === null || row['session_title'] === undefined ? null : String(row['session_title']),
      });
    }
    return out;
  }

  /** The index's size on disk (bytes of the FTS shadow tables and `search_items`), via `dbstat` when compiled in; `null` otherwise. */
  sizeBytes(): number | null {
    try {
      const row = this.#ctx.db
        .prepare("SELECT SUM(pgsize) AS n FROM dbstat WHERE name LIKE 'search_fts%' OR name LIKE 'search_items%' OR name = 'sqlite_autoindex_search_items_1'")
        .get();
      return row ? Number(row['n'] ?? 0) : null;
    } catch {
      return null;
    }
  }
}
