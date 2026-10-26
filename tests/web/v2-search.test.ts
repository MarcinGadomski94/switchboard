import { describe, expect, it } from 'vitest';
import type { SearchGroup, SearchResult, SearchScope } from '../../src/core/search.ts';
import {
  andList,
  apiParams,
  clientFiltered,
  dateFloor,
  folderOptions,
  folderSessions,
  groupAnswer,
  hitHref,
  parseV2SearchAddress,
  passes,
  peekSessionOf,
  searchNote,
  sessionOf,
  v2SearchPath,
  whoOf,
} from '../../src/web/v2/search/search-model.ts';

/** D131 · lane R · the v2 Search page's pure model. */

const NOW = Date.parse('2026-10-25T12:00:00.000Z');

function hit(partial: Partial<SearchResult> & Pick<SearchResult, 'id' | 'scope' | 'target'>): SearchResult {
  return { kind: 'message', title: [{ text: 'Acme agent' }], snippet: [{ text: 'tests ' }, { text: 'green', match: true }], sessionTitle: 'Acme agent', detail: 'You', ts: new Date(NOW - 60_000).toISOString(), score: 0, ...partial };
}

function group(scope: SearchScope, results: SearchResult[], count = results.length): SearchGroup {
  return { scope, count, results, nextCursor: null };
}

const ANY = { q: 'green', type: 'all', computer: 'all', folder: 'all', date: 'any' } as const;
const CTX = { folderSessions: null, now: NOW };

const message = hit({ id: 'e:5', scope: 'conversations', target: { type: 'event', sessionId: 's1', eventId: 5, agentId: null } });
const remoteMessage = hit({ id: 'r~m2~e:9', scope: 'conversations', target: { type: 'event', sessionId: 'r~m2~s9', eventId: 9, agentId: null }, machine: { id: 'm2', name: 'Studio-PC', state: 'online' }, ts: new Date(NOW - 3 * 86_400_000).toISOString() });
const artifact = hit({ id: 'artifact:a1', scope: 'artifacts', kind: 'artifact', target: { type: 'artifact', sessionId: 's1', artifactId: 'a1' } });
const todo = hit({ id: 'todo:t1', scope: 'todos', kind: 'todo', target: { type: 'todo', sessionId: 's2', todoId: 't1' } });
const history = hit({ id: 'history:c1', scope: 'history', kind: 'history', target: { type: 'history', claudeSessionId: 'c1' }, ts: new Date(NOW - 20 * 86_400_000).toISOString() });

describe('the address', () => {
  it('round-trips every filter and leaves defaults out', () => {
    const filters = { q: 'tests green', type: 'messages', computer: 'm2', folder: 'f1', date: 'week' } as const;
    expect(v2SearchPath(filters)).toBe('/search?q=tests+green&type=messages&computer=m2&folder=f1&date=week');
    expect(parseV2SearchAddress('?q=tests+green&type=messages&computer=m2&folder=f1&date=week')).toEqual(filters);
    expect(v2SearchPath({ ...ANY, q: '  ' })).toBe('/search');
    expect(parseV2SearchAddress('?type=nope&date=yesterday')).toEqual({ q: '', type: 'all', computer: 'all', folder: 'all', date: 'any' });
  });
  it('asks the API for one scope only when a type is chosen', () => {
    expect(apiParams(ANY)).toEqual({ q: 'green' });
    expect(apiParams({ ...ANY, type: 'closed' })).toEqual({ q: 'green', scope: 'history' });
    expect(apiParams({ ...ANY, type: 'results' })).toEqual({ q: 'green', scope: 'artifacts' });
  });
});

describe('grouping', () => {
  const answer = { groups: [group('history', [history]), group('conversations', [message, remoteMessage], 14), group('artifacts', [artifact]), group('todos', [])] };
  it('orders Messages · Results · Tasks · Archived agents and skips empty groups for Everything', () => {
    const groups = groupAnswer(answer, ANY, CTX);
    expect(groups.map((g) => g.label)).toEqual(['Messages', 'Results', 'Archived agents']);
    expect(groups[0]?.count).toBe(14);
    expect(groups[0]?.more).toBe(true);
    expect(groups.map((g) => g.icon)).toEqual(['chat', 'results', 'clock']);
  });
  it('keeps the chosen type even when empty', () => {
    expect(groupAnswer(answer, { ...ANY, type: 'tasks' }, CTX).map((g) => [g.type, g.count])).toEqual([['tasks', 0]]);
  });
  it('filters by computer, folder and date on the client, counting the rows shown', () => {
    expect(clientFiltered(ANY)).toBe(false);
    const local = groupAnswer(answer, { ...ANY, computer: 'local' }, CTX);
    expect(local[0]?.results.map((r) => r.id)).toEqual(['e:5']);
    expect(local[0]?.count).toBe(1);
    expect(local[0]?.more).toBe(false);
    expect(groupAnswer(answer, { ...ANY, computer: 'm2' }, CTX).map((g) => g.results.map((r) => r.id))).toEqual([['r~m2~e:9']]);
    const today = groupAnswer(answer, { ...ANY, date: 'today' }, CTX);
    expect(today.flatMap((g) => g.results.map((r) => r.id))).toEqual(['e:5', 'artifact:a1']);
    const week = groupAnswer(answer, { ...ANY, date: 'week' }, CTX);
    expect(week.flatMap((g) => g.results.map((r) => r.id))).toEqual(['e:5', 'r~m2~e:9', 'artifact:a1']);
    const folder = groupAnswer(answer, { ...ANY, folder: 'f1' }, { folderSessions: new Set(['r~m2~s9']), now: NOW });
    expect(folder.flatMap((g) => g.results.map((r) => r.id))).toEqual(['r~m2~e:9']);
  });
  it('passes: a History row has no session, so a folder filter drops it', () => {
    expect(sessionOf(history)).toBeNull();
    expect(passes(history, { ...ANY, folder: 'f1' }, { folderSessions: new Set(['s1']), now: NOW })).toBe(false);
    expect(passes(history, ANY, CTX)).toBe(true);
  });
  it('dateFloor: today and the last 7 days in this browser', () => {
    expect(dateFloor('any', NOW)).toBeNull();
    const today = dateFloor('today', NOW)!;
    expect(new Date(today).getHours()).toBe(0);
    expect(today - dateFloor('week', NOW)!).toBeGreaterThanOrEqual(6 * 86_400_000 - 3_600_000);
  });
});

describe('where a hit leads', () => {
  it('a message → the exact message (a helper’s: its own chat), remote ids kept', () => {
    expect(hitHref(message)).toBe('/agents/s1/events/5');
    expect(hitHref(remoteMessage)).toBe('/agents/r~m2~s9/events/9');
    expect(hitHref(hit({ id: 'e:6', scope: 'conversations', target: { type: 'event', sessionId: 's1', eventId: 6, agentId: 'h1' } }))).toBe('/agents/s1/helpers/h1/events/6');
  });
  it('a result → Results with it open; a task → Tasks; a closed agent → Agents › Closed; an agent title → the agent', () => {
    expect(hitHref(artifact)).toBe('/results?open=a1&agent=s1');
    expect(hitHref({ ...artifact, machine: { id: 'm2', name: 'Studio-PC', state: 'online' } })).toBe('/results?open=a1&agent=s1&computer=m2');
    expect(hitHref(todo)).toBe('/tasks');
    expect(hitHref(history)).toBe('/agents?show=closed');
    expect(hitHref(hit({ id: 'session:s1', scope: 'conversations', kind: 'session', target: { type: 'session', sessionId: 's1' } }))).toBe('/agents/s1');
  });
  it('an agent-title hit peeks at its agent (lane X); a message still jumps to the exact message; the rest go to their pages', () => {
    expect(peekSessionOf(hit({ id: 'session:s1', scope: 'conversations', kind: 'session', target: { type: 'session', sessionId: 's1' } }))).toBe('s1');
    expect(peekSessionOf(hit({ id: 'r~m2~session:s9', scope: 'conversations', kind: 'session', target: { type: 'session', sessionId: 'r~m2~s9' } }))).toBe('r~m2~s9');
    expect([message, artifact, todo, history].map(peekSessionOf)).toEqual([null, null, null, null]);
  });
  it('who wrote it', () => {
    expect(whoOf(message)).toBe('You');
    expect(whoOf({ ...message, detail: 'Agent' })).toBe('Agent');
  });
});

describe('the note', () => {
  it('names an offline or reconnecting computer that was not searched', () => {
    const one = searchNote([{ machine: { id: 'm2', name: 'Studio-PC', state: 'offline' }, reason: 'offline' }], ['Acme-MacBook'], 'any');
    expect(one).toEqual({ kind: 'missing', strong: 'Studio-PC not searched (offline)', text: 'its agents and results show up again when it’s back.' });
    const two = searchNote(
      [
        { machine: { id: 'm2', name: 'Studio-PC', state: 'offline' }, reason: 'offline' },
        { machine: { id: 'm3', name: 'Laptop', state: 'reconnecting' }, reason: 'reconnecting' },
      ],
      ['Acme-MacBook'],
      'any',
    );
    expect(two.strong).toBe('Studio-PC and Laptop not searched (offline and reconnecting)');
  });
  it('else says which computers it searched and when', () => {
    expect(searchNote([], ['Acme-MacBook', 'Studio-PC'], 'any')).toEqual({ kind: 'ok', strong: null, text: 'Searched Acme-MacBook and Studio-PC · any time' });
    expect(searchNote([], ['Acme-MacBook'], 'week').text).toBe('Searched Acme-MacBook · this week');
    expect(andList(['A', 'B', 'C'])).toBe('A, B and C');
  });
});

describe('folders', () => {
  const layout = {
    folders: [
      { id: 'f1', name: 'Checkout', collapsed: false, sessionIds: ['s1'], parentId: null },
      { id: 'f2', name: 'Mobile', collapsed: false, sessionIds: ['s2'], parentId: 'f1' },
      { id: 'f3', name: 'Docs', collapsed: false, sessionIds: ['s3'], parentId: null },
    ],
  };
  it('a folder includes its nested folders’ agents', () => {
    expect([...(folderSessions(layout, 'f1') ?? [])].sort()).toEqual(['s1', 's2']);
    expect(folderSessions(layout, 'all')).toBeNull();
    expect([...(folderSessions(null, 'f1') ?? [])]).toEqual([]);
  });
  it('options are nested and indented', () => {
    expect(folderOptions(layout).map((o) => o.label)).toEqual(['Any folder', 'Checkout', '— Mobile', 'Docs']);
  });
});
