import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/server/db/database.ts';
import {
  MIGRATIONS_DIR,
  MigrationError,
  appliedMigrations,
  checksumOf,
  loadMigrations,
  makeMigration,
  migrate,
} from '../../../src/server/db/migrate.ts';
import { openStore, storeFile } from '../../../src/server/db/store.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';

let tmp: string;
const open: DatabaseSync[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('migrate');
});
afterEach(async () => {
  for (const db of open.splice(0)) if (db.isOpen) db.close();
  await removeTempDir(tmp);
});

async function db(file = path.join(tmp, 'test.db')): Promise<DatabaseSync> {
  const database = await openDatabase(file);
  open.push(database);
  return database;
}

/** Every schema object's SQL, for before/after comparisons. */
function schemaDump(database: DatabaseSync): string[] {
  return database
    .prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`)
    .all()
    .map((row) => `${String(row['type'])} ${String(row['name'])}: ${String(row['sql'])}`);
}

function columnsOf(database: DatabaseSync, table: string): string[] {
  return database.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((row) => String(row['name']));
}

/**
 * Required columns per table: every entity of ARCHITECTURE → "Data model", the M0
 * "Stored state" fields, and the Inbox's permission requests (D6) + system items.
 */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  sessions: [
    'id', 'name', 'claude_session_id', 'status', 'work_type', 'mode', 'phase', 'coordination', 'qa_stack', 'ultracode',
    'solutions', 'created_at', 'attached', 'pid', 'requested_permission_mode', 'observed_permission_mode', 'cli_version',
    'last_transcript_uuid', 'task', 'worktrees', 'qa_confluence_url', 'qa_figma_urls',
  ],
  agents: ['session_id', 'name', 'description', 'solution_path', 'branch', 'status', 'tool_use_id', 'task_id', 'subagent_type'],
  events: ['session_id', 'agent_id', 'ts', 'kind', 'label', 'payload'],
  question_batches: ['id', 'session_id', 'tool_use_id', 'input', 'state'],
  questions: [
    'id', 'session_id', 'batch_id', 'source', 'text', 'options', 'answer_index', 'answered_at', 'header', 'multi_select',
    'answer_label',
  ],
  permission_requests: [
    'id', 'session_id', 'request_id', 'tool_use_id', 'tool_name', 'input', 'description', 'decision_reason', 'agent_id',
    'state', 'decision',
  ],
  system_items: ['id', 'kind', 'source', 'title', 'detail', 'branches', 'actions', 'state'],
  worktrees: ['repo', 'branch', 'path', 'session_id', 'pr_number', 'pr_state', 'removable'],
  artifacts: ['type', 'name', 'solution', 'branch', 'session_id', 'meta', 'created_at'],
  schedules: ['name', 'cron', 'template', 'paused'],
  schedule_runs: ['schedule_id', 'ts', 'result'],
  loops: ['session_id', 'kind', 'iteration', 'cap', 'breaker_count', 'expires_at'],
  tools: ['id', 'name', 'url', 'show_in_sidebar'],
  settings: ['key', 'value'],
  usage_readings: ['five_hour_pct', 'five_hour_resets_at', 'seven_day_pct', 'seven_day_resets_at', 'source', 'received_at'],
  history_cache: ['transcript_path', 'size', 'mtime_ms', 'item'],
  pending_messages: ['session_id', 'kind', 'text', 'delivered_at'],
};

describe('shipped migrations', () => {
  it('load in version order with checksums', async () => {
    const migrations = await loadMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(1);
    expect(migrations[0]).toMatchObject({ version: 1, name: 'initial' });
    const sql = await readFile(path.join(MIGRATIONS_DIR, '0001_initial.sql'), 'utf8');
    expect(migrations[0]?.checksum).toBe(checksumOf(sql));
    expect(migrations.map((m) => m.version)).toEqual([...migrations.map((m) => m.version)].sort((a, b) => a - b));
  });

  it('create every data-model table with its fields on a fresh database', async () => {
    const database = await db();
    const result = migrate(database, await loadMigrations());
    expect(result.applied).toEqual((await loadMigrations()).map((m) => m.version));
    for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
      const columns = columnsOf(database, table);
      expect(columns, `table ${table}`).not.toEqual([]);
      for (const column of required) expect(columns, `${table}.${column}`).toContain(column);
    }
    const strict = database
      .prepare(`SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND strict = 0 AND name NOT LIKE 'sqlite_%'`)
      .all();
    expect(strict).toEqual([]);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });
});

describe('openStore on a temp file', () => {
  it('creates the file (and its folder), applies the migrations and uses WAL + foreign keys', async () => {
    const file = storeFile(path.join(tmp, 'nested', 'data'));
    const store = await openStore(file, { now: () => new Date('2026-09-28T01:02:03.004Z') });
    try {
      expect(store.migrations.applied).toEqual([1]);
      expect(store.migrations.version).toBe(1);
      expect(appliedMigrations(store.db)).toEqual([
        { version: 1, name: 'initial', checksum: checksumOf(await readFile(path.join(MIGRATIONS_DIR, '0001_initial.sql'), 'utf8')), appliedAt: '2026-09-28T01:02:03.004Z' },
      ]);
      expect(store.db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      expect(store.db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    } finally {
      await store.close();
    }
    expect(path.basename(file)).toBe('switchboard.db');
  });

  it('re-running on a current database is a no-op and keeps the data', async () => {
    const file = path.join(tmp, 'switchboard.db');
    const first = await openStore(file, { now: () => new Date('2026-09-28T00:00:00.000Z') });
    const session = await first.sessions.create({ name: 'keep-me', claudeSessionId: 'c-1' });
    const schema = schemaDump(first.db);
    const applied = appliedMigrations(first.db);
    // Same connection, second run.
    expect(migrate(first.db, await loadMigrations())).toEqual({ applied: [], version: 1 });
    await first.close();

    const second = await openStore(file, { now: () => new Date('2027-01-01T00:00:00.000Z') });
    try {
      expect(second.migrations).toEqual({ applied: [], version: 1 });
      expect(schemaDump(second.db)).toEqual(schema);
      expect(appliedMigrations(second.db)).toEqual(applied);
      expect(await second.sessions.get(session.id)).toEqual(session);
    } finally {
      await second.close();
    }
  });

  it('close is idempotent', async () => {
    const store = await openStore(path.join(tmp, 'switchboard.db'));
    await store.close();
    await store.close();
    expect(store.db.isOpen).toBe(false);
  });
});

describe('migration runner', () => {
  const one = makeMigration(1, 'one', 'CREATE TABLE a (id INTEGER PRIMARY KEY) STRICT;');
  const two = makeMigration(2, 'two', 'CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a (id)) STRICT;');

  it('applies only the missing migrations, in order', async () => {
    const database = await db();
    expect(migrate(database, [one])).toEqual({ applied: [1], version: 1 });
    expect(migrate(database, [one, two])).toEqual({ applied: [2], version: 2 });
    expect(migrate(database, [one, two])).toEqual({ applied: [], version: 2 });
    expect(appliedMigrations(database).map((m) => m.version)).toEqual([1, 2]);
  });

  it('rolls a failing migration back completely and keeps the earlier ones', async () => {
    const database = await db();
    const broken = makeMigration(2, 'broken', 'CREATE TABLE b (id INTEGER PRIMARY KEY) STRICT;\nINSERT INTO missing_table VALUES (1);');
    expect(() => migrate(database, [one, broken])).toThrow(MigrationError);
    expect(() => migrate(database, [one, broken])).toThrow(/migration 2 \(broken\) failed: .*missing_table/);
    expect(columnsOf(database, 'b')).toEqual([]);
    expect(appliedMigrations(database).map((m) => m.version)).toEqual([1]);
    expect(database.isTransaction).toBe(false);
    // The fixed migration applies afterwards.
    expect(migrate(database, [one, two]).applied).toEqual([2]);
  });

  it('rolls back a migration that leaves foreign key violations', async () => {
    const database = await db();
    const orphan = makeMigration(2, 'orphan', `${two.sql}\nINSERT INTO b (id, a_id) VALUES (1, 42);`);
    expect(() => migrate(database, [one, orphan])).toThrow(/migration 2 \(orphan\) failed: FOREIGN KEY constraint failed/);
    expect(columnsOf(database, 'b')).toEqual([]);
    // Deferred checks would only fail at COMMIT; the runner's foreign_key_check catches them first.
    const deferred = makeMigration(2, 'deferred', `PRAGMA defer_foreign_keys = ON;\n${orphan.sql}`);
    expect(() => migrate(database, [one, deferred])).toThrow(/migration 2 \(deferred\) failed: foreign key violations/);
    expect(columnsOf(database, 'b')).toEqual([]);
    expect(database.isTransaction).toBe(false);
  });

  it('refuses a migration that changed after it was applied', async () => {
    const database = await db();
    migrate(database, [one]);
    const edited = makeMigration(1, 'one', 'CREATE TABLE a (id INTEGER PRIMARY KEY, extra TEXT) STRICT;');
    expect(() => migrate(database, [edited])).toThrow(/migration 1 \(one\) was changed after it was applied/);
    expect(columnsOf(database, 'a')).toEqual(['id']);
  });

  it('refuses a database migrated by a newer build', async () => {
    const database = await db();
    migrate(database, [one, two]);
    expect(() => migrate(database, [one])).toThrow(/has migration 2 \(two\), which this build does not know/);
  });

  it('refuses unordered or duplicate versions', async () => {
    const database = await db();
    expect(() => migrate(database, [two, one])).toThrow(/duplicate or unordered migration version 1/);
    expect(() => migrate(database, [one, one])).toThrow(/duplicate or unordered/);
  });

  it('openStore closes the connection and rethrows when migrating fails', async () => {
    const file = path.join(tmp, 'newer.db');
    const database = await db(file);
    migrate(database, [...(await loadMigrations()), makeMigration(9999, 'future', 'CREATE TABLE future (id INTEGER) STRICT;')]);
    database.close();
    await expect(openStore(file)).rejects.toThrow(MigrationError);
  });

  it('treats CRLF and LF checkouts of a migration as the same', () => {
    expect(checksumOf('CREATE TABLE a (id INTEGER);\r\nCREATE TABLE b (id INTEGER);\r\n')).toBe(
      checksumOf('CREATE TABLE a (id INTEGER);\nCREATE TABLE b (id INTEGER);\n'),
    );
  });
});

describe('loadMigrations', () => {
  it('reads NNNN_name.sql files in version order and ignores other files', async () => {
    const dir = path.join(tmp, 'migrations');
    await mkdir(dir);
    await writeFile(path.join(dir, '0002_second.sql'), 'SELECT 2;');
    await writeFile(path.join(dir, '0001_first.sql'), 'SELECT 1;');
    await writeFile(path.join(dir, 'README.md'), 'not a migration');
    const migrations = await loadMigrations(dir);
    expect(migrations.map((m) => [m.version, m.name, m.sql])).toEqual([
      [1, 'first', 'SELECT 1;'],
      [2, 'second', 'SELECT 2;'],
    ]);
  });

  it.each([
    [['1_bad.sql'], /does not match NNNN_name.sql/],
    [['0001_Upper.sql'], /does not match NNNN_name.sql/],
    [['0000_zero.sql'], /version 0000 is reserved/],
    [['0001_a.sql', '0001_b.sql'], /duplicate or unordered migration version 1/],
  ])('rejects %j', async (files, message) => {
    const dir = path.join(tmp, 'bad');
    await mkdir(dir);
    for (const file of files) await writeFile(path.join(dir, file), 'SELECT 1;');
    await expect(loadMigrations(dir)).rejects.toThrow(message);
  });
});
