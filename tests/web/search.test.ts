import { beforeAll, describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../src/core/api.ts';
import type { SearchGroup, SearchResult } from '../../src/core/search.ts';
import { aroundWindow, inWindow, withNewerPage } from '../../src/web/views/session/session-loading.ts';
import {
  allResultsLabel,
  byMachine,
  countText,
  kindLabel,
  notSearchedText,
  paletteSearchEntries,
  paletteSearchText,
  parseSearchAddress,
  resultRoute,
  searchPath,
  shownGroups,
} from '../../src/web/views/search-view.ts';

/** D97 (`docs/search.md`): the Search page's and palette's model, and the chat window opened around an event. */

const at = (id: number, minute: number): SessionEvent =>
  ({ id, sessionId: 's', agentId: null, ts: `2026-10-10T10:${String(minute).padStart(2, '0')}:00.000Z`, endTs: null, kind: 'text', label: `e${id}`, payload: null }) as unknown as SessionEvent;

function result(id: string, extra: Partial<SearchResult> = {}): SearchResult {
  return {
    id,
    scope: 'conversations',
    kind: 'message',
    title: [{ text: 'Acme billing' }],
    snippet: [{ text: 'the ' }, { text: 'invoice', match: true }],
    sessionTitle: 'Acme billing',
    detail: 'Agent',
    ts: '2026-10-10T10:00:00.000Z',
    score: -1,
    target: { type: 'event', sessionId: 's1', eventId: 7, agentId: null },
    ...extra,
  };
}

describe('D97 · a chat window opened around an event', () => {
  // Page of 5 around event 5: 2 older, the anchor, 2 newer.
  const page = [at(3, 3), at(4, 4), at(5, 5), at(6, 6), at(7, 7)];

  it('full sides leave a cursor (older) and `newer`; short sides reach the start / the end', () => {
    expect(aroundWindow(page, 5, 5)).toMatchObject({ cursor: { id: 3 }, newer: { id: 7 } });
    expect(aroundWindow(page.slice(1), 4, 5)).toMatchObject({ cursor: null, newer: { id: 7 } });
    expect(aroundWindow(page.slice(0, 4), 5, 5)).toMatchObject({ cursor: { id: 3 }, newer: null });
    // A machine without `around` answers its newest page or everything: taken as the newest page.
    expect(aroundWindow(page, 99, 5)).toMatchObject({ cursor: { id: 3 }, newer: null });
    expect(aroundWindow(page, 99, 10)).toMatchObject({ cursor: null, newer: null });
  });

  it('hub events newer than the window wait; the last newer page brings them, once each', () => {
    const window = aroundWindow(page, 5, 5);
    expect(inWindow(window, at(8, 8))).toBe(false);
    expect(inWindow(window, at(6, 6))).toBe(true);
    expect(inWindow(window, at(2, 2))).toBe(false);
    const next = withNewerPage(window, [at(8, 8), at(9, 9)], 2);
    expect(next.list.map((e) => e.id)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(next.newer?.id).toBe(9);
    const last = withNewerPage(next, [at(10, 10)], 2, [at(10, 10), at(11, 11)]);
    expect(last.list.map((e) => e.id)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(last.newer).toBeNull();
    expect(last.cursor?.id).toBe(3);
    // A page with nothing new ends the window too.
    expect(withNewerPage(next, [at(9, 9)], 2).newer).toBeNull();
  });
});

describe('D97 · the Search page model', () => {
  it('a result opens its message (a subagent\'s chat), session, artifact (or the Artifacts page), todo, History', () => {
    expect(resultRoute(result('e:7'))).toEqual({ view: 'session', id: 's1', tab: 'chat', eventId: 7 });
    expect(resultRoute(result('e:8', { target: { type: 'event', sessionId: 's1', eventId: 8, agentId: 'a1' } }))).toEqual({ view: 'session', id: 's1', tab: 'chat', eventId: 8, agentId: 'a1' });
    expect(resultRoute(result('session:s1', { kind: 'session', target: { type: 'session', sessionId: 's1' } }))).toEqual({ view: 'session', id: 's1', tab: 'chat' });
    expect(resultRoute(result('artifact:a', { kind: 'artifact', target: { type: 'artifact', sessionId: 's1', artifactId: 'a' } }))).toEqual({ view: 'session', id: 's1', tab: 'artifacts', artifactId: 'a' });
    expect(resultRoute(result('artifact:b', { kind: 'artifact', target: { type: 'artifact', sessionId: null, artifactId: 'b' } }))).toEqual({ view: 'artifacts' });
    expect(resultRoute(result('todo:t', { kind: 'todo', target: { type: 'todo', sessionId: 's1', todoId: 't' } }))).toEqual({ view: 'session', id: 's1', tab: 'chat' });
    expect(resultRoute(result('history:c', { kind: 'history', target: { type: 'history', claudeSessionId: 'c' } }))).toEqual({ view: 'history' });
    expect(kindLabel(result('e:1', { detail: 'You' }))).toBe('You');
    expect(kindLabel(result('e:2', { kind: 'tool', detail: 'Bash' }))).toBe('Bash');
    expect(kindLabel(result('e:3', { kind: 'note' }))).toBe('Note');
  });

  it('groups by machine: this machine first, then each paired machine in the order of its first result', () => {
    const laptop = { id: 'aaaaaaaaaaaa', name: 'Acme laptop', state: 'online' as const };
    const desktop = { id: 'bbbbbbbbbbbb', name: 'Acme desktop', state: 'online' as const };
    const blocks = byMachine([result('r1', { machine: desktop }), result('l1'), result('r2', { machine: laptop }), result('r3', { machine: desktop }), result('l2')]);
    expect(blocks.map((b) => [b.key, b.results.map((r) => r.id)])).toEqual([
      ['local', ['l1', 'l2']],
      [desktop.id, ['r1', 'r3']],
      [laptop.id, ['r2']],
    ]);
    expect(byMachine([result('r1', { machine: desktop })]).map((b) => b.key)).toEqual([desktop.id]);
  });

  it('shows the groups with results (all), or the one chip\'s; counts; the address; the not-searched note', () => {
    const groups: SearchGroup[] = [
      { scope: 'todos', count: 0, results: [], nextCursor: null },
      { scope: 'conversations', count: 42, results: [result('e:1')], nextCursor: 'x' },
    ];
    expect(shownGroups(groups, 'all').map((g) => g.scope)).toEqual(['conversations']);
    expect(shownGroups(groups, 'todos').map((g) => g.scope)).toEqual(['todos']);
    expect(countText(groups[1]!)).toBe('1 of 42');
    expect(countText(groups[0]!)).toBe('0');
    expect(searchPath('zanzibar ledger', 'todos')).toBe('/search?q=zanzibar+ledger&scope=todos');
    expect(searchPath('')).toBe('/search');
    expect(parseSearchAddress('?q=zanzibar+ledger&scope=todos')).toEqual({ q: 'zanzibar ledger', chip: 'todos' });
    expect(parseSearchAddress('?scope=nope')).toEqual({ q: '', chip: 'all' });
    expect(notSearchedText([])).toBeNull();
    expect(notSearchedText([{ machine: { id: 'aaaaaaaaaaaa', name: 'Acme laptop', state: 'offline' }, reason: 'offline' }])).toBe('Not searched: Acme laptop (offline)');
  });

  it('the palette: `?` alone asks for text; `?text` lists the best results, then All results', () => {
    expect(paletteSearchText('invoice')).toBeNull();
    expect(paletteSearchText('?  invoice ')).toBe('invoice');
    expect(paletteSearchEntries('', null).map((e) => e.label)).toEqual(['Search everything…']);
    expect(paletteSearchEntries('invoice', null).map((e) => e.label)).toEqual([allResultsLabel('invoice')]);
    const rows = paletteSearchEntries('invoice', {
      groups: [
        { scope: 'conversations', count: 1, results: [result('e:7')], nextCursor: null },
        { scope: 'artifacts', count: 1, results: [result('artifact:a', { scope: 'artifacts', kind: 'artifact', title: [{ text: 'Invoice plan' }], target: { type: 'artifact', sessionId: 's1', artifactId: 'a' } })], nextCursor: null },
      ],
    });
    expect(rows.map((e) => [e.label, e.hint])).toEqual([
      ['the invoice', 'Agent · Acme billing'],
      ['Invoice plan', 'Artifact'],
      ['All results for “invoice”', '⌘⇧F'],
    ]);
    expect(rows[0]?.target).toEqual({ type: 'search-result', route: { view: 'session', id: 's1', tab: 'chat', eventId: 7 } });
    expect(rows[2]?.target).toEqual({ type: 'search-page', q: 'invoice' });
  });
});

describe('D97 · addresses of a search result', () => {
  const ROUTER = '../../src/web/router.tsx';
  type RouteLike = { readonly view: string; readonly id?: string; readonly tab?: string; readonly agentId?: string; readonly eventId?: number };
  let parseRoute: (pathname: string) => RouteLike;
  let routePath: (route: RouteLike) => string;
  beforeAll(async () => {
    ({ parseRoute, routePath } = (await import(/* @vite-ignore */ ROUTER)) as { parseRoute: typeof parseRoute; routePath: typeof routePath });
  });

  it('the chat at an event, a subagent\'s chat at an event, the Search page', () => {
    expect(parseRoute('/sessions/s1/events/42')).toEqual({ view: 'session', id: 's1', tab: 'chat', eventId: 42 });
    expect(parseRoute('/sessions/s1/agents/a1/events/42')).toEqual({ view: 'session', id: 's1', tab: 'chat', agentId: 'a1', eventId: 42 });
    expect(parseRoute('/sessions/s1/events/x')).toEqual({ view: 'session', id: 's1', tab: 'chat' });
    expect(parseRoute('/search')).toEqual({ view: 'search' });
    expect(routePath({ view: 'session', id: 'r~m~s1', tab: 'chat', eventId: 42 })).toBe('/sessions/r~m~s1/events/42');
    expect(routePath({ view: 'session', id: 's1', tab: 'chat', agentId: 'a1', eventId: 42 })).toBe('/sessions/s1/agents/a1/events/42');
    expect(routePath({ view: 'session', id: 's1', tab: 'chat', agentId: 'a1' })).toBe('/sessions/s1/agents/a1');
  });
});
