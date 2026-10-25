import type { SearchAnswer, SearchNotSearched, SearchResult, SearchScope } from '../../../core/search.ts';
import type { SidebarLayout } from '../../../core/sidebar-layout.ts';
import { SEARCH_WORDS } from '../glossary.ts';

/**
 * D131 · lane R · the v2 Search page's pure part (`/search?q=`): the address
 * (query, type, computer, folder, date), the four groups (Messages · Results ·
 * Tasks · Closed agents) over the D97 search answer (`GET /api/search`), the
 * client-side filters the API has no parameter for (computer, folder, date),
 * where each hit leads in v2, and the "<computer> not searched" note. No DOM.
 */

/** A type chip: every group, or one. */
export type V2SearchType = 'all' | 'messages' | 'results' | 'tasks' | 'closed';

/** The chips in order. */
export const V2_SEARCH_TYPES: readonly V2SearchType[] = ['all', 'messages', 'results', 'tasks', 'closed'];

/** The date filter. */
export type V2SearchDate = 'any' | 'today' | 'week';

/** The date options in order. */
export const V2_SEARCH_DATES: readonly V2SearchDate[] = ['any', 'today', 'week'];

/** The D97 scope behind each v2 group (Closed agents = the classic History). */
export const SCOPE_OF: Readonly<Record<Exclude<V2SearchType, 'all'>, SearchScope>> = {
  messages: 'conversations',
  results: 'artifacts',
  tasks: 'todos',
  closed: 'history',
};

/** The v2 group of a D97 scope. */
export const TYPE_OF: Readonly<Record<SearchScope, Exclude<V2SearchType, 'all'>>> = {
  conversations: 'messages',
  artifacts: 'results',
  todos: 'tasks',
  history: 'closed',
};

/** Each group's icon. */
export const TYPE_ICON: Readonly<Record<Exclude<V2SearchType, 'all'>, string>> = { messages: 'chat', results: 'results', tasks: 'task', closed: 'clock' };

/** The search waits this long after the last key (ms). */
export const V2_SEARCH_DEBOUNCE_MS = 200;

/** Rows shown per group. */
export const GROUP_ROWS = 8;

/** Everything the address holds. `computer`: `all`, `local` (this computer) or a paired machine's id; `folder`: `all` or a sidebar folder id. */
export interface V2SearchFilters {
  readonly q: string;
  readonly type: V2SearchType;
  readonly computer: string;
  readonly folder: string;
  readonly date: V2SearchDate;
}

/** The filters of an address's query string (anything unknown = its default). */
export function parseV2SearchAddress(search: string): V2SearchFilters {
  const params = new URLSearchParams(search);
  const type = params.get('type');
  const date = params.get('date');
  return {
    q: params.get('q') ?? '',
    type: (V2_SEARCH_TYPES as readonly string[]).includes(type ?? '') ? (type as V2SearchType) : 'all',
    computer: params.get('computer') || 'all',
    folder: params.get('folder') || 'all',
    date: (V2_SEARCH_DATES as readonly string[]).includes(date ?? '') ? (date as V2SearchDate) : 'any',
  };
}

/** The page's address for `filters` (defaults left out; `/search` for nothing). */
export function v2SearchPath(filters: V2SearchFilters): string {
  const params = new URLSearchParams();
  if (filters.q.trim() !== '') params.set('q', filters.q.trim());
  if (filters.type !== 'all') params.set('type', filters.type);
  if (filters.computer !== 'all') params.set('computer', filters.computer);
  if (filters.folder !== 'all') params.set('folder', filters.folder);
  if (filters.date !== 'any') params.set('date', filters.date);
  const text = params.toString();
  return text ? `/search?${text}` : '/search';
}

/** The `api.search()` parameters for `filters` (one scope when a type is chosen). */
export function apiParams(filters: V2SearchFilters): { readonly q: string; readonly scope?: SearchScope } {
  return filters.type === 'all' ? { q: filters.q.trim() } : { q: filters.q.trim(), scope: SCOPE_OF[filters.type] };
}

/** The session a result belongs to (`null`: a terminal conversation's History row). */
export function sessionOf(result: SearchResult): string | null {
  const target = result.target;
  switch (target.type) {
    case 'event':
    case 'session':
    case 'todo':
      return target.sessionId;
    case 'artifact':
      return target.sessionId;
    case 'history':
      return null;
  }
}

/** The ids of folder `folderId` and every folder inside it. */
export function folderAndBelow(layout: Pick<SidebarLayout, 'folders'>, folderId: string): Set<string> {
  const ids = new Set<string>([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of layout.folders) {
      if (!ids.has(folder.id) && folder.parentId && ids.has(folder.parentId)) {
        ids.add(folder.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** The sessions in folder `folderId` (and the folders inside it); `null` for `all`. */
export function folderSessions(layout: Pick<SidebarLayout, 'folders'> | null, folderId: string): Set<string> | null {
  if (folderId === 'all') return null;
  if (!layout) return new Set();
  const folders = folderAndBelow(layout, folderId);
  const sessions = new Set<string>();
  for (const folder of layout.folders) if (folders.has(folder.id)) for (const id of folder.sessionIds) sessions.add(id);
  return sessions;
}

/** The folder filter's options, nested folders indented (`— `), in the layout's order under their parents. */
export function folderOptions(layout: Pick<SidebarLayout, 'folders'> | null): Array<{ readonly value: string; readonly label: string }> {
  const out: Array<{ value: string; label: string }> = [{ value: 'all', label: SEARCH_WORDS.folderAny }];
  if (!layout) return out;
  const walk = (parent: string | null, depth: number): void => {
    for (const folder of layout.folders) {
      if ((folder.parentId ?? null) !== parent) continue;
      out.push({ value: folder.id, label: `${'— '.repeat(depth)}${folder.name}` });
      if (depth < 8) walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** The start of this browser's day, and of the day six days earlier (This week = the last 7 days, today included). */
export function dateFloor(date: V2SearchDate, now: number): number | null {
  if (date === 'any') return null;
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  if (date === 'week') day.setDate(day.getDate() - 6);
  return day.getTime();
}

/** What the client-side filters need besides the filters. */
export interface FilterContext {
  /** The sessions of the chosen folder (`null`: any folder). */
  readonly folderSessions: Set<string> | null;
  readonly now: number;
}

/** `true` when `result` passes the computer, folder and date filters. */
export function passes(result: SearchResult, filters: V2SearchFilters, context: FilterContext): boolean {
  if (filters.computer !== 'all') {
    const machine = result.machine?.id ?? 'local';
    if (machine !== filters.computer) return false;
  }
  if (context.folderSessions) {
    const session = sessionOf(result);
    if (!session || !context.folderSessions.has(session)) return false;
  }
  const floor = dateFloor(filters.date, context.now);
  if (floor !== null) {
    const at = Date.parse(result.ts);
    if (!Number.isFinite(at) || at < floor) return false;
  }
  return true;
}

/** `true` when a filter the API cannot apply narrows the answer (counts are then the rows shown). */
export function clientFiltered(filters: V2SearchFilters): boolean {
  return filters.computer !== 'all' || filters.folder !== 'all' || filters.date !== 'any';
}

/** One group of the page. */
export interface V2SearchGroup {
  readonly type: Exclude<V2SearchType, 'all'>;
  readonly label: string;
  readonly icon: string;
  /** Every match (the server's count), or the filtered rows' count when a client-side filter is on. */
  readonly count: number;
  readonly results: readonly SearchResult[];
  /** More than the rows here match (a one-type search pages further; Everything links to the type). */
  readonly more: boolean;
}

/**
 * The page's groups in the prototype's order (Messages · Results · Tasks · Closed
 * agents), filtered; with Everything only the groups with rows, with one type
 * that group even when empty.
 */
export function groupAnswer(answer: Pick<SearchAnswer, 'groups'> | null, filters: V2SearchFilters, context: FilterContext): V2SearchGroup[] {
  if (!answer) return [];
  const out: V2SearchGroup[] = [];
  for (const type of V2_SEARCH_TYPES) {
    if (type === 'all') continue;
    if (filters.type !== 'all' && filters.type !== type) continue;
    const group = answer.groups.find((candidate) => candidate.scope === SCOPE_OF[type]);
    const results = (group?.results ?? []).filter((result) => passes(result, filters, context));
    const filtered = clientFiltered(filters);
    const count = filtered ? results.length : (group?.count ?? 0);
    if (filters.type === 'all' && results.length === 0) continue;
    out.push({ type, label: SEARCH_WORDS.types[type], icon: TYPE_ICON[type], count, results, more: filtered ? false : (group?.count ?? 0) > results.length });
  }
  return out;
}

/**
 * Where a hit leads in v2: a message → its agent's chat at that message
 * (`/agents/:id/events/:eventId`, a helper's → `/agents/:id/helpers/:helperId/events/:eventId`);
 * an agent's title → the agent; a result → Results with it open
 * (`/results?open=<id>&agent=<session>[&computer=<machine>]`); a task → Tasks; a
 * closed agent (a terminal conversation, classic History) → Agents › Closed. A
 * paired computer's ids are remote ids (`r~<machine>~<id>`), as classic routes them.
 */
export function hitHref(result: SearchResult): string {
  const target = result.target;
  const enc = encodeURIComponent;
  switch (target.type) {
    case 'event':
      return target.agentId ? `/agents/${enc(target.sessionId)}/helpers/${enc(target.agentId)}/events/${target.eventId}` : `/agents/${enc(target.sessionId)}/events/${target.eventId}`;
    case 'session':
      return `/agents/${enc(target.sessionId)}`;
    case 'artifact': {
      const params = new URLSearchParams({ open: target.artifactId });
      if (target.sessionId) params.set('agent', target.sessionId);
      if (result.machine) params.set('computer', result.machine.id);
      return `/results?${params.toString()}`;
    }
    case 'todo':
      return '/tasks';
    case 'history':
      return '/agents?show=closed';
  }
}

/**
 * D131 · lane X · the agent an agent-title hit peeks at (the peek sheet, as Home and the boards
 * open an agent), `null` for every other hit: a message hit still jumps to the exact message
 * (the prototype's search page: "Exact message"), a result, task or closed agent to its page.
 */
export function peekSessionOf(result: Pick<SearchResult, 'target'>): string | null {
  return result.target.type === 'session' ? result.target.sessionId : null;
}

/** A message hit's "who": You or Agent (a tool line: its label). */
export function whoOf(result: SearchResult): string {
  if (result.kind === 'message') return result.detail === 'You' ? SEARCH_WORDS.you : SEARCH_WORDS.agent;
  if (result.kind === 'prompt') return SEARCH_WORDS.you;
  if (result.kind === 'tool') return result.detail ?? SEARCH_WORDS.agent;
  return SEARCH_WORDS.agent;
}

/** `true` for a hit in a chat line (shown as a message with "Exact message"). */
export function isMessageHit(result: SearchResult): boolean {
  return result.target.type === 'event';
}

/** `A`, `A and B`, `A, B and C`. */
export function andList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The note under the filters. */
export interface SearchNote {
  /** `missing`: some computer was not searched (the offline icon); `ok`: every computer answered. */
  readonly kind: 'missing' | 'ok';
  /** The bold part (`Studio-PC not searched (offline)`), `null` for `ok`. */
  readonly strong: string | null;
  readonly text: string;
}

/**
 * The prototype's note: "**Studio-PC not searched (offline)** · its agents and
 * results show up again when it’s back.", else "Searched Acme-MacBook and
 * Studio-PC · any time". `searched` = this computer's name, then the paired ones.
 */
export function searchNote(notSearched: readonly SearchNotSearched[], searched: readonly string[], date: V2SearchDate): SearchNote {
  if (notSearched.length > 0) {
    const strong = `${andList(notSearched.map((entry) => `${entry.machine.name}`))} ${SEARCH_WORDS.notSearched} (${andList([...new Set(notSearched.map((entry) => entry.reason))])})`;
    return { kind: 'missing', strong, text: notSearched.length === 1 ? SEARCH_WORDS.backSoon : SEARCH_WORDS.backSoonMany };
  }
  const when = SEARCH_WORDS.dates[date].toLowerCase();
  return { kind: 'ok', strong: null, text: `${SEARCH_WORDS.searched} ${andList(searched)} · ${when}` };
}
