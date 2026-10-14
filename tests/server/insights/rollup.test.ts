import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/server/db/store.ts';
import { InsightsBackfill } from '../../../src/server/insights/backfill.ts';
import { openDatabase } from '../../../src/server/db/database.ts';
import { loadMigrations, migrate } from '../../../src/server/db/migrate.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D108 (`docs/insights.md` → *Rollup and backfill*): the daily rollup is written as turns end,
 * the events from before 0045 are added by the background backfill (once, resumable), and a
 * completed todo records what Insights needs (split, model, priority, reopens).
 */

let dir = '';
let store: Store;
let clock = new Date('2026-10-13T09:00:00.000Z');

function tick(ms: number): string {
  clock = new Date(clock.getTime() + ms);
  return clock.toISOString();
}

beforeEach(async () => {
  dir = await makeTempDir('insights-rollup');
  clock = new Date('2026-10-13T09:00:00.000Z');
  store = await openTempStore(dir, { now: () => clock });
});

afterEach(async () => {
  await store.close();
  await removeTempDir(dir);
});

async function session(name: string, extra: Record<string, unknown> = {}) {
  return store.sessions.create({ name, claudeSessionId: `c-${name}`, root: '/work/acme', model: 'opus', ...extra } as Parameters<Store['sessions']['create']>[0]);
}

function result(tokens: number, extra: Record<string, unknown> = {}) {
  return { type: 'result', subtype: 'success', isError: false, text: 'done', terminalReason: null, errors: [], taskNotification: false, numTurns: 1, durationMs: 30_000, costUsd: null, tokens, ...extra };
}

function rows() {
  return store.db
    .prepare('SELECT day, session_id, provider, model, profile_id, folder, kind, turns, error_turns, tokens, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, unsplit_tokens, duration_ms, reverts, redos FROM insight_turns_daily ORDER BY day, model')
    .all()
    .map((row) => ({ ...row }));
}

describe('D108 · the rollup as turns end', () => {
  it('adds each result (split, reported model) and each D80 revert / Redo to its day; other events add nothing', async () => {
    const s = await session('acme');
    await store.events.append({ sessionId: s.id, kind: 'text', label: 'hi', payload: { type: 'user', text: 'hi' } });
    await store.events.append({ sessionId: s.id, kind: 'ok', label: 'Done', ts: '2026-10-13T09:01:00.000Z', payload: result(1_300, { usage: { input: 100, output: 200, cacheWrite: 1_000, cacheRead: 50_000 }, model: 'claude-opus-5-5' }) });
    await store.events.append({ sessionId: s.id, kind: 'error', label: 'err', ts: '2026-10-13T09:02:00.000Z', payload: result(700, { isError: true, usage: { input: 100, output: 100, cacheWrite: 500, cacheRead: 0 }, model: 'claude-opus-5-5' }) });
    // A result without a split or a reported model (an older CLI): unsplit, the session's chosen model.
    await store.events.append({ sessionId: s.id, kind: 'ok', label: 'Done', ts: '2026-10-14T00:30:00.000Z', payload: result(400) });
    await store.events.append({ sessionId: s.id, kind: 'text', label: 'Reverted', ts: '2026-10-14T01:00:00.000Z', payload: { type: 'lifecycle', action: 'reverted', turn: 1 } });
    await store.events.append({ sessionId: s.id, kind: 'text', label: 'Redo', ts: '2026-10-14T01:01:00.000Z', payload: { type: 'lifecycle', action: 'revert-undone', turn: 1 } });
    const base = { session_id: s.id, provider: 'claude', profile_id: 'default-claude', folder: '/work/acme', kind: 'session' };
    expect(rows()).toEqual([
      { ...base, day: '2026-10-13', model: 'claude-opus-5-5', turns: 2, error_turns: 1, tokens: 2_000, input_tokens: 200, output_tokens: 300, cache_write_tokens: 1_500, cache_read_tokens: 50_000, unsplit_tokens: 0, duration_ms: 60_000, reverts: 0, redos: 0 },
      { ...base, day: '2026-10-14', model: 'opus', turns: 1, error_turns: 0, tokens: 400, input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, unsplit_tokens: 400, duration_ms: 30_000, reverts: 1, redos: 1 },
    ]);
  });
});

describe('D108 · backfill', () => {
  it('rolls up the events written before 0045 once, in bounded steps, resuming after a restart', async () => {
    const s = await session('older', { kind: 'chat' });
    // Written behind the rollup's back (as before 0045): raw inserts, then the state 0045 would have set.
    const insert = store.db.prepare('INSERT INTO events (session_id, ts, kind, label, payload) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < 7; i += 1) {
      insert.run(s.id, `2026-10-1${i % 2}T10:00:00.000Z`, 'ok', 'Done', JSON.stringify(result(100)));
      insert.run(s.id, `2026-10-1${i % 2}T10:00:01.000Z`, 'text', 'answer', JSON.stringify({ type: 'assistant', text: 'a result is "result"' }));
    }
    insert.run(s.id, '2026-10-11T10:00:00.000Z', 'impl', 'Edit', JSON.stringify({ type: 'tool', name: 'Edit' }));
    const upto = Number(store.db.prepare('SELECT MAX(id) AS n FROM events').get()?.['n']);
    store.db.prepare("UPDATE insight_state SET value = ? WHERE key = 'events.upto'").run(String(upto));
    store.db.prepare("UPDATE insight_state SET value = '0' WHERE key = 'events.done'").run();
    // A new store reads the state afresh (as a restart after the migration would).
    await store.close();
    store = await openTempStore(dir, { now: () => clock });

    const first = new InsightsBackfill(store, { batch: 4, stepBudgetMs: 0 });
    expect(first.progress()).toEqual({ done: false, percent: 0 });
    first.step();
    first.step();
    expect(first.progress().done).toBe(false);
    // Restart: continues after the stored progress, never counting a batch twice.
    const second = new InsightsBackfill(store, { batch: 4, stepBudgetMs: 0 });
    expect(second.runToEnd()).toEqual({ done: true, percent: 100 });
    // 4 results on day 10 (i = 0, 2, 4, 6) and 3 on day 11; chats keep their kind.
    expect(rows().map((r) => [r['day'], r['kind'], r['turns'], r['tokens'], r['unsplit_tokens']])).toEqual([
      ['2026-10-10', 'chat', 4, 400, 400],
      ['2026-10-11', 'chat', 3, 300, 300],
    ]);
    // A new event is rolled up by its write; a third backfill has nothing left to do.
    await store.events.append({ sessionId: s.id, kind: 'ok', label: 'Done', ts: '2026-10-11T12:00:00.000Z', payload: result(50) });
    const third = new InsightsBackfill(store, { batch: 4 });
    expect(third.progress()).toEqual({ done: true, percent: 100 });
    third.runToEnd();
    expect(rows().map((r) => r['turns'])).toEqual([4, 4]);
  });
});

describe('D108 · what a completed todo records', () => {
  it('the split, the reported model, the priority; a reopen is counted; the row returns on completing again', async () => {
    const s = await session('acme');
    const item = await store.todos.add(s.id, { title: 'Write docs', description: null, plan: 'No plan', priority: 'low', estimateMinutes: 20 }, 'developer');
    tick(1_000);
    await store.todos.setState(item.id, 'in_progress', 'agent');
    tick(60_000);
    await store.events.append({ sessionId: s.id, kind: 'ok', label: 'Done', payload: result(1_300, { usage: { input: 100, output: 200, cacheWrite: 1_000, cacheRead: 50_000 }, model: 'claude-haiku-4-5' }) });
    tick(60_000);
    await store.events.append({ sessionId: s.id, kind: 'ok', label: 'Done', payload: result(500) });
    tick(60_000);
    await store.todos.setState(item.id, 'done');
    const window = { from: '2026-10-13T00:00:00.000Z', to: '2026-10-14T00:00:00.000Z' };
    const [row] = store.insights.todoActuals(window.from, window.to);
    expect(row).toMatchObject({
      todoId: item.id,
      priority: 'low',
      estimateMinutes: 20,
      actualMs: 180_000,
      actualTokens: 1_800,
      usage: { input: 100, output: 200, cacheWrite: 1_000, cacheRead: 50_000, unsplit: 500 },
      model: 'claude-haiku-4-5',
      provider: 'claude',
      profileId: 'default-claude',
      folder: '/work/acme',
      reopens: 0,
    });
    // Reopened (done → in progress), then done again: one reopen.
    tick(60_000);
    await store.todos.setState(item.id, 'in_progress');
    expect(store.insights.todoActuals(window.from, window.to)).toEqual([]);
    tick(60_000);
    await store.todos.setState(item.id, 'done');
    expect(store.insights.todoActuals(window.from, window.to)[0]).toMatchObject({ reopens: 1, actualMs: 240_000 });
  });
});

describe('migration 0045 (D108)', () => {
  it('records the backfill boundary, adds the columns and fills the older todo_actuals rows', async () => {
    const shipped = await loadMigrations();
    expect(shipped.find((m) => m.version === 45)).toMatchObject({ name: 'insights' });
    const db = await openDatabase(':memory:');
    migrate(db, shipped.filter((m) => m.version <= 44));
    const ts = '2026-10-08T09:00:00.000Z';
    db.prepare("INSERT INTO sessions (id, name, claude_session_id, cwd, root, created_at, updated_at, model, provider) VALUES ('s', 'source', 'c', '/w', '/w', ?, ?, NULL, 'claude')").run(ts, ts);
    db.prepare("INSERT INTO sessions (id, name, claude_session_id, cwd, root, created_at, updated_at, model, provider, profile_id) VALUES ('r', 'run', 'c2', '/w', '/w', ?, ?, 'haiku', 'claude', 'p2')").run(ts, ts);
    db.prepare("INSERT INTO session_todos (id, session_id, title, plan, priority, state, added_by, position, created_at, updated_at, done_at, run_session_id, run_state, actual_ms, actual_tokens) VALUES ('t', 's', 'Docs', 'No plan', 'high', 'done', 'agent', 0, ?, ?, ?, 'r', 'active', 60000, 1234)").run(ts, ts, ts);
    db.prepare("INSERT INTO todo_actuals (todo_id, session_id, folder, title, estimate_minutes, actual_ms, actual_tokens, completed_at) VALUES ('t', 's', '/w', 'Docs', 10, 60000, 1234, ?)").run(ts);
    db.prepare("INSERT INTO todo_actuals (todo_id, session_id, folder, title, estimate_minutes, actual_ms, actual_tokens, completed_at) VALUES ('gone', 's', '/w', 'Gone', NULL, 1000, NULL, ?)").run(ts);
    db.prepare("INSERT INTO events (session_id, ts, kind, label, payload) VALUES ('s', ?, 'ok', 'x', '{}'), ('s', ?, 'ok', 'y', '{}')").run(ts, ts);

    expect(migrate(db, shipped.filter((m) => m.version <= 45)).applied).toEqual([45]);
    expect(db.prepare("SELECT value FROM insight_state WHERE key = 'events.upto'").get()?.['value']).toBe('2');
    expect(db.prepare("SELECT value FROM insight_state WHERE key = 'events.done'").get()?.['value']).toBe('0');
    const actuals = db.prepare('SELECT todo_id, run_session_id, priority, provider, model, profile_id, usage FROM todo_actuals ORDER BY todo_id').all().map((row) => ({ ...row }));
    expect(actuals).toEqual([
      // The item was removed already: nothing to read but its own session.
      { todo_id: 'gone', run_session_id: null, priority: null, provider: 'claude', model: '', profile_id: 'default-claude', usage: null },
      { todo_id: 't', run_session_id: 'r', priority: 'high', provider: 'claude', model: 'haiku', profile_id: 'p2', usage: '{"input":0,"output":0,"cacheWrite":0,"cacheRead":0,"unsplit":1234}' },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('insight_turns_daily', 'todo_reopens', 'usage_readings_profile', 'todo_actuals_completed') ORDER BY name").all().map((row) => row['name'])).toEqual(['insight_turns_daily', 'todo_actuals_completed', 'todo_reopens', 'usage_readings_profile']);
    db.close();
  });

  it('an upgrade from 0044 applies 0045 then 0046 (D109) in order; a database that already has 0046 still gets 0045', async () => {
    const shipped = await loadMigrations();
    expect(shipped.map((m) => m.version).filter((v) => v >= 44)).toEqual([44, 45, 46]);
    const db = await openDatabase(':memory:');
    migrate(db, shipped.filter((m) => m.version <= 44));
    expect(migrate(db, shipped).applied).toEqual([45, 46]);
    db.close();
    // The CI lane shipped first (0046 without 0045): 0045 applies afterwards, its rollup boundary at the newest event.
    const gap = await openDatabase(':memory:');
    migrate(gap, shipped.filter((m) => m.version <= 44 || m.version === 46));
    gap.prepare("INSERT INTO sessions (id, name, claude_session_id, created_at, updated_at) VALUES ('s', 's', 'c', 'x', 'x')").run();
    gap.prepare("INSERT INTO events (session_id, ts, kind, label, payload) VALUES ('s', 'x', 'ok', 'x', '{}')").run();
    expect(migrate(gap, shipped).applied).toEqual([45]);
    expect(gap.prepare("SELECT value FROM insight_state WHERE key = 'events.upto'").get()?.['value']).toBe('1');
    gap.close();
  });
});

