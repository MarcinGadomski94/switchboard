import { SEARCH_SCOPES, type SearchGroup, type SearchResult, type SearchScope, type SearchSegment } from '../../core/search.ts';
import type { SessionMachine } from '../../core/peers.ts';
import type { PaletteEntry } from '../modals/palette.ts';

/**
 * D97 · the Search page's and the palette's search model (`docs/search.md` →
 * *Search page*), pure so the Vitest suite covers it: the scope chips, where a
 * result leads, the result rows grouped by machine, and the address's `?q=`.
 */

/** A scope chip: every group, or one of them. */
export type SearchChip = SearchScope | 'all';

/** The chips in their order, with their labels. */
export const SEARCH_CHIPS: ReadonlyArray<readonly [chip: SearchChip, label: string]> = [
  ['all', 'All'],
  ['conversations', 'Conversations'],
  ['artifacts', 'Artifacts'],
  ['todos', 'Todos'],
  ['history', 'History'],
];

/** A group's heading. */
export const SCOPE_LABEL: Record<SearchScope, string> = { conversations: 'Conversations', artifacts: 'Artifacts', todos: 'Todos', history: 'History' };

/** The search waits this long after the last key before it asks (ms). */
export const SEARCH_DEBOUNCE_MS = 180;

/** The input's placeholder. */
export const SEARCH_PLACEHOLDER = 'Search conversations, artifacts, todos and history…';

/** D97: the palette's search command: a query starting with this searches everything (`? invoice`). */
export const PALETTE_SEARCH_PREFIX = '?';

/** The palette's search text when `query` is a search command (`?text`), else `null` (`''` = the command without text yet). */
export function paletteSearchText(query: string): string | null {
  if (!query.startsWith(PALETTE_SEARCH_PREFIX)) return null;
  return query.slice(PALETTE_SEARCH_PREFIX.length).trim();
}

/**
 * Where a result leads, as the router's routes (a structural subset of `Route`,
 * so this model stays free of JSX modules): a message opens its chat at that
 * event (a subagent's: its chat); a session its chat; an artifact its session's
 * Artifacts tab on it (the Artifacts page when its session is gone); a todo its
 * session's chat (the todo strip); a History row the History page.
 */
export type SearchRoute =
  | { readonly view: 'session'; readonly id: string; readonly tab: 'chat'; readonly eventId?: number; readonly agentId?: string }
  | { readonly view: 'session'; readonly id: string; readonly tab: 'artifacts'; readonly artifactId: string }
  | { readonly view: 'artifacts' | 'history' | 'todos' };

/** The route a result opens. */
export function resultRoute(result: SearchResult): SearchRoute {
  const target = result.target;
  switch (target.type) {
    case 'event':
      return { view: 'session', id: target.sessionId, tab: 'chat', eventId: target.eventId, ...(target.agentId ? { agentId: target.agentId } : {}) };
    case 'session':
      return { view: 'session', id: target.sessionId, tab: 'chat' };
    case 'artifact':
      return target.sessionId ? { view: 'session', id: target.sessionId, tab: 'artifacts', artifactId: target.artifactId } : { view: 'artifacts' };
    case 'todo':
      return target.sessionId ? { view: 'session', id: target.sessionId, tab: 'chat' } : { view: 'todos' };
    case 'history':
      return { view: 'history' };
  }
}

/** A result's kind tag (`Message`, `Note`, `Bash`, `Artifact`, …). D106: a chat's title is `Chat`, anything else in a chat gets ` · chat`. */
export function kindLabel(result: SearchResult): string {
  const label = baseKindLabel(result);
  if (!result.chat) return label;
  return result.kind === 'session' ? 'Chat' : `${label} · chat`;
}

function baseKindLabel(result: SearchResult): string {
  switch (result.kind) {
    case 'message':
      return result.detail === 'You' ? 'You' : 'Agent';
    case 'note':
      return 'Note';
    case 'prompt':
      return 'Prompt';
    case 'tool':
      return result.detail ?? 'Tool';
    case 'session':
      return 'Session';
    case 'artifact':
      return 'Artifact';
    case 'todo':
      return 'Todo';
    case 'history':
      return 'History';
  }
}

/** The plain text of segments. */
export function plainText(segments: readonly SearchSegment[]): string {
  return segments.map((segment) => segment.text).join('');
}

/** One machine's results within a group (`machine` = `null` for this machine). */
export interface MachineBlock {
  readonly key: string;
  readonly machine: SessionMachine | null;
  readonly results: readonly SearchResult[];
}

/**
 * A group's results by machine: this machine's first, then each paired machine's
 * in the order its first result appears (best first within each). One block when
 * every result is this machine's.
 */
export function byMachine(results: readonly SearchResult[]): MachineBlock[] {
  const blocks = new Map<string, { machine: SessionMachine | null; results: SearchResult[] }>();
  blocks.set('', { machine: null, results: [] });
  for (const result of results) {
    const key = result.machine?.id ?? '';
    let block = blocks.get(key);
    if (!block) {
      block = { machine: result.machine ?? null, results: [] };
      blocks.set(key, block);
    }
    block.results.push(result);
  }
  return [...blocks].filter(([, block]) => block.results.length > 0).map(([key, block]) => ({ key: key === '' ? 'local' : key, machine: block.machine, results: block.results }));
}

/** The groups the page shows: those with results, in {@link SEARCH_SCOPES} order (one scope: that group even when empty). */
export function shownGroups(groups: readonly SearchGroup[], chip: SearchChip): SearchGroup[] {
  const ordered = [...groups].sort((a, b) => SEARCH_SCOPES.indexOf(a.scope) - SEARCH_SCOPES.indexOf(b.scope));
  return chip === 'all' ? ordered.filter((group) => group.results.length > 0) : ordered.filter((group) => group.scope === chip);
}

/** The count line of a group: `3` or `5 of 42`. */
export function countText(group: SearchGroup): string {
  return group.count > group.results.length ? `${group.results.length} of ${group.count}` : String(group.count);
}

/** The page's address for `q` and `chip` (`/search?q=…&scope=…`; `/search` for nothing). */
export function searchPath(q: string, chip: SearchChip = 'all'): string {
  const params = new URLSearchParams();
  if (q !== '') params.set('q', q);
  if (chip !== 'all') params.set('scope', chip);
  const text = params.toString();
  return text ? `/search?${text}` : '/search';
}

/** The query and chip of an address's query string (`?q=…&scope=…`). */
export function parseSearchAddress(search: string): { readonly q: string; readonly chip: SearchChip } {
  const params = new URLSearchParams(search);
  const scope = params.get('scope');
  const chip = SEARCH_CHIPS.find(([candidate]) => candidate === scope)?.[0] ?? 'all';
  return { q: params.get('q') ?? '', chip };
}

/** The one-line note of the machines not searched (`Not searched: Acme laptop (offline)`), `null` when every machine answered. */
export function notSearchedText(list: readonly { readonly machine: SessionMachine; readonly reason: string }[]): string | null {
  if (list.length === 0) return null;
  return `Not searched: ${list.map((entry) => `${entry.machine.name} (${entry.reason})`).join(', ')}`;
}

/** D97: how many results the palette's search lists (the Search page has the rest). */
export const PALETTE_SEARCH_RESULTS = 8;

/** D97: the label of the palette's last search row. */
export function allResultsLabel(text: string): string {
  return `All results for “${text}”`;
}

/**
 * D97 · the palette's search command (`?text`, `docs/search.md` → *Palette*): the
 * best results of every group (in group order, at most {@link PALETTE_SEARCH_RESULTS}),
 * each opening where the Search page's row does, then a row opening the Search
 * page with the text. `answer` = `null` while the first answer is on its way (only
 * that last row); `?` alone: one row asking for the text.
 */
export function paletteSearchEntries(text: string, answer: { readonly groups: readonly SearchGroup[] } | null): PaletteEntry[] {
  if (text === '') return [{ key: 'search:empty', kind: 'search', label: 'Search everything…', hint: 'type what to find', target: { type: 'none' } }];
  const rows: PaletteEntry[] = [];
  for (const group of shownGroups(answer?.groups ?? [], 'all')) {
    for (const result of group.results) {
      if (rows.length >= PALETTE_SEARCH_RESULTS) break;
      const heading = result.kind === 'session' || result.kind === 'artifact' || result.kind === 'todo' || result.kind === 'history' ? plainText(result.title) : null;
      const label = heading ?? plainText(result.snippet);
      const where = [kindLabel(result), heading ? null : result.sessionTitle, result.machine?.name ?? null].filter((part): part is string => part !== null && part !== '').join(' · ');
      rows.push({ key: `search:${result.id}`, kind: 'search', label, hint: where, target: { type: 'search-result', route: resultRoute(result) } });
    }
  }
  rows.push({ key: 'search:all', kind: 'search', label: allResultsLabel(text), hint: '⌘⇧F', target: { type: 'search-page', q: text } });
  return rows;
}
