import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/server/db/store.ts';
import { SearchBackfill } from '../../../src/server/search/backfill.ts';
import { SearchService, type SearchParams } from '../../../src/server/search/service.ts';
import type { SearchAnswer, SearchResult } from '../../../src/core/search.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/** D97 (`docs/search.md` → *The index*): incremental indexing, consistency on delete, ranking and snippets. */

let dir = '';
let store: Store;
let service: SearchService;

beforeEach(async () => {
  dir = await makeTempDir('search-index');
  store = await openTempStore(dir);
  service = new SearchService({ store });
});

afterEach(async () => {
  await store.close();
  await removeTempDir(dir);
});

const PARAMS: SearchParams = { q: '', scope: 'all', session: null, machine: 'local', limit: null, cursor: null, fromPeer: false };

async function search(q: string, more: Partial<SearchParams> = {}): Promise<SearchAnswer> {
  return service.search({ ...PARAMS, q, ...more });
}

async function ids(q: string, more: Partial<SearchParams> = {}): Promise<string[]> {
  return (await search(q, more)).groups.flatMap((group) => group.results.map((result) => result.id)).sort();
}

function text(result: SearchResult | undefined): string {
  return (result?.snippet ?? []).map((segment) => (segment.match ? `[${segment.text}]` : segment.text)).join('');
}

/** Rows of the FTS index (events: positive rowids, items: negative). */
function ftsRows(): number {
  return Number(store.db.prepare("SELECT COUNT(*) AS n FROM search_fts WHERE search_fts MATCH 'zebra OR giraffe OR okapi OR walrus OR narwhal'").get()?.['n'] ?? 0);
}

async function session(name: string, extra: { title?: string; task?: string } = {}) {
  return store.sessions.create({ name, claudeSessionId: `c-${name}`, task: extra.task ?? '', ...(extra.title ? { title: extra.title } : {}) });
}

describe('D97 · events are indexed on write', () => {
  it('a user message, agent text, a progress note, a subagent prompt and a tool call (input + result) are found; other events are not', async () => {
    const s = await session('alpha');
    const main = await store.agents.create({ sessionId: s.id, name: 'main', kind: 'main' });
    const sub = await store.agents.create({ sessionId: s.id, name: 'helper', toolUseId: 'toolu_1' });
    const user = await store.events.append({ sessionId: s.id, kind: 'text', payload: { type: 'user', text: 'please feed the zebra', origin: 'user', delivered: true } });
    const agent = await store.events.append({ sessionId: s.id, agentId: main.id, kind: 'text', payload: { type: 'assistant', text: 'The giraffe is tall.', messageId: 'm1' } });
    const note = await store.events.append({ sessionId: s.id, agentId: main.id, kind: 'text', payload: { type: 'assistant', text: 'Checking the okapi first.', messageId: 'm2', note: true } });
    const prompt = await store.events.append({ sessionId: s.id, agentId: sub.id, kind: 'text', payload: { type: 'agent-prompt', text: 'Find the walrus' } });
    const tool = await store.events.append({ sessionId: s.id, agentId: main.id, kind: 'impl', payload: { type: 'tool', name: 'Bash', toolUseId: 't1', input: { command: 'grep narwhal src' } } });
    await store.events.append({ sessionId: s.id, kind: 'text', payload: { type: 'lifecycle', action: 'started', text: 'zebra' } });
    expect(await ids('zebra')).toEqual([`e:${user.id}`]);
    expect(await ids('giraffe')).toEqual([`e:${agent.id}`]);
    expect(await ids('okapi')).toEqual([`e:${note.id}`]);
    expect(await ids('walrus')).toEqual([`e:${prompt.id}`]);
    expect(await ids('narwhal')).toEqual([`e:${tool.id}`]);
    const answer = await search('walrus');
    const hit = answer.groups[0]?.results[0];
    // A subagent's event opens its chat; a main event the main chat.
    expect(hit?.target).toEqual({ type: 'event', sessionId: s.id, eventId: prompt.id, agentId: sub.id });
    expect((await search('giraffe')).groups[0]?.results[0]?.target).toEqual({ type: 'event', sessionId: s.id, eventId: agent.id, agentId: null });
    expect((await search('okapi')).groups[0]?.results[0]?.kind).toBe('note');
    // The tool result arrives (an update): its text is found too.
    await store.events.update(tool.id, { payload: { type: 'tool', name: 'Bash', toolUseId: 't1', input: { command: 'grep narwhal src' }, result: 'src/a.ts: beluga' } });
    expect(await ids('beluga')).toEqual([`e:${tool.id}`]);
    // An update that leaves no text removes the entry.
    await store.events.update(user.id, { payload: { type: 'user', text: 'please feed the zebra', origin: 'user', delivered: true, withdrawn: true } });
    expect(await ids('zebra')).toEqual([]);
  });

  it('a tool input is cut to its first 2,000 characters and binary-looking text is left out', async () => {
    const s = await session('beta');
    const long = `${'word '.repeat(500)}tailmarker`;
    await store.events.append({ sessionId: s.id, kind: 'impl', payload: { type: 'tool', name: 'Write', toolUseId: 't2', input: { file_path: 'a.txt', content: long } } });
    await store.events.append({ sessionId: s.id, kind: 'impl', payload: { type: 'tool', name: 'Read', toolUseId: 't3', input: { file_path: 'logo.png' }, result: `${'A'.repeat(600)}base64tail` } });
    expect(await ids('tailmarker')).toEqual([]);
    expect(await ids('base64tail')).toEqual([]);
    expect((await ids('logo')).length).toBe(1);
  });
});

describe('D97 · the index stays consistent on delete', () => {
  it('deleting a session removes its events, its title, its todos; its artifacts stay without it', async () => {
    const s = await session('gamma', { title: 'Zebra crossing' });
    await store.events.append({ sessionId: s.id, kind: 'text', payload: { type: 'user', text: 'zebra stripes', origin: 'user', delivered: true } });
    await store.todos.add(s.id, { title: 'Count the giraffe', description: 'every okapi too', plan: 'No plan: test', priority: 'medium', estimateMinutes: null }, 'developer');
    await store.artifacts.create({ id: 'art1', sessionId: s.id, title: 'Walrus report', kind: 'markdown', language: null, version: { content: '# narwhal notes', file: null, mediaType: null, size: 15, createdBy: 'agent' } });
    expect((await search('zebra')).groups.map((g) => [g.scope, g.count])).toEqual([['sessions', 2], ['artifacts', 0], ['todos', 0], ['history', 0]]);
    const todo = (await store.todos.list(s.id))[0];
    expect(await ids('giraffe')).toEqual([`todo:${todo?.id}`]);
    const before = ftsRows();
    expect(before).toBe(4);
    await store.sessions.delete(s.id);
    expect(await ids('zebra')).toEqual([]);
    expect(await ids('giraffe')).toEqual([]);
    // The artifact keeps its row (D89: it outlives its session) and is still found, without a session.
    const art = (await search('walrus')).groups.find((g) => g.scope === 'artifacts')?.results[0];
    expect(art?.target).toEqual({ type: 'artifact', sessionId: null, artifactId: 'art1' });
    expect(ftsRows()).toBe(1);
    await store.artifacts.delete('art1');
    expect(ftsRows()).toBe(0);
    expect(Number(store.db.prepare('SELECT COUNT(*) AS n FROM search_items').get()?.['n'])).toBe(0);
  });

  it('todos: edits re-index, delete / clear done / the hourly clean-up remove them', async () => {
    const s = await session('delta');
    const fields = { description: null, plan: 'No plan: test', priority: 'medium' as const, estimateMinutes: null };
    const a = await store.todos.add(s.id, { ...fields, title: 'zebra one' }, 'developer');
    const b = await store.todos.add(s.id, { ...fields, title: 'zebra two' }, 'developer');
    const c = await store.todos.add(s.id, { ...fields, title: 'zebra three' }, 'developer');
    expect(await ids('zebra', { scope: 'todos' })).toEqual([`todo:${a.id}`, `todo:${b.id}`, `todo:${c.id}`].sort());
    await store.todos.setFields(a.id, { title: 'giraffe one' });
    expect(await ids('zebra', { scope: 'todos' })).toEqual([`todo:${b.id}`, `todo:${c.id}`].sort());
    expect(await ids('giraffe', { scope: 'todos' })).toEqual([`todo:${a.id}`]);
    await store.todos.delete(a.id);
    expect(await ids('giraffe', { scope: 'todos' })).toEqual([]);
    await store.todos.setState(b.id, 'done');
    await store.todos.clearDone(s.id);
    await store.todos.setState(c.id, 'done');
    await store.todos.removeDoneBefore(new Date(Date.now() + 60_000).toISOString());
    expect(await ids('zebra', { scope: 'todos' })).toEqual([]);
    expect(ftsRows()).toBe(0);
  });

  it('artifacts: a new version replaces the text (the latest version is indexed)', async () => {
    const s = await session('eps');
    await store.artifacts.create({ id: 'art2', sessionId: s.id, title: 'Plan', kind: 'markdown', language: null, version: { content: 'zebra first draft', file: null, mediaType: null, size: 17, createdBy: 'agent' } });
    await store.artifacts.addVersion('art2', { title: 'Plan v2', language: null, version: { content: 'giraffe second draft', file: null, mediaType: null, size: 20, createdBy: 'agent' } });
    expect(await ids('zebra', { scope: 'artifacts' })).toEqual([]);
    const hit = (await search('giraffe', { scope: 'artifacts' })).groups[0]?.results[0];
    expect(hit?.id).toBe('artifact:art2');
    expect(hit?.title.map((t) => t.text).join('')).toBe('Plan v2');
  });

  it('History: a terminal conversation is found until its row goes or it becomes a session here', async () => {
    const item = (sessionId: string | null) => ({ claudeSessionId: 'c-term', sessionId, startedAt: '2026-10-01T10:00:00.000Z', name: 'zebra-migration', mode: 'terminal', summary: 'Moved the okapi table', branches: [], solutions: [], outcome: 'ended', status: 'idle', folder: null, folderPath: null, terminal: true, firstPrompt: 'migrate the giraffe schema' });
    await store.historyCache.upsert({ transcriptPath: '/t/c-term.jsonl', claudeSessionId: 'c-term', size: 1, mtimeMs: 1, item: item(null) });
    expect(await ids('giraffe')).toEqual(['history:c-term']);
    const hit = (await search('okapi')).groups.find((g) => g.scope === 'history')?.results[0];
    expect(hit?.target).toEqual({ type: 'history', claudeSessionId: 'c-term' });
    // It became a session here (Continue in Switchboard): the History row no longer counts.
    await store.sessions.create({ name: 'continued', claudeSessionId: 'c-term', task: '' });
    expect(await ids('giraffe')).toEqual([]);
    await store.historyCache.upsert({ transcriptPath: '/t/c-term.jsonl', claudeSessionId: 'c-term', size: 2, mtimeMs: 2, item: item('sid') });
    expect(Number(store.db.prepare("SELECT COUNT(*) AS n FROM search_items WHERE kind = 'history'").get()?.['n'])).toBe(0);
    await store.historyCache.upsert({ transcriptPath: '/t/c-term.jsonl', claudeSessionId: 'c-term', size: 3, mtimeMs: 3, item: item(null) });
    await store.historyCache.delete('/t/c-term.jsonl');
    expect(Number(store.db.prepare("SELECT COUNT(*) AS n FROM search_items WHERE kind = 'history'").get()?.['n'])).toBe(0);
  });

  it('session titles: a rename re-indexes, a status change does not touch the index', async () => {
    const s = await session('zeta', { title: 'Zebra work' });
    expect(await ids('zebra', { scope: 'sessions' })).toEqual([`session:${s.id}`]);
    await store.sessions.update(s.id, { title: 'Giraffe work' });
    expect(await ids('zebra', { scope: 'sessions' })).toEqual([]);
    expect(await ids('giraffe', { scope: 'sessions' })).toEqual([`session:${s.id}`]);
    const itemId = store.db.prepare("SELECT id FROM search_items WHERE kind = 'session'").get()?.['id'];
    await store.sessions.update(s.id, { status: 'run' });
    expect(store.db.prepare("SELECT id FROM search_items WHERE kind = 'session'").get()?.['id']).toBe(itemId);
  });
});

describe('D97 · ranking and snippets', () => {
  it('a phrase matches the words in order; a title counts more; newer ranks higher among equals', async () => {
    const s = await session('eta');
    const old = await store.events.append({ sessionId: s.id, kind: 'text', ts: '2026-01-01T00:00:00.000Z', payload: { type: 'assistant', text: 'the queue drains before the worker starts', messageId: null } });
    const fresh = await store.events.append({ sessionId: s.id, kind: 'text', ts: new Date().toISOString(), payload: { type: 'assistant', text: 'the queue drains before the worker starts', messageId: null } });
    await store.events.append({ sessionId: s.id, kind: 'text', payload: { type: 'assistant', text: 'before the queue, the worker drains', messageId: null } });
    const answer = await search('"queue drains before"', { scope: 'sessions' });
    expect(answer.groups[0]?.results.map((r) => r.id)).toEqual([`e:${fresh.id}`, `e:${old.id}`]);
    expect(text(answer.groups[0]?.results[0])).toBe('the [queue drains before] the worker starts');
    const titled = await session('theta', { title: 'Drains' });
    const ranked = await search('drains', { scope: 'sessions' });
    expect(ranked.groups[0]?.results[0]?.id).toBe(`session:${titled.id}`);
    expect(ranked.groups[0]?.count).toBe(4);
  });

  it('pages a scope with a cursor; counts every match', async () => {
    const s = await session('iota');
    for (let i = 0; i < 7; i += 1) await store.events.append({ sessionId: s.id, kind: 'text', payload: { type: 'assistant', text: `zebra number ${i}`, messageId: null } });
    const first = await search('zebra', { scope: 'sessions', limit: 3 });
    expect(first.groups[0]?.count).toBe(7);
    expect(first.groups[0]?.results.length).toBe(3);
    const seen = new Set(first.groups[0]?.results.map((r) => r.id));
    let cursor = first.groups[0]?.nextCursor ?? null;
    const { decodeSearchCursor } = await import('../../../src/core/search.ts');
    while (cursor !== null) {
      const page = await search('zebra', { scope: 'sessions', limit: 3, cursor: decodeSearchCursor(cursor) });
      for (const r of page.groups[0]?.results ?? []) {
        expect(seen.has(r.id)).toBe(false);
        seen.add(r.id);
      }
      cursor = page.groups[0]?.nextCursor ?? null;
    }
    expect(seen.size).toBe(7);
  });

  it('only one session (session=); FTS syntax in the text is searched, never run', async () => {
    const a = await session('kappa');
    const b = await session('lambda');
    await store.events.append({ sessionId: a.id, kind: 'text', payload: { type: 'assistant', text: 'zebra NEAR giraffe', messageId: null } });
    await store.events.append({ sessionId: b.id, kind: 'text', payload: { type: 'assistant', text: 'zebra', messageId: null } });
    expect((await ids('zebra', { session: a.id })).length).toBe(1);
    // Operators and syntax are plain words or dropped: no error, no surprise.
    for (const q of ['zebra NEAR(giraffe)', 'title:zebra', '"zebra', 'zebra OR', '^zebra', '(zebra)', 'zebra -giraffe', '*', '""', 'NOT']) {
      const answer = await search(q);
      expect(answer.groups.length, q).toBe(4);
    }
    expect((await search('*')).query).toBe('');
    expect((await ids('NEAR'))).toEqual((await ids('near')));
  });
});

describe('D97 · backfill (docs/search.md → Backfill)', () => {
  it('indexes what was written before, in bounded steps, and resumes after a restart', async () => {
    const s = await session('mu');
    // Rows written behind the index's back (as before migration 0042): raw inserts.
    const insert = store.db.prepare("INSERT INTO events (session_id, ts, kind, label, payload) VALUES (?, ?, 'text', '', ?)");
    for (let i = 0; i < 25; i += 1) insert.run(s.id, new Date().toISOString(), JSON.stringify({ type: 'assistant', text: `zebra ${i}`, messageId: null }));
    store.db.exec("DELETE FROM search_items; DELETE FROM search_state");
    const steps: number[] = [];
    const first = new SearchBackfill(store, { batch: 10, stepBudgetMs: 0, onStep: (p) => steps.push(p.percent) });
    expect(first.progress()).toEqual({ done: false, percent: 0 });
    first.step();
    first.step();
    first.step();
    expect(first.progress().done).toBe(false);
    // A "restart": a new backfill over the same state continues after the last step.
    const second = new SearchBackfill(store, { batch: 10, stepBudgetMs: 0 });
    expect(second.runToEnd()).toEqual({ done: true, percent: 100 });
    expect((await search('zebra')).groups[0]?.count).toBe(25);
    expect(steps.every((p, i) => i === 0 || p >= (steps[i - 1] ?? 0))).toBe(true);
    // Complete: a third start has nothing to do.
    const third = new SearchBackfill(store, { batch: 10 });
    third.step();
    expect(third.progress()).toEqual({ done: true, percent: 100 });
  });
});
