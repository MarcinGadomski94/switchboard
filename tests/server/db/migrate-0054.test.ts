import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/server/db/database.ts';
import { loadMigrations, migrate } from '../../../src/server/db/migrate.ts';
import { openStore } from '../../../src/server/db/store.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';

/**
 * 0054 (2026-11-05): a session linked to a saved folder after it started (a terminal session
 * followed from its cwd, then the folder saved) kept `root_kind` NULL and read as plain (D59), so a
 * workspace crew member moved as "not in a git repository". It takes its saved folder's kind; and
 * `linkSessions` sets it from now on.
 */

let tmp: string;
const open: DatabaseSync[] = [];
beforeEach(async () => {
  tmp = await makeTempDir('migrate-0054');
});
afterEach(async () => {
  for (const db of open.splice(0)) if (db.isOpen) db.close();
  await removeTempDir(tmp);
});

describe('0054 session folder kind', () => {
  it('a session whose root is its saved workspace or repo folder takes that kind; plain, other roots, a set kind and no folder stay', async () => {
    const database = await openDatabase(path.join(tmp, 'test.db'));
    open.push(database);
    const shipped = await loadMigrations();
    migrate(database, shipped.filter((m) => m.version < 54));
    const ts = '2026-11-05T10:00:00.000Z';
    const folder = database.prepare('INSERT INTO folders (id, path, canonical_path, kind, is_default, added_at, last_used_at, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    folder.run('ws', 'D:\\ws', 'D:\\ws', 'workspace', 1, ts, null, null);
    folder.run('repo', '/r', '/real/r', 'repo', 0, ts, null, null);
    folder.run('plain', '/p', '/p', 'plain', 0, ts, null, null);
    const session = database.prepare('INSERT INTO sessions (id, name, claude_session_id, cwd, root, root_kind, folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    session.run('term', 'term-ws', 'c1', 'D:\\ws', 'D:\\ws', null, 'ws', ts, ts);
    session.run('term-repo', 'term-r', 'c2', '/real/r', '/real/r', null, 'repo', ts, ts);
    session.run('plain', 'p', 'c3', '/p', '/p', null, 'plain', ts, ts);
    session.run('elsewhere', 'e', 'c4', 'D:\\ws\\sub', 'D:\\ws\\sub', null, 'ws', ts, ts);
    session.run('set', 's', 'c5', 'D:\\ws', 'D:\\ws', 'repo', 'ws', ts, ts);
    session.run('loose', 'l', 'c6', 'D:\\ws', 'D:\\ws', null, null, ts, ts);

    expect(migrate(database, shipped.filter((m) => m.version <= 54)).applied).toEqual([54]);
    const kinds = Object.fromEntries(database.prepare('SELECT id, root_kind FROM sessions ORDER BY id').all().map((row) => [row['id'], row['root_kind']]));
    expect(kinds).toEqual({ term: 'workspace', 'term-repo': 'repo', plain: null, elsewhere: null, set: 'repo', loose: null });
  });

  it('linkSessions gives a linked session without a kind the folder\'s kind (plain stays NULL)', async () => {
    const store = await openStore(path.join(tmp, 'data'));
    try {
      const ws = await store.folders.create({ path: '/ws', canonicalPath: '/ws', kind: 'workspace', isDefault: false });
      const plain = await store.folders.create({ path: '/p', canonicalPath: '/p', kind: 'plain', isDefault: false });
      const a = await store.sessions.create({ name: 'a', title: 'a', task: '', claudeSessionId: 'c-a', status: 'idle', attached: false, cwd: '/ws', root: '/ws' });
      const b = await store.sessions.create({ name: 'b', title: 'b', task: '', claudeSessionId: 'c-b', status: 'idle', attached: false, cwd: '/p', root: '/p' });
      expect(await store.folders.linkSessions(ws)).toBe(1);
      expect(await store.folders.linkSessions(plain)).toBe(1);
      expect(await store.sessions.get(a.id)).toMatchObject({ folderId: ws.id, rootKind: 'workspace' });
      expect(await store.sessions.get(b.id)).toMatchObject({ folderId: plain.id, rootKind: 'plain' });
    } finally {
      await store.close();
    }
  });
});
