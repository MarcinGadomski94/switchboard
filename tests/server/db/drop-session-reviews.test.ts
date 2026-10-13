import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/server/db/database.ts';
import { loadMigrations, migrate, needsForeignKeysOff } from '../../../src/server/db/migrate.ts';

/**
 * D102 · migration 0043 (`docs/database.md`): review cards (D79) are removed. `session_reviews`
 * and its indexes are dropped; todo items still in D76's `review` state become done (with a
 * done time); the cards' drafts and the `sessions.reviewCards` setting are deleted; nothing else
 * changes.
 */
describe('migration 0043 (D102: review cards removed)', () => {
  it('drops session_reviews, turns review todos into done, deletes the cards\' drafts and setting; the rest stays', async () => {
    const shipped = await loadMigrations();
    const m43 = shipped.find((m) => m.version === 43);
    expect(m43).toMatchObject({ name: 'drop_session_reviews' });
    expect(needsForeignKeysOff(m43!)).toBe(false);
    const db = await openDatabase(':memory:');
    migrate(db, shipped.filter((m) => m.version <= 42));
    const ts = '2026-10-08T09:00:00.000Z';
    db.prepare('INSERT INTO sessions (id, name, claude_session_id, cwd, root, root_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('s', 'source', 'c', '/tmp/x', '/tmp/x', 'repo', ts, ts);
    const insert = db.prepare(
      'INSERT INTO session_todos (id, session_id, title, plan, priority, state, added_by, position, created_at, updated_at, done_at, started_at, started_by, run_session_id, run_state, actual_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run('r', 's', 'Run, in review', 'No plan', 'medium', 'review', 'developer', 0, ts, ts, null, ts, 'run', 'run-1', 'active', 60_000);
    insert.run('o', 's', 'Open', 'No plan', 'medium', 'open', 'developer', 1, ts, ts, null, null, null, null, null, null);
    insert.run('d', 's', 'Done', 'No plan', 'medium', 'done', 'developer', 2, ts, ts, ts, null, null, null, null, null);
    db.prepare("INSERT INTO session_reviews (id, session_id, fingerprint, state, created_at, updated_at) VALUES ('rev1', 's', 'fp', 'pending', ?, ?)").run(ts, ts);
    const draft = db.prepare('INSERT INTO session_drafts (session_id, field, value, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)');
    draft.run('s', 'review:rev1', '{"comment":"x"}', ts, 'local');
    draft.run('s', 'commit:rev1', '{"message":"x"}', ts, 'local');
    draft.run('s', 'composer', '{"text":"keep","attachments":[]}', ts, 'local');
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('sessions.reviewCards', 'true', ?), ('sessions.checkpoints', 'true', ?)").run(ts, ts);

    expect(migrate(db, shipped.filter((m) => m.version <= 43)).applied).toEqual([43]);

    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'session_reviews%'").all()).toEqual([]);
    const rows = db.prepare('SELECT id, state, done_at, run_session_id, run_state, actual_ms FROM session_todos ORDER BY position').all().map((row) => ({ ...row }));
    expect(rows.map((row) => [row['id'], row['state']])).toEqual([
      ['r', 'done'],
      ['o', 'open'],
      ['d', 'done'],
    ]);
    // The converted item has a done time (the done hour removes it) and keeps its run link and actuals.
    expect(rows[0]).toMatchObject({ run_session_id: 'run-1', run_state: 'active', actual_ms: 60_000 });
    expect(String(rows[0]?.['done_at'])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(rows[2]?.['done_at']).toBe(ts);
    expect(db.prepare('SELECT field FROM session_drafts ORDER BY field').all().map((row) => row['field'])).toEqual(['composer']);
    expect(db.prepare('SELECT key FROM settings ORDER BY key').all().map((row) => row['key'])).toEqual(['sessions.checkpoints']);
    db.close();
  });
});
