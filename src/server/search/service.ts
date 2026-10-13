import { parseRemoteId, remoteId, type SessionMachine } from '../../core/peers.ts';
import {
  SEARCH_ALL_LIMIT,
  SEARCH_PAGE_LIMIT,
  SEARCH_SCOPES,
  type QueryTerm,
  type SearchAnswer,
  type SearchCursor,
  type SearchGroup,
  type SearchNotSearched,
  type SearchResult,
  type SearchScope,
  type SearchTarget,
  encodeSearchCursor,
  eventDetail,
  eventResultKind,
  eventSearchText,
  highlight,
  isSearchScope,
  matchExpression,
  parseSearchQuery,
  queryText,
} from '../../core/search.ts';
import type { Store } from '../db/store.ts';
import type { SearchHit } from '../db/repos/search.ts';
import type { PeerService } from '../peers/service.ts';
import type { SearchBackfill } from './backfill.ts';

/** How long a paired machine's search may take before it is left out ("not searched"). */
export const PEER_SEARCH_TIMEOUT_MS = 2_500;

/** A query as the route parsed it. */
export interface SearchParams {
  readonly q: string;
  /** `all` = every scope, {@link SEARCH_ALL_LIMIT} each by default. */
  readonly scope: SearchScope | 'all';
  /** Only this session (a remote id: only on its machine). */
  readonly session: string | null;
  /** `all` (default), `local` (this machine only) or a paired machine's id (only that one). */
  readonly machine: string;
  readonly limit: number | null;
  readonly cursor: SearchCursor | null;
  /** The request came from a paired machine (D48): this machine's own results only, never fanned out. */
  readonly fromPeer: boolean;
}

/** One source's page of a scope: results best first, its matches in all, and whether more follow. */
interface SourcePage {
  readonly results: readonly SearchResult[];
  readonly count: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * D97 (`docs/search.md`): `GET /api/search`. Turns the text into a safe FTS5
 * expression, reads this machine's index (bm25 + a recency boost), builds the
 * snippets, and (unless the request came from a peer or asks for this machine only)
 * asks the paired machines at the same time, each bounded by
 * {@link PEER_SEARCH_TIMEOUT_MS}; their results come back namespaced
 * (`r~<machine>~…`) and merged by score; a machine that did not answer is listed
 * as not searched.
 */
export class SearchService {
  readonly #store: Store;
  readonly #backfill: SearchBackfill | null;
  readonly #peers: PeerService | null;
  readonly #peerTimeoutMs: number;

  constructor(options: { readonly store: Store; readonly backfill?: SearchBackfill | null; readonly peers?: PeerService | null; readonly peerTimeoutMs?: number }) {
    this.#store = options.store;
    this.#backfill = options.backfill ?? null;
    this.#peers = options.peers ?? null;
    this.#peerTimeoutMs = options.peerTimeoutMs ?? PEER_SEARCH_TIMEOUT_MS;
  }

  async search(params: SearchParams): Promise<SearchAnswer> {
    const terms = parseSearchQuery(params.q);
    const match = matchExpression(terms);
    const scopes: readonly SearchScope[] = params.scope === 'all' ? SEARCH_SCOPES : [params.scope];
    const limit = params.limit ?? (params.scope === 'all' ? SEARCH_ALL_LIMIT : SEARCH_PAGE_LIMIT);
    const indexing = this.#backfill?.progress() ?? { done: true, percent: 100 };
    if (match === null) return { query: '', groups: scopes.map((scope) => ({ scope, count: 0, results: [], nextCursor: null })), indexing, notSearched: [] };
    const cursor = params.scope === 'all' ? null : params.cursor;

    const remoteSession = parseRemoteId(params.session);
    const localSession = params.session !== null && remoteSession === null ? params.session : null;
    const searchLocal = remoteSession === null && (params.machine === 'all' || params.machine === 'local');
    const fanOut = !params.fromPeer && this.#peers !== null && localSession === null && params.machine !== 'local';
    const only = remoteSession?.machineId ?? (params.machine === 'all' || params.machine === 'local' ? undefined : params.machine);

    const peerAsk = fanOut ? this.#askPeers(params, scopes, limit, cursor, remoteSession?.id ?? null, only) : Promise.resolve([]);
    const local = searchLocal ? this.#local(terms, match, scopes, localSession, cursor?.local ?? 0, limit) : null;
    const peers = await peerAsk;

    const notSearched: SearchNotSearched[] = [];
    const groups: SearchGroup[] = scopes.map((scope) => {
      const sources: Array<{ readonly key: string | null; readonly page: SourcePage; readonly offset: number }> = [];
      if (local) sources.push({ key: null, page: local.get(scope) ?? { results: [], count: 0 }, offset: cursor?.local ?? 0 });
      for (const peer of peers) {
        if (peer.groups === null) continue;
        const page = peer.groups.get(scope);
        if (page) sources.push({ key: peer.machine.id, page, offset: cursor?.peers[peer.machine.id] ?? 0 });
      }
      const merged = sources
        .flatMap((source) => source.page.results.map((result) => ({ result, key: source.key })))
        .sort((a, b) => a.result.score - b.result.score || (a.result.ts < b.result.ts ? 1 : a.result.ts > b.result.ts ? -1 : 0))
        .slice(0, limit);
      const count = sources.reduce((sum, source) => sum + source.page.count, 0);
      const next: { local: number; peers: Record<string, number> } = { local: cursor?.local ?? 0, peers: { ...(cursor?.peers ?? {}) } };
      for (const source of sources) {
        const taken = merged.filter((entry) => entry.key === source.key).length;
        if (source.key === null) next.local = source.offset + taken;
        else next.peers[source.key] = source.offset + taken;
      }
      const more = sources.some((source) => (source.key === null ? next.local : (next.peers[source.key] ?? 0)) < source.page.count);
      return { scope, count, results: merged.map((entry) => entry.result), nextCursor: more ? encodeSearchCursor(next) : null };
    });
    for (const peer of peers) if (peer.reason !== null) notSearched.push({ machine: peer.machine, reason: peer.reason });
    return { query: queryText(terms), groups, indexing, notSearched };
  }

  /** This machine's page of each scope. */
  #local(terms: readonly QueryTerm[], match: string, scopes: readonly SearchScope[], sessionId: string | null, offset: number, limit: number): Map<SearchScope, SourcePage> {
    const search = this.#store.search;
    const out = new Map<SearchScope, SourcePage>();
    if (!search.enabled) {
      for (const scope of scopes) out.set(scope, { results: [], count: 0 });
      return out;
    }
    const counts = search.counts(match, scopes, sessionId);
    for (const scope of scopes) {
      const count = counts.get(scope) ?? 0;
      const hits = count > offset ? search.hits(match, scope, sessionId, offset, limit) : [];
      out.set(scope, { results: this.#results(terms, scope, hits), count });
    }
    return out;
  }

  #results(terms: readonly QueryTerm[], scope: SearchScope, hits: readonly SearchHit[]): SearchResult[] {
    const search = this.#store.search;
    const events = search.eventRows(hits.filter((hit) => hit.source === 'e').map((hit) => hit.key));
    const items = search.itemRows(hits.filter((hit) => hit.source === 'i').map((hit) => hit.key));
    const results: SearchResult[] = [];
    for (const hit of hits) {
      if (hit.source === 'e') {
        const row = events.get(hit.key);
        if (!row) continue;
        const kind = eventResultKind(row.payload) ?? 'message';
        const sessionTitle = row.sessionTitle ?? 'Session';
        const subagent = row.agentId !== null && row.agentKind !== null && row.agentKind !== 'main';
        results.push({
          id: `e:${row.id}`,
          scope,
          kind,
          title: [{ text: sessionTitle }],
          snippet: highlight(eventSearchText(row.payload), terms),
          sessionTitle,
          detail: eventDetail(row.payload),
          ts: row.ts,
          score: hit.score,
          target: { type: 'event', sessionId: row.sessionId, eventId: row.id, agentId: subagent ? row.agentId : null },
        });
        continue;
      }
      const row = items.get(hit.key);
      if (!row) continue;
      let target: SearchTarget;
      if (row.kind === 'session') target = { type: 'session', sessionId: row.ref };
      else if (row.kind === 'artifact') target = { type: 'artifact', sessionId: row.sessionId, artifactId: row.ref };
      else if (row.kind === 'todo') target = { type: 'todo', sessionId: row.sessionId ?? '', todoId: row.ref };
      else target = { type: 'history', claudeSessionId: row.link ?? '' };
      results.push({
        id: `${row.kind}:${row.kind === 'history' ? (row.link ?? row.ref) : row.ref}`,
        scope,
        kind: row.kind,
        title: highlight(row.title, terms, 200),
        snippet: row.body === '' ? [] : highlight(row.body, terms),
        sessionTitle: row.kind === 'session' ? null : row.sessionTitle,
        detail: null,
        ts: row.ts,
        score: hit.score,
        target,
      });
    }
    return results;
  }

  /** The paired machines' pages (namespaced), or why one was not searched. History stays on its machine (no History through the peer API). */
  async #askPeers(
    params: SearchParams,
    scopes: readonly SearchScope[],
    limit: number,
    cursor: SearchCursor | null,
    session: string | null,
    only: string | undefined,
  ): Promise<Array<{ readonly machine: SessionMachine; readonly groups: Map<SearchScope, SourcePage> | null; readonly reason: string | null }>> {
    const peers = this.#peers;
    if (!peers) return [];
    const asked = scopes.filter((scope) => scope !== 'history');
    if (asked.length === 0) return [];
    const answers = await Promise.all(
      // One request per machine (each with its own cursor offset).
      (await peers.machines())
        .filter((machine) => only === undefined || machine.id === only)
        .map(async (machine) => {
          const query = new URLSearchParams({ q: params.q, scope: params.scope === 'all' ? 'all' : (asked[0] ?? 'sessions'), limit: String(limit), machine: 'local' });
          if (cursor) query.set('cursor', encodeSearchCursor({ local: cursor.peers[machine.id] ?? 0, peers: {} }));
          if (session !== null) query.set('session', session);
          const [answer] = await peers.fanOutGet(`/api/search?${query.toString()}`, { timeoutMs: this.#peerTimeoutMs, only: machine.id });
          return answer;
        }),
    );
    const out: Array<{ readonly machine: SessionMachine; readonly groups: Map<SearchScope, SourcePage> | null; readonly reason: string | null }> = [];
    for (const answer of answers) {
      if (!answer) continue;
      const machine: SessionMachine = { id: answer.machine.id, name: answer.machine.name, state: answer.machine.state };
      if (answer.reason !== null) {
        out.push({ machine, groups: null, reason: answer.reason });
        continue;
      }
      const groups = peerGroups(machine, answer.body, asked);
      out.push(groups ? { machine, groups, reason: null } : { machine, groups: null, reason: 'answered something unexpected' });
    }
    return out;
  }
}

/** A paired machine's answer as pages of this machine's scopes: ids and session ids namespaced, `machine` added; `null` when it is not a search answer. */
export function peerGroups(machine: SessionMachine, body: unknown, scopes: readonly SearchScope[]): Map<SearchScope, SourcePage> | null {
  if (!isRecord(body) || !Array.isArray(body['groups'])) return null;
  const out = new Map<SearchScope, SourcePage>();
  for (const group of body['groups']) {
    if (!isRecord(group) || !isSearchScope(group['scope']) || !scopes.includes(group['scope']) || !Array.isArray(group['results'])) continue;
    const results: SearchResult[] = [];
    for (const raw of group['results']) {
      const result = peerResult(machine, raw);
      if (result) results.push(result);
    }
    out.set(group['scope'], { results, count: typeof group['count'] === 'number' ? group['count'] : results.length });
  }
  return out;
}

function ns(machine: SessionMachine, id: string): string {
  return remoteId(machine.id, id);
}

/** One of a paired machine's results, namespaced; `null` when malformed or not reachable from here (History). */
export function peerResult(machine: SessionMachine, raw: unknown): SearchResult | null {
  if (!isRecord(raw) || typeof raw['id'] !== 'string' || !isRecord(raw['target']) || typeof raw['score'] !== 'number') return null;
  const result = raw as unknown as SearchResult;
  const target = result.target;
  let mapped: SearchTarget;
  switch (target.type) {
    case 'event':
      mapped = { ...target, sessionId: ns(machine, target.sessionId) };
      break;
    case 'session':
      mapped = { ...target, sessionId: ns(machine, target.sessionId) };
      break;
    case 'artifact':
      mapped = { ...target, sessionId: target.sessionId === null ? null : ns(machine, target.sessionId) };
      break;
    case 'todo':
      mapped = { ...target, sessionId: ns(machine, target.sessionId) };
      break;
    default:
      return null;
  }
  return { ...result, id: ns(machine, result.id), target: mapped, machine };
}
