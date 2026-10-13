import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { SearchAnswer } from '../../../src/core/search.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { generateToken } from '../../../src/server/token.ts';
import { SearchBackfill } from '../../../src/server/search/backfill.ts';
import { DEVICE_ALLOWED } from '../../../src/server/devices/local-only.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { type SupervisorWorld, makeSupervisorWorld } from '../../helpers/supervisor.ts';

/** D97 (`docs/search.md`, contract → *Search (D97)*): `GET /api/search` through the app. */

const PORT = 4901; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

let world: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';

async function setup(options: { readonly backfill?: (world: SupervisorWorld) => SearchBackfill } = {}): Promise<SupervisorWorld> {
  world = await makeSupervisorWorld({ scenario: 'handoff-start' });
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: world.root }, platform: 'linux', home: world.root, cwd: world.root });
  app = await buildApp({
    config: { ...base, port: PORT },
    token,
    store: world.store,
    webRoot: world.root,
    ...(options.backfill ? { searchBackfill: options.backfill(world) } : {}),
  });
  await app.ready();
  return world;
}

afterEach(async () => {
  await app?.close();
  await world?.cleanup();
  app = undefined;
  world = undefined;
});

function call(method: InjectOptions['method'], url: string) {
  if (!app) throw new Error('no app');
  return app.inject({ method, url, headers: { host: HOST, cookie: `sb_token=${token}` } });
}

describe('D97 · GET /api/search', () => {
  it('groups every scope, highlights the match, filters by scope and session; 422 for bad parameters', async () => {
    const w = await setup();
    const a = await w.store.sessions.create({ name: 'alpha', title: 'Acme billing', claudeSessionId: 'c-a', task: '' });
    const b = await w.store.sessions.create({ name: 'beta', claudeSessionId: 'c-b', task: '' });
    const message = await w.store.events.append({ sessionId: a.id, kind: 'text', payload: { type: 'assistant', text: 'The invoice parser now handles PROJ-123 dates.', messageId: null } });
    await w.store.events.append({ sessionId: b.id, kind: 'text', payload: { type: 'user', text: 'check the invoice totals', origin: 'user', delivered: true } });
    await w.store.todos.add(b.id, { title: 'Invoice export', description: null, plan: 'No plan: test', priority: 'low', estimateMinutes: null }, 'developer');

    const all = (await call('GET', '/api/search?q=invoice')).json() as SearchAnswer;
    expect(all.query).toBe('invoice');
    expect(all.groups.map((g) => [g.scope, g.count])).toEqual([['conversations', 2], ['artifacts', 0], ['todos', 1], ['history', 0]]);
    expect(all.notSearched).toEqual([]);
    const hit = all.groups[0]?.results.find((r) => r.id === `e:${message.id}`);
    expect(hit?.snippet).toEqual([{ text: 'The ' }, { text: 'invoice', match: true }, { text: ' parser now handles PROJ-123 dates.' }]);
    expect(hit?.target).toEqual({ type: 'event', sessionId: a.id, eventId: message.id, agentId: null });
    expect(hit?.sessionTitle).toBe('Acme billing');

    const todos = (await call('GET', '/api/search?q=invoice&scope=todos')).json() as SearchAnswer;
    expect(todos.groups.map((g) => g.scope)).toEqual(['todos']);
    const one = (await call('GET', `/api/search?q=invoice&session=${a.id}`)).json() as SearchAnswer;
    expect(one.groups.flatMap((g) => g.results.map((r) => r.id))).toEqual([`e:${message.id}`]);
    // Nothing to search: empty groups, not an error.
    expect(((await call('GET', '/api/search?q=%20%22')).json() as SearchAnswer).groups.every((g) => g.count === 0)).toBe(true);

    for (const bad of ['scope=everything', 'limit=0', 'limit=51', 'cursor=!!', 'cursor=eyJsIjoxfQ', 'session=']) {
      const answer = await call('GET', `/api/search?q=invoice&${bad}`);
      expect(answer.statusCode, bad).toBe(422);
      expect(answer.json()).toMatchObject({ error: 'invalid' });
    }
  });

  it('answers while the backfill has not finished (indexing, percent) and the route is part of the device and peer APIs', async () => {
    const w = await setup({ backfill: (sw) => new SearchBackfill(sw.store, { startDelayMs: 60_000 }) });
    const s = await w.store.sessions.create({ name: 'gamma', claudeSessionId: 'c-g', task: '' });
    // Written behind the index's back (as before 0042), so the backfill has work.
    w.store.db.prepare("INSERT INTO events (session_id, ts, kind, label, payload) VALUES (?, ?, 'text', '', ?)").run(s.id, new Date().toISOString(), JSON.stringify({ type: 'assistant', text: 'legacy zebra', messageId: null }));
    w.store.db.exec("DELETE FROM search_state");
    const answer = (await call('GET', '/api/search?q=zebra')).json() as SearchAnswer;
    expect(answer.indexing).toEqual({ done: false, percent: 0 });
    expect(answer.groups[0]?.count).toBe(0);
    expect(DEVICE_ALLOWED.some(([method, path]) => method === 'GET' && path.test('/api/search'))).toBe(true);
    expect(peerApiAllowed('GET', '/api/search?q=x&machine=local')).toBe(true);
  });
});
