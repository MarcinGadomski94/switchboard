/**
 * D131 · lane R · the pure model of the v2 Results page (`/results`): the type
 * filters, their counts, search within, the selection and the deep link. DOM-free
 * (the Node typecheck has no DOM lib); unit-tested in `tests/web/v2-results.test.ts`.
 */
import type { ArtifactKind, ArtifactListItem } from '../../../core/api.ts';
import { isTextKind } from '../../../core/artifacts.ts';

/** The type filters, in the prototype's order (`all` first). */
export const RESULT_FILTERS = ['all', 'documents', 'pdfs', 'diagrams', 'images', 'tables', 'web', 'code'] as const;
/** A type filter. */
export type ResultFilter = (typeof RESULT_FILTERS)[number];

/** Which server kinds each filter shows (`all`: every kind). */
export const FILTER_KINDS: Readonly<Record<Exclude<ResultFilter, 'all'>, readonly ArtifactKind[]>> = {
  documents: ['markdown'],
  pdfs: ['pdf'],
  diagrams: ['mermaid', 'svg'],
  images: ['image'],
  tables: ['csv'],
  web: ['html'],
  code: ['code'],
};

/** Each filter's icon (the v2 icon set). */
export const FILTER_ICONS: Readonly<Record<Exclude<ResultFilter, 'all'>, string>> = {
  documents: 'results',
  pdfs: 'results',
  diagrams: 'diagram',
  images: 'image',
  tables: 'table',
  web: 'external',
  code: 'cmd',
};

/** The filter a kind belongs to. */
export function filterOfKind(kind: ArtifactKind): Exclude<ResultFilter, 'all'> {
  for (const [filter, kinds] of Object.entries(FILTER_KINDS) as [Exclude<ResultFilter, 'all'>, readonly ArtifactKind[]][]) {
    if (kinds.includes(kind)) return filter;
  }
  return 'documents';
}

/** The icon of a kind (the v2 icon set). */
export function kindIcon(kind: ArtifactKind): string {
  switch (kind) {
    case 'mermaid':
    case 'svg':
      return 'diagram';
    case 'csv':
      return 'table';
    case 'image':
      return 'image';
    case 'code':
      return 'cmd';
    case 'html':
      return 'external';
    default:
      return 'results';
  }
}

/** A row's key: its computer and its id (ids are unique per computer only). */
export function resultKey(item: Pick<ArtifactListItem, 'id' | 'machine'>): string {
  return `${item.machine?.id ?? ''}/${item.id}`;
}

/** The rows a filter shows. */
export function applyFilter(items: readonly ArtifactListItem[], filter: ResultFilter): ArtifactListItem[] {
  if (filter === 'all') return [...items];
  const kinds = FILTER_KINDS[filter];
  return items.filter((item) => kinds.includes(item.kind));
}

/** How many rows each filter would show (`all` = every row). */
export function filterCounts(items: readonly ArtifactListItem[]): Readonly<Record<ResultFilter, number>> {
  const counts: Record<ResultFilter, number> = { all: items.length, documents: 0, pdfs: 0, diagrams: 0, images: 0, tables: 0, web: 0, code: 0 };
  for (const item of items) counts[filterOfKind(item.kind)] += 1;
  return counts;
}

/** The text search within matches: title, kind, language, the agent's name and title, the computer. */
function haystack(item: ArtifactListItem, kindLabel: (kind: ArtifactKind) => string): string {
  return [item.title, item.kind, kindLabel(item.kind), item.language ?? '', item.sessionTitle ?? '', item.sessionName ?? '', item.machine?.name ?? ''].join('\n').toLowerCase();
}

/** Search within: every word of `query` appears somewhere (case-insensitive); an empty query matches all. */
export function matchesQuery(item: ArtifactListItem, query: string, kindLabel: (kind: ArtifactKind) => string = (kind) => kind): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = haystack(item, kindLabel);
  return words.every((word) => text.includes(word));
}

/** The rows shown: the filter, then search within (newest first, as the service sends them). */
export function visibleResults(items: readonly ArtifactListItem[], filter: ResultFilter, query: string, kindLabel?: (kind: ArtifactKind) => string): ArtifactListItem[] {
  return applyFilter(items, filter).filter((item) => matchesQuery(item, query, kindLabel));
}

/** Toggles one key in a selection (a new set). */
export function toggleKey(selected: ReadonlySet<string>, key: string, on: boolean): ReadonlySet<string> {
  const next = new Set(selected);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

/** The selection after a reload or a filter change: only keys of rows still shown and selectable. */
export function pruneSelection(selected: ReadonlySet<string>, shown: readonly ArtifactListItem[], selectable: (item: ArtifactListItem) => boolean): ReadonlySet<string> {
  if (selected.size === 0) return selected;
  const keys = new Set(shown.filter(selectable).map(resultKey));
  const kept = [...selected].filter((key) => keys.has(key));
  return kept.length === selected.size ? selected : new Set(kept);
}

/** The rows without the ones waiting to be deleted (the Undo window, D111). */
export function withoutPending(items: readonly ArtifactListItem[], pending: ReadonlySet<string>): ArtifactListItem[] {
  return pending.size === 0 ? [...items] : items.filter((item) => !pending.has(resultKey(item)));
}

/** What the drawer can show for a kind: Source / Rendered and Copy for text kinds only. */
export function hasSource(kind: ArtifactKind): boolean {
  return isTextKind(kind);
}

/** The deep link's fields (`/results?open=<id>[&agent=<sessionId>][&computer=<machineId>]`). */
export interface ResultLink {
  readonly id: string;
  readonly agent?: string | null;
  readonly computer?: string | null;
}

/** The address that opens a result's drawer on the Results page. */
export function resultsLink(link: ResultLink): string {
  const params = new URLSearchParams({ open: link.id });
  if (link.agent) params.set('agent', link.agent);
  if (link.computer) params.set('computer', link.computer);
  return `/results?${params.toString()}`;
}

/** Reads the deep link from the address's query (`null` without `open`). */
export function parseResultsLink(search: string): ResultLink | null {
  const params = new URLSearchParams(search);
  const id = params.get('open');
  if (!id) return null;
  return { id, agent: params.get('agent'), computer: params.get('computer') };
}

/** The row a deep link names (by id; the agent and computer narrow it when given). */
export function findLinked(items: readonly ArtifactListItem[], link: ResultLink): ArtifactListItem | null {
  return (
    items.find((item) => item.id === link.id && (!link.agent || item.sessionId === link.agent) && (!link.computer || (item.machine?.id ?? null) === link.computer)) ??
    items.find((item) => item.id === link.id) ??
    null
  );
}

/** A deep link to a row. */
export function linkOf(item: ArtifactListItem): string {
  return resultsLink({ id: item.id, agent: item.sessionId, computer: item.machine?.id ?? null });
}

/** The versions to compare side by side: the one shown and the one before it (or after, for v1). */
export function comparePair(shown: number, versions: number): readonly [number, number] | null {
  if (versions < 2) return null;
  if (shown <= 1) return [1, 2];
  return [shown - 1, shown];
}
