import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import type { SessionStatus } from '../../../src/core/model.ts';
import { peerAnswerKind, peerTodo } from '../../../src/core/peer-wire.ts';
import {
  CAPTURE_TITLE_CLIP,
  ENRICH_NOTE_CLIP,
  captureTargets,
  captureTitle,
  isTodoCaptureSource,
  paletteTodoText,
  quoteNote,
  sharedCapture,
  todoEnrichMessage,
} from '../../../src/core/todo-capture.ts';
import { TODO_DESCRIPTION_MAX } from '../../../src/core/todos.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { openDatabase } from '../../../src/server/db/database.ts';
import { loadMigrations, migrate } from '../../../src/server/db/migrate.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { isLocalOnly } from '../../../src/server/devices/local-only.ts';
import { SHARE_TARGET, manifestWithShareTarget, sharePagePath } from '../../../src/server/devices/share-target.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { agentTokenFor } from '../../../src/server/todos/agent-token.ts';
import { TodoEnricher } from '../../../src/server/todos/enricher.ts';
import { TodoError, TodoService } from '../../../src/server/todos/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import { type DeviceWorld, startDeviceWorld } from '../../helpers/devices.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D81 oracle (`docs/todos.md` → *Quick capture (D81)*): migration 0035, the capture rules
 * (titles, quoted notes, `todo <text>`, shares, the one "fill it in" message), the capture
 * route (bare item, marked per the setting), the agent's todo_update clearing the mark, the
 * enricher (one batched ask when the agent is idle, once per item; not while it runs, not for
 * a hooked session without a waiter, a closed session or with the setting off), the allow-lists
 * and the device origin's share target.
 */

let tmp: string;
let store: Store;
let clock: number;

beforeEach(async () => {
  tmp = await makeTempDir('todos-capture');
  clock = Date.parse('2026-10-08T10:00:00.000Z');
  store = await openTempStore(tmp, { now: () => new Date(clock) });
});

afterEach(async () => {
  await store.close();
  await removeTempDir(tmp);
});

async function session(name: string, extra: { hooked?: boolean; status?: SessionStatus } = {}): Promise<string> {
  return (await store.sessions.create({ name, claudeSessionId: randomUUID(), ...extra })).id;
}

describe('migration 0035 (D81)', () => {
  it('adds needs_enrichment (0 for every existing row), captured_from and enrich_asked_at; the checks hold', async () => {
    const shipped = await loadMigrations();
    expect(shipped.find((m) => m.version === 35)).toMatchObject({ name: 'todo_capture' });
    const db = await openDatabase(':memory:');
    // Up to 0034 (0032 rebuilt session_todos before it: 0035 only adds columns, so it composes with that rebuild).
    migrate(db, shipped.filter((m) => m.version <= 34));
    const ts = '2026-10-08T09:00:00.000Z';
    db.prepare('INSERT INTO sessions (id, name, claude_session_id, cwd, root, root_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('s', 'old', 'c', '/tmp/x', '/tmp/x', 'repo', ts, ts);
    db.prepare('INSERT INTO session_todos (id, session_id, title, plan, state, added_by, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('a', 's', 'Old one', 'No plan', 'open', 'agent', 0, ts, ts);
    expect(migrate(db, shipped.filter((m) => m.version <= 35)).applied).toEqual([35]);
    const columns = db.prepare('PRAGMA table_info(session_todos)').all().map((row) => String(row['name']));
    expect(columns.slice(-3)).toEqual(['needs_enrichment', 'captured_from', 'enrich_asked_at']);
    // The final table has 0031's, 0032's (rebuild: review, run, actuals) and 0035's columns.
    expect(columns).toEqual(expect.arrayContaining(['started_at', 'started_by', 'reminded_at', 'run_session_id', 'run_state', 'started_first_at', 'span_started_at', 'actual_ms', 'actual_tokens']));
    expect(migrate(db, shipped).applied.every((version) => version > 35)).toBe(true);
    expect({ ...db.prepare(`SELECT needs_enrichment, captured_from, enrich_asked_at FROM session_todos WHERE id = 'a'`).get() }).toEqual({ needs_enrichment: 0, captured_from: null, enrich_asked_at: null });
    db.prepare(`UPDATE session_todos SET needs_enrichment = 1, captured_from = 'share' WHERE id = 'a'`).run();
    expect(() => db.prepare(`UPDATE session_todos SET needs_enrichment = 2 WHERE id = 'a'`).run()).toThrow(/CHECK/);
    expect(() => db.prepare(`UPDATE session_todos SET captured_from = 'email' WHERE id = 'a'`).run()).toThrow(/CHECK/);
    db.close();
  });
});

describe('the capture rules (D81)', () => {
  it('a generated title is the first non-empty line, spaces collapsed, clipped at a word with …', () => {
    expect(captureTitle('\n\n  Fix   the login\n test flake  ')).toBe('Fix the login');
    const long = 'The migration runner should refuse an unordered version and say which file is wrong in the message';
    const title = captureTitle(long);
    expect(title.length).toBeLessThanOrEqual(CAPTURE_TITLE_CLIP);
    expect(title.endsWith('…')).toBe(true);
    expect(long.startsWith(title.slice(0, -1))).toBe(true);
    expect(captureTitle('x'.repeat(200)).length).toBe(CAPTURE_TITLE_CLIP);
    expect(captureTitle('   ')).toBe('');
  });

  it('a selection is quoted as Markdown, blank lines kept, cut to a description', () => {
    expect(quoteNote('one\n\ntwo\r\nthree')).toBe('> one\n>\n> two\n> three');
    expect(quoteNote('y'.repeat(5000)).length).toBe(TODO_DESCRIPTION_MAX);
  });

  it('`todo <text>` in the palette (any case, a space after the word); anything else is not a command', () => {
    expect(paletteTodoText('todo Fix the flake')).toBe('Fix the flake');
    expect(paletteTodoText('  TODO   spaced  ')).toBe('spaced');
    expect(paletteTodoText('todo ')).toBe('');
    expect(paletteTodoText('todo')).toBeNull();
    expect(paletteTodoText('todos')).toBeNull();
    expect(paletteTodoText('a todo x')).toBeNull();
  });

  it('a share becomes a title (its title, else the text, else the link) and a note (the text and the link)', () => {
    expect(sharedCapture({ title: 'Article', text: 'Read this', url: 'https://example.com/a' })).toEqual({ title: 'Article', note: 'Read this\n\nhttps://example.com/a' });
    expect(sharedCapture({ text: 'Look at https://example.com/a now', url: 'https://example.com/a' })).toEqual({ title: 'Look at https://example.com/a now', note: null });
    expect(sharedCapture({ url: 'https://example.com/a' })).toEqual({ title: 'https://example.com/a', note: null });
    expect(sharedCapture({ text: 'First line\nsecond line' })).toEqual({ title: 'First line', note: 'First line\nsecond line' });
    expect(sharedCapture({})).toEqual({ title: '', note: null });
  });

  it('the one message: the ruling text for one item; several pending captures in one message', () => {
    expect(todoEnrichMessage([{ id: 'a1b2c3d4e5f6', title: 'Fix the flake', description: null }])).toBe(
      "The developer added todo [a1b2c3d4e5f6] 'Fix the flake'. Fill in its description, handover plan, priority and estimate with todo_update — don't start it.",
    );
    expect(todoEnrichMessage([{ id: 'a1b2c3d4e5f6', title: 'Fix the flake', description: '> It fails\n> on CI' }])).toBe(
      "The developer added todo [a1b2c3d4e5f6] 'Fix the flake' (It fails on CI). Fill in its description, handover plan, priority and estimate with todo_update — don't start it.",
    );
    const many = todoEnrichMessage([
      { id: 'aaaaaaaaaaaa', title: 'One', description: null },
      { id: 'bbbbbbbbbbbb', title: 'Two', description: 'z'.repeat(500) },
    ]);
    expect(many).toBe(
      `The developer added todos [aaaaaaaaaaaa] 'One', [bbbbbbbbbbbb] 'Two' (${'z'.repeat(ENRICH_NOTE_CLIP - 1)}…). Fill in their description, handover plan, priority and estimate with todo_update — don't start them.`,
    );
  });

  it('capture targets: open sessions, most recently active first', () => {
    const s = (id: string, lastActivityAt: string | null, closedAt: string | null = null) => ({ id, lastActivityAt, createdAt: '2026-10-01T00:00:00.000Z', closedAt }) as unknown as Session;
    expect(captureTargets([s('old', '2026-10-02T00:00:00.000Z'), s('new', '2026-10-08T00:00:00.000Z'), s('closed', '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z'), s('never', null)]).map((x) => x.id)).toEqual(['new', 'old', 'never']);
    expect(['palette', 'selection', 'share'].every(isTodoCaptureSource)).toBe(true);
    expect(isTodoCaptureSource('email')).toBe(false);
  });
});

describe('TodoService.capture (D81)', () => {
  it('saves the title and note bare (No plan, medium, no estimate), by the developer, marked per the setting', async () => {
    const todos = new TodoService({ store, bus: new HubBus(), now: () => clock });
    const id = await session('cap');
    const { todo } = await todos.capture(id, { title: '  Look at the flake ', note: '> it fails', from: 'selection' }, true);
    expect(todo).toMatchObject({ title: 'Look at the flake', description: '> it fails', plan: 'No plan', priority: 'medium', estimateMinutes: null, addedBy: 'developer', state: 'open', needsEnrichment: true, capturedFrom: 'selection' });
    const bare = (await todos.capture(id, { title: 'Stays bare', from: 'palette' }, false)).todo;
    expect(bare).toMatchObject({ needsEnrichment: false, capturedFrom: 'palette', description: null });
    // An item added the normal way is no capture.
    expect((await todos.add(id, { title: 'Normal' }, 'developer')).todo).toMatchObject({ needsEnrichment: false, capturedFrom: null });
    await expect(todos.capture(id, { title: 'x', from: 'email' }, true)).rejects.toMatchObject({ status: 422 });
    await expect(todos.capture(id, { title: '', from: 'palette' }, true)).rejects.toBeInstanceOf(TodoError);
    await expect(todos.capture('nope', { title: 'x', from: 'palette' }, true)).rejects.toMatchObject({ status: 404 });
  });

  it("the agent's todo_update fills it in (the mark goes); the developer's title edit keeps it, their plan edit clears it; only open items show it", async () => {
    const todos = new TodoService({ store, bus: new HubBus(), now: () => clock });
    const id = await session('fill');
    const a = (await todos.capture(id, { title: 'A', from: 'palette' }, true)).todo;
    const b = (await todos.capture(id, { title: 'B', from: 'palette' }, true)).todo;
    const c = (await todos.capture(id, { title: 'C', from: 'palette' }, true)).todo;
    // Marking in progress is no fill.
    await todos.update(id, a.id, { state: 'in_progress' }, 'agent');
    expect((await store.todos.get(a.id))?.needsEnrichment).toBe(true);
    expect((await todos.get(id, a.id)).needsEnrichment).toBe(false);
    await todos.update(id, a.id, { state: 'open' });
    expect((await todos.get(id, a.id)).needsEnrichment).toBe(true);
    await todos.update(id, a.id, { description: 'Why', plan: '1. Do it', priority: 'high', estimateMinutes: 30 }, 'agent');
    expect((await todos.get(id, a.id)).needsEnrichment).toBe(false);
    await todos.update(id, b.id, { title: 'B renamed' });
    expect((await todos.get(id, b.id)).needsEnrichment).toBe(true);
    await todos.update(id, c.id, { plan: 'Mine' });
    expect((await todos.get(id, c.id)).needsEnrichment).toBe(false);
    expect((await todos.pendingEnrichment(id)).map((t) => t.id)).toEqual([b.id]);
  });
});

describe('the enricher (D81)', () => {
  function update(bus: HubBus, id: string, status: Session['status'], closedAt: string | null = null): void {
    bus.publish('sessionUpdated', { id, status, closedAt } as unknown as Session);
  }

  async function world(options: { enabled?: () => boolean; deliver?: (sessionId: string, text: string) => Promise<boolean> } = {}) {
    const bus = new HubBus();
    const todos = new TodoService({ store, bus, now: () => clock });
    const delivered: Array<[string, string]> = [];
    const enricher = new TodoEnricher({
      bus,
      store,
      todos,
      enabled: async () => options.enabled?.() ?? true,
      deliver:
        options.deliver ??
        (async (sessionId, text) => {
          delivered.push([sessionId, text]);
          return true;
        }),
    });
    enricher.start();
    return { bus, todos, enricher, delivered };
  }

  it('an idle agent is asked at once; captures while it runs wait for its next idle and go in one message; each item is asked once', async () => {
    const { bus, todos, enricher, delivered } = await world();
    const id = await session('idle');
    const a = (await todos.capture(id, { title: 'A', note: 'why', from: 'palette' }, true)).todo;
    await enricher.idle();
    expect(delivered).toEqual([[id, todoEnrichMessage([{ id: a.id, title: 'A', description: 'why' }])]]);
    expect((await store.todos.get(a.id))?.enrichAskedAt).toBe('2026-10-08T10:00:00.000Z');
    // It runs: two captures wait.
    await store.sessions.update(id, { status: 'run' });
    update(bus, id, 'run');
    const b = (await todos.capture(id, { title: 'B', from: 'selection' }, true)).todo;
    const c = (await todos.capture(id, { title: 'C', from: 'share' }, true)).todo;
    // Waiting on the developer is not idle either.
    await store.sessions.update(id, { status: 'need' });
    update(bus, id, 'need');
    await enricher.idle();
    expect(delivered).toHaveLength(1);
    await store.sessions.update(id, { status: 'idle' });
    update(bus, id, 'idle');
    update(bus, id, 'idle');
    await enricher.idle();
    expect(delivered.map(([, text]) => text)).toEqual([
      todoEnrichMessage([{ id: a.id, title: 'A', description: 'why' }]),
      todoEnrichMessage([
        { id: b.id, title: 'B', description: null },
        { id: c.id, title: 'C', description: null },
      ]),
    ]);
    // Later idles: nothing more (A is still unfilled, but it was asked).
    update(bus, id, 'done');
    await enricher.idle();
    expect(delivered).toHaveLength(2);
    await enricher.stop();
  });

  it('none with the setting off, for a bare capture, a closed, paused or detached session, or a paired machine’s session', async () => {
    let on = false;
    const { bus, todos, enricher, delivered } = await world({ enabled: () => on });
    const id = await session('off');
    await todos.capture(id, { title: 'Off', from: 'palette' }, true);
    await enricher.idle();
    expect(delivered).toEqual([]);
    // Turned on: the next idle asks.
    on = true;
    update(bus, id, 'idle');
    await enricher.idle();
    expect(delivered).toHaveLength(1);
    // A bare capture (the setting was off when it came) is never asked.
    await todos.capture(id, { title: 'Bare', from: 'palette' }, false);
    await enricher.idle();
    expect(delivered).toHaveLength(1);
    const paused = await session('paused', { status: 'paused' });
    await todos.capture(paused, { title: 'P', from: 'palette' }, true);
    const closed = await session('closed');
    await store.sessions.update(closed, { closedAt: '2026-10-08T09:00:00.000Z' });
    await todos.capture(closed, { title: 'X', from: 'palette' }, true);
    update(bus, closed, 'idle', '2026-10-08T09:00:00.000Z');
    const detached = await session('detached');
    await store.sessions.update(detached, { detachedAt: '2026-10-08T09:00:00.000Z' });
    await todos.capture(detached, { title: 'D', from: 'palette' }, true);
    update(bus, `r~abcdefghijkl~${id}`, 'idle');
    await enricher.idle();
    expect(delivered).toHaveLength(1);
    await enricher.stop();
  });

  it('a hooked session without a waiter is not asked (not recorded); it is asked once its waiter is held', async () => {
    let waiter = false;
    const delivered: string[] = [];
    const { bus, todos, enricher } = await world({
      deliver: async (_sessionId, text) => {
        if (!waiter) return false;
        delivered.push(text);
        return true;
      },
    });
    const id = await session('hooked', { hooked: true });
    const a = (await todos.capture(id, { title: 'A', from: 'palette' }, true)).todo;
    await enricher.idle();
    expect(delivered).toEqual([]);
    expect((await store.todos.get(a.id))?.enrichAskedAt).toBeNull();
    waiter = true;
    update(bus, id, 'idle');
    await enricher.idle();
    expect(delivered).toEqual([todoEnrichMessage([{ id: a.id, title: 'A', description: null }])]);
    await enricher.stop();
  });
});

describe('the routes (D81)', () => {
  const PORT = 4931; // inject() opens no socket; the port feeds the Host check only
  const HOST = `127.0.0.1:${PORT}`;
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    token = generateToken();
    const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
    app = await buildApp({ config, token, store, webRoot: tmp, bus: new HubBus(), agentTools: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  function ui(method: InjectOptions['method'], url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  }

  it('POST …/todos/capture: 201 with the list, the item bare and marked; off in Settings it stays bare; 422 / 404', async () => {
    const id = await session('route', { status: 'run' });
    const answer = await ui('POST', `/api/sessions/${id}/todos/capture`, { title: 'From the palette', from: 'palette' });
    expect(answer.statusCode).toBe(201);
    expect(answer.json().todos).toEqual([expect.objectContaining({ title: 'From the palette', plan: 'No plan', priority: 'medium', estimateMinutes: null, needsEnrichment: true, capturedFrom: 'palette' })]);
    expect((await ui('PUT', '/api/settings', { 'sessions.todoEnrich': false })).statusCode).toBe(200);
    const off = await ui('POST', `/api/sessions/${id}/todos/capture`, { title: 'Bare', note: 'n', from: 'share' });
    expect(off.json().todos[1]).toMatchObject({ title: 'Bare', description: 'n', needsEnrichment: false, capturedFrom: 'share' });
    expect((await ui('POST', `/api/sessions/${id}/todos/capture`, { title: 'x', from: 'mail' })).statusCode).toBe(422);
    expect((await ui('POST', '/api/sessions/nope/todos/capture', { title: 'x', from: 'palette' })).statusCode).toBe(404);
    // The agent's todo_update clears the mark.
    const item = answer.json().todos[0];
    const agent = await app.inject({
      method: 'PUT',
      url: `/agent/v1/todos/${item.id}`,
      headers: { host: HOST, 'x-switchboard-session': id, authorization: `Bearer ${agentTokenFor(token, id)}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ description: 'Filled', plan: 'No plan: trivial', priority: 'low', estimateMinutes: 5 }),
    });
    expect(agent.statusCode).toBe(200);
    expect(agent.json().todo).toMatchObject({ needsEnrichment: false, description: 'Filled', priority: 'low' });
  });

  it('the allow-lists: a device and a peer may capture; the answer maps as a todo list; a peer item keeps the mark', () => {
    expect(isLocalOnly('POST', '/api/sessions/s1/todos/capture')).toBe(false);
    expect(isLocalOnly('POST', '/api/machines/m1/api/sessions/s1/todos/capture')).toBe(false);
    expect(peerApiAllowed('POST', '/api/sessions/s1/todos/capture')).toBe(true);
    expect(peerAnswerKind('POST', '/api/sessions/s1/todos/capture')).toBe('todo-list');
    const remote = peerTodo({ id: 'abcdefghijkl', name: 'other', state: 'online' } as never, { id: 't', sessionId: 's', title: 'T', needsEnrichment: true, capturedFrom: 'share' } as never);
    expect(remote).toMatchObject({ sessionId: 'r~abcdefghijkl~s', needsEnrichment: true, capturedFrom: 'share' });
  });

  it('the share target is the device origin’s only: the UI listener’s manifest has none and POST /share-target is 404 there', async () => {
    const { writeFile } = await import('node:fs/promises');
    const path = await import('node:path');
    await writeFile(path.join(tmp, 'manifest.webmanifest'), '{"name":"Switchboard"}');
    const manifest = await ui('GET', '/manifest.webmanifest');
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json().share_target).toBeUndefined();
    const share = await app.inject({ method: 'POST', url: '/share-target', headers: { host: HOST, cookie: `sb_token=${token}`, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'title=x' });
    expect(share.statusCode).toBe(404);
  });
});

describe('the share target (D81)', () => {
  let world: DeviceWorld | null = null;
  afterEach(async () => {
    await world?.close();
    world = null;
  });

  /** A urlencoded POST on the device listener (what the share sheet sends without the service worker). */
  function sharePost(w: DeviceWorld, body: string, cookie?: string): Promise<{ status: number; location: string | undefined }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: w.devicePort,
          method: 'POST',
          path: '/share-target',
          agent: false,
          headers: { host: `localhost:${w.devicePort}`, 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body)), ...(cookie ? { cookie } : {}) },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location }));
        },
      );
      req.once('error', reject);
      req.end(body);
    });
  }

  it('the rules: the manifest member, and the page address (strings only, cut, empty ones left out)', () => {
    expect(JSON.parse(manifestWithShareTarget('{"name":"S"}'))).toEqual({ name: 'S', share_target: SHARE_TARGET });
    expect(manifestWithShareTarget('not json')).toBe('not json');
    expect(sharePagePath({ title: 'T', text: '', url: 'https://x.dev/a?b=1' })).toBe('/share?title=T&url=https%3A%2F%2Fx.dev%2Fa%3Fb%3D1');
    expect(sharePagePath({ title: 3 })).toBe('/share');
    expect(sharePagePath({ text: 'x'.repeat(5000) }).length).toBe('/share?text='.length + 4000);
  });

  it('on the device origin: the manifest carries the share target; a paired device’s share goes to /share?…; an unpaired one is refused', async () => {
    world = await startDeviceWorld();
    const w = world;
    await w.enableAccess();
    const manifest = await w.device('GET', '/manifest.webmanifest');
    expect(manifest.status).toBe(200);
    expect(manifest.body.share_target).toEqual(SHARE_TARGET);
    const { cookie } = await w.pair('Phone');
    const shared = await sharePost(w, new URLSearchParams({ title: 'Article', text: 'Read this', url: 'https://example.com/a' }).toString(), cookie);
    expect(shared).toEqual({ status: 303, location: '/share?title=Article&text=Read+this&url=https%3A%2F%2Fexample.com%2Fa' });
    expect((await sharePost(w, 'title=x')).status).toBe(401);
    // The page itself is the app's (a device's page load), and the capture route is the device's to call.
    expect((await w.device('GET', '/share?title=x', { cookie, headers: { accept: 'text/html' } })).status).toBe(200);
    const sessionId = await (async () => (await w.store.sessions.create({ name: 'phone-target', claudeSessionId: randomUUID(), status: 'run' })).id)();
    const captured = await w.device('POST', `/api/sessions/${sessionId}/todos/capture`, { cookie, headers: { origin: w.origin }, body: { title: 'Article', note: 'Read this', from: 'share' } });
    expect(captured.status).toBe(201);
    expect(captured.body.todos[0]).toMatchObject({ title: 'Article', capturedFrom: 'share', needsEnrichment: true });
  });
});
