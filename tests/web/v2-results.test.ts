import { describe, expect, it } from 'vitest';
import type { ArtifactKind, ArtifactListItem } from '../../src/core/api.ts';
import { ICON_NAMES } from '../../src/web/v2/components/icon-paths.ts';
import { RESULTS_WORDS } from '../../src/web/v2/glossary.ts';
import {
  FILTER_ICONS,
  FILTER_KINDS,
  RESULT_FILTERS,
  applyFilter,
  comparePair,
  filterCounts,
  filterOfKind,
  findLinked,
  hasSource,
  kindIcon,
  linkOf,
  matchesQuery,
  parseResultsLink,
  pruneSelection,
  resultKey,
  resultsLink,
  toggleKey,
  visibleResults,
  withoutPending,
} from '../../src/web/v2/results/results-model.ts';

const KINDS: readonly ArtifactKind[] = ['markdown', 'code', 'html', 'mermaid', 'svg', 'image', 'pdf', 'csv'];

function item(id: string, kind: ArtifactKind, extra: Partial<ArtifactListItem> = {}): ArtifactListItem {
  return {
    id,
    sessionId: 's1',
    title: `Title ${id}`,
    kind,
    language: null,
    createdBy: 'agent',
    versions: 1,
    size: 10,
    createdAt: '2026-10-25T10:00:00Z',
    updatedAt: '2026-10-25T10:00:00Z',
    sessionName: 'acme-checkout',
    sessionTitle: 'Checkout redesign',
    folder: null,
    folderPath: null,
    ...extra,
  };
}

const rows: readonly ArtifactListItem[] = [
  item('a', 'markdown', { title: 'Release notes' }),
  item('b', 'pdf', { title: 'Q3 usage report' }),
  item('c', 'mermaid', { title: 'Checkout flow' }),
  item('d', 'svg', { title: 'Logo', machine: { id: 'm2', name: 'Studio-PC', state: 'online' } as ArtifactListItem['machine'] }),
  item('e', 'csv', { title: 'Test results' }),
  item('f', 'html', { title: 'Landing mockup' }),
  item('g', 'code', { title: 'Script', language: 'python' }),
  item('h', 'image', { title: 'Screenshot' }),
];

describe('v2 Results · filters', () => {
  it('every server kind belongs to exactly one filter, and the filters are the brief’s seven plus All', () => {
    expect(RESULT_FILTERS).toEqual(['all', 'documents', 'pdfs', 'diagrams', 'images', 'tables', 'web', 'code']);
    for (const kind of KINDS) {
      const owners = Object.entries(FILTER_KINDS).filter(([, kinds]) => kinds.includes(kind));
      expect(owners, kind).toHaveLength(1);
      expect(filterOfKind(kind)).toBe(owners[0]![0]);
    }
    expect(Object.values(RESULTS_WORDS.filters)).toEqual(['All', 'Documents', 'PDFs', 'Diagrams', 'Images', 'Tables', 'Web pages', 'Code']);
  });

  it('applies a filter and counts every filter', () => {
    expect(applyFilter(rows, 'all')).toHaveLength(8);
    expect(applyFilter(rows, 'diagrams').map((row) => row.id)).toEqual(['c', 'd']);
    expect(applyFilter(rows, 'web').map((row) => row.id)).toEqual(['f']);
    expect(filterCounts(rows)).toEqual({ all: 8, documents: 1, pdfs: 1, diagrams: 2, images: 1, tables: 1, web: 1, code: 1 });
    expect(filterCounts([])).toEqual({ all: 0, documents: 0, pdfs: 0, diagrams: 0, images: 0, tables: 0, web: 0, code: 0 });
  });

  it('icons exist in the v2 set', () => {
    for (const icon of Object.values(FILTER_ICONS)) expect(ICON_NAMES).toContain(icon);
    for (const kind of KINDS) expect(ICON_NAMES).toContain(kindIcon(kind));
  });
});

describe('v2 Results · search within', () => {
  it('matches every word anywhere: title, kind label, language, the agent, the computer', () => {
    const label = (kind: ArtifactKind): string => RESULTS_WORDS.kinds[kind];
    expect(matchesQuery(rows[0]!, '')).toBe(true);
    expect(matchesQuery(rows[0]!, 'RELEASE notes')).toBe(true);
    expect(matchesQuery(rows[0]!, 'release cart')).toBe(false);
    expect(matchesQuery(rows[6]!, 'python')).toBe(true);
    expect(matchesQuery(rows[3]!, 'studio')).toBe(true);
    expect(matchesQuery(rows[1]!, 'checkout redesign')).toBe(true);
    expect(matchesQuery(rows[5]!, 'web page', label)).toBe(true);
    expect(visibleResults(rows, 'diagrams', 'logo').map((row) => row.id)).toEqual(['d']);
    expect(visibleResults(rows, 'tables', 'logo')).toEqual([]);
  });
});

describe('v2 Results · selection and Undo', () => {
  it('keys by computer and id; toggles; prunes rows no longer shown or selectable', () => {
    expect(resultKey(rows[0]!)).toBe('/a');
    expect(resultKey(rows[3]!)).toBe('m2/d');
    const one = toggleKey(new Set(), '/a', true);
    const two = toggleKey(one, 'm2/d', true);
    expect([...two]).toEqual(['/a', 'm2/d']);
    expect([...toggleKey(two, '/a', false)]).toEqual(['m2/d']);
    expect([...pruneSelection(two, [rows[0]!], () => true)]).toEqual(['/a']);
    expect([...pruneSelection(two, rows, (row) => row.id !== 'd')]).toEqual(['/a']);
    expect(pruneSelection(two, rows, () => true)).toBe(two);
  });

  it('hides rows waiting for their Undo window', () => {
    expect(withoutPending(rows, new Set(['/a', 'm2/d'])).map((row) => row.id)).toEqual(['b', 'c', 'e', 'f', 'g', 'h']);
    expect(withoutPending(rows, new Set())).toHaveLength(8);
  });
});

describe('v2 Results · the drawer', () => {
  it('Source and Copy only for text kinds; compare pairs', () => {
    expect(hasSource('markdown')).toBe(true);
    expect(hasSource('pdf')).toBe(false);
    expect(hasSource('image')).toBe(false);
    expect(comparePair(1, 1)).toBeNull();
    expect(comparePair(3, 3)).toEqual([2, 3]);
    expect(comparePair(1, 3)).toEqual([1, 2]);
  });
});

describe('v2 Results · the deep link', () => {
  it('builds and reads `/results?open=…&agent=…&computer=…`', () => {
    expect(resultsLink({ id: 'a1' })).toBe('/results?open=a1');
    expect(resultsLink({ id: 'a 1', agent: 'r~m2~s', computer: 'm2' })).toBe('/results?open=a+1&agent=r%7Em2%7Es&computer=m2');
    expect(parseResultsLink('?open=a+1&agent=r%7Em2%7Es&computer=m2')).toEqual({ id: 'a 1', agent: 'r~m2~s', computer: 'm2' });
    expect(parseResultsLink('')).toBeNull();
    expect(parseResultsLink('?q=x')).toBeNull();
    expect(linkOf(rows[3]!)).toBe('/results?open=d&agent=s1&computer=m2');
  });

  it('finds the linked row, narrowed by agent and computer, else by id alone', () => {
    const twin = item('d', 'svg', { title: 'Local twin' });
    const all = [twin, ...rows];
    expect(findLinked(all, { id: 'd', computer: 'm2' })?.title).toBe('Logo');
    expect(findLinked(all, { id: 'd' })?.title).toBe('Local twin');
    expect(findLinked(all, { id: 'd', computer: 'gone' })?.title).toBe('Local twin');
    expect(findLinked(all, { id: 'zz' })).toBeNull();
  });
});
