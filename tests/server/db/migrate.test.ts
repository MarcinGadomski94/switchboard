import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/server/db/database.ts';
import {
  FOREIGN_KEYS_OFF,
  LEGACY_CHECKSUMS,
  MIGRATIONS_DIR,
  type Migration,
  MigrationError,
  appliedMigrations,
  checksumOf,
  loadMigrations,
  makeMigration,
  migrate,
  needsForeignKeysOff,
} from '../../../src/server/db/migrate.ts';
import { loadDemoData } from '../../../src/server/demo/data.ts';
import { seedDemo } from '../../../src/server/demo/seed.ts';
import { openStore, storeFile } from '../../../src/server/db/store.ts';
import { EMPTY_CONTEXT } from '../../../src/core/context-meter.ts';
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
    'last_transcript_uuid', 'task', 'worktrees', 'qa_confluence_url', 'qa_figma_urls', 'folder_id', 'root', 'root_kind',
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
  schedules: ['name', 'cron', 'template', 'paused', 'folder_id'],
  folders: ['id', 'path', 'canonical_path', 'kind', 'is_default', 'added_at', 'last_used_at', 'label'],
  schedule_runs: ['schedule_id', 'ts', 'result'],
  loops: ['session_id', 'kind', 'iteration', 'cap', 'breaker_count', 'expires_at'],
  tools: ['id', 'name', 'url', 'show_in_sidebar'],
  settings: ['key', 'value'],
  usage_readings: ['five_hour_pct', 'five_hour_resets_at', 'seven_day_pct', 'seven_day_resets_at', 'source', 'received_at'],
  history_cache: ['transcript_path', 'size', 'mtime_ms', 'item'],
  pending_messages: ['session_id', 'kind', 'text', 'delivered_at'],
  // D48: paired machines.
  machines: ['id', 'name', 'address', 'outbound_token', 'inbound_token_hash', 'paired_at', 'last_seen_at'],
  // D48 ruling D48-cache-persist.
  peer_snapshots: ['machine_id', 'kind', 'key', 'body', 'updated_at'],
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

describe('0005 folder label (D18)', () => {
  const insertFolder = 'INSERT INTO folders (id, path, canonical_path, kind, is_default, added_at, label) VALUES (?, ?, ?, ?, ?, ?, ?)';

  it('a fresh database: folders.label is a nullable TEXT with a unique case-insensitive index on the labels that are set', async () => {
    const database = await db();
    migrate(database, await loadMigrations());
    const label = database.prepare(`SELECT type, "notnull", dflt_value FROM pragma_table_info('folders') WHERE name = 'label'`).get();
    expect(label).toEqual({ type: 'TEXT', notnull: 0, dflt_value: null });
    const index = database.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'folders_label'`).get();
    expect(String(index?.['sql'])).toMatch(/UNIQUE INDEX folders_label ON folders \(label COLLATE NOCASE\) WHERE label IS NOT NULL/);
    const insert = database.prepare(insertFolder);
    insert.run('a', '/a', '/a', 'workspace', 1, 'now', 'Tools');
    // Folders without a label are not counted.
    insert.run('b', '/b', '/b', 'repo', 0, 'now', null);
    insert.run('c', '/c', '/c', 'repo', 0, 'now', null);
    expect(() => insert.run('d', '/d', '/d', 'repo', 0, 'now', 'tools')).toThrow(/UNIQUE/);
    expect(() => insert.run('e', '/e', '/e', 'repo', 0, 'now', 'TOOLS')).toThrow(/UNIQUE/);
    insert.run('f', '/f', '/f', 'repo', 0, 'now', 'Tools 2');
    expect(database.prepare('SELECT id, label FROM folders ORDER BY id').all()).toEqual([
      { id: 'a', label: 'Tools' },
      { id: 'b', label: null },
      { id: 'c', label: null },
      { id: 'f', label: 'Tools 2' },
    ]);
  });

  it('on top of 0004: saved folders keep every field and get no label; sessions and schedules keep their folder', async () => {
    const database = await db();
    const shipped = await loadMigrations();
    migrate(database, shipped.filter((m) => m.version <= 4));
    const ts = '2026-09-28T10:00:00.000Z';
    database.prepare('INSERT INTO folders (id, path, canonical_path, kind, is_default, added_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('f-ws', '/Users/dev/ws', '/Users/dev/ws', 'workspace', 1, ts, ts);
    database.prepare('INSERT INTO folders (id, path, canonical_path, kind, is_default, added_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('f-repo', '/Users/dev/tool', '/real/tool', 'repo', 0, ts, null);
    database.prepare('INSERT INTO sessions (id, name, claude_session_id, cwd, root, root_kind, folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('s', 'fix', 'c', '/real/tool', '/real/tool', 'repo', 'f-repo', ts, ts);
    database.prepare('INSERT INTO schedules (id, name, cron, template, folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('sch', 'nightly', '0 2 * * *', '{}', 'f-ws', ts, ts);
    expect(migrate(database, shipped).applied).toEqual(shipped.filter((m) => m.version > 4).map((m) => m.version));
    expect(database.prepare('SELECT id, path, canonical_path, kind, is_default, added_at, last_used_at, label FROM folders ORDER BY id').all()).toEqual([
      { id: 'f-repo', path: '/Users/dev/tool', canonical_path: '/real/tool', kind: 'repo', is_default: 0, added_at: ts, last_used_at: null, label: null },
      { id: 'f-ws', path: '/Users/dev/ws', canonical_path: '/Users/dev/ws', kind: 'workspace', is_default: 1, added_at: ts, last_used_at: ts, label: null },
    ]);
    expect(database.prepare('SELECT folder_id FROM sessions').get()).toEqual({ folder_id: 'f-repo' });
    expect(database.prepare('SELECT folder_id FROM schedules').get()).toEqual({ folder_id: 'f-ws' });
    database.prepare("UPDATE folders SET label = 'Tools' WHERE id = 'f-repo'").run();
    expect(() => database.prepare("UPDATE folders SET label = 'tools' WHERE id = 'f-ws'").run()).toThrow(/UNIQUE/);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('0004 session origin (D16)', () => {
  it("marks sessions moved in from a terminal (their 'moved' lifecycle event) as origin terminal; every other session is switchboard", async () => {
    const database = await db();
    const shipped = await loadMigrations();
    migrate(database, shipped.filter((m) => m.version <= 3));
    const ts = '2026-09-28T10:00:00.000Z';
    const insert = database.prepare('INSERT INTO sessions (id, name, claude_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    insert.run('s-moved', 'moved-one', 'c-moved', ts, ts);
    insert.run('s-new', 'started-here', 'c-new', ts, ts);
    const event = database.prepare('INSERT INTO events (session_id, ts, kind, label, payload) VALUES (?, ?, ?, ?, ?)');
    event.run('s-moved', ts, 'text', 'Moved from a terminal', JSON.stringify({ type: 'lifecycle', action: 'moved' }));
    event.run('s-new', ts, 'text', 'Started', JSON.stringify({ type: 'lifecycle', action: 'started' }));
    expect(migrate(database, shipped).applied).toEqual(shipped.filter((m) => m.version > 3).map((m) => m.version));
    expect(database.prepare('SELECT id, origin FROM sessions ORDER BY id').all()).toEqual([
      { id: 's-moved', origin: 'terminal' },
      { id: 's-new', origin: 'switchboard' },
    ]);
    expect(() => database.prepare("UPDATE sessions SET origin = 'elsewhere' WHERE id = 's-new'").run()).toThrow(/CHECK/);
  });
});

describe('0006 session title (D22)', () => {
  it('adds a nullable title to an existing database: its sessions keep their names and have no title', async () => {
    const file = path.join(tmp, 'existing.db');
    const database = await db(file);
    const shipped = await loadMigrations();
    expect(shipped.find((m) => m.version === 6)).toMatchObject({ name: 'session_title' });
    // A database as the build before D22 left it (0006 does not depend on any 0005).
    migrate(database, shipped.filter((m) => m.version <= 4));
    const ts = '2026-09-28T10:00:00.000Z';
    database.prepare('INSERT INTO sessions (id, name, claude_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('s-old', 'free-talk-640', 'c-old', ts, ts);
    expect(migrate(database, shipped).applied).toEqual(shipped.filter((m) => m.version > 4).map((m) => m.version));
    expect(database.prepare('SELECT id, name, title FROM sessions').all()).toEqual([{ id: 's-old', name: 'free-talk-640', title: null }]);
    database.prepare("UPDATE sessions SET title = 'Free talk at 640' WHERE id = 's-old'").run();
    database.close();

    // The store reads it: the old session's title, a new one without.
    const store = await openStore(file);
    try {
      expect(await store.sessions.get('s-old')).toMatchObject({ name: 'free-talk-640', title: 'Free talk at 640' });
      expect(await store.sessions.create({ name: 'fresh', claudeSessionId: 'c-fresh' })).toMatchObject({ title: null });
    } finally {
      await store.close();
    }
  });
});

describe('0007 session remote (D24)', () => {
  it('adds the Remote Control columns: existing sessions get remote_available 0 and Remote off, batches no answered_on', async () => {
    const file = path.join(tmp, 'existing.db');
    const database = await db(file);
    const shipped = await loadMigrations();
    expect(shipped.find((m) => m.version === 7)).toMatchObject({ name: 'session_remote' });
    // A database as the build before D24 left it (0007 does not depend on D25's 0008).
    migrate(database, shipped.filter((m) => m.version <= 6));
    const ts = '2026-09-28T10:00:00.000Z';
    database.prepare('INSERT INTO sessions (id, name, claude_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('s-old', 'free-talk-640', 'c-old', ts, ts);
    database.prepare('INSERT INTO question_batches (id, session_id, input, created_at) VALUES (?, ?, ?, ?)').run('b-old', 's-old', '{}', ts);
    expect(migrate(database, shipped).applied).toEqual(shipped.filter((m) => m.version > 6).map((m) => m.version));
    expect(database.prepare('SELECT remote_available, remote_enabled, remote_session_url, remote_bridge_id FROM sessions').all()).toEqual([
      { remote_available: 0, remote_enabled: 0, remote_session_url: null, remote_bridge_id: null },
    ]);
    expect(database.prepare('SELECT answered_on FROM question_batches').all()).toEqual([{ answered_on: null }]);
    expect(() => database.prepare("UPDATE sessions SET remote_enabled = 2 WHERE id = 's-old'").run()).toThrow(/CHECK/);
    expect(() => database.prepare("UPDATE sessions SET remote_available = 5 WHERE id = 's-old'").run()).toThrow(/CHECK/);
    database.close();

    // The store reads it: the old session shows Remote off (not null: it had a process before); a new row starts with null.
    const store = await openStore(file);
    try {
      expect(await store.sessions.get('s-old')).toMatchObject({ remoteAvailable: false, remoteEnabled: false, remoteSessionUrl: null, remoteBridgeId: null });
      expect(await store.sessions.create({ name: 'fresh', claudeSessionId: 'c-fresh' })).toMatchObject({ remoteAvailable: null, remoteEnabled: false });
      expect(await store.questions.getBatch('b-old')).toMatchObject({ answeredOn: null });
    } finally {
      await store.close();
    }
  });
});

describe('0008 session remote source (D25)', () => {
  it('adds a nullable remote_source to an existing database: its sessions are no local copies; a new one can be', async () => {
    const file = path.join(tmp, 'existing-remote.db');
    const database = await db(file);
    const shipped = await loadMigrations();
    expect(shipped.find((m) => m.version === 8)).toMatchObject({ name: 'session_remote_source' });
    // 0007 belongs to another change (D24): the runner takes the gap, and 0008 needs nothing after 0006.
    migrate(database, shipped.filter((m) => m.version <= 6));
    const ts = '2026-09-28T10:00:00.000Z';
    database.prepare('INSERT INTO sessions (id, name, claude_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('s-old', 'free-talk-640', 'c-old', ts, ts);
    expect(migrate(database, shipped).applied).toEqual(shipped.filter((m) => m.version > 6).map((m) => m.version));
    expect(database.prepare('SELECT id, remote_source FROM sessions').all()).toEqual([{ id: 's-old', remote_source: null }]);
    database.close();

    const store = await openStore(file);
    try {
      expect(await store.sessions.get('s-old')).toMatchObject({ remoteSource: null });
      expect(await store.sessions.create({ name: 'copy', claudeSessionId: 'c-copy', remoteSource: 'session_01ABCdef' })).toMatchObject({ remoteSource: 'session_01ABCdef' });
    } finally {
      await store.close();
    }
  });
});

describe('0009 session model (D31)', () => {
  it('adds nullable model, effort and model_options to an existing database: its sessions keep the CLI defaults', async () => {
    const file = path.join(tmp, 'existing-model.db');
    const database = await db(file);
    const shipped = await loadMigrations();
    expect(shipped.find((m) => m.version === 9)).toMatchObject({ name: 'session_model' });
    // A database as the build before D31 left it (0001–0008).
    migrate(database, shipped.filter((m) => m.version <= 8));
    const ts = '2026-09-28T10:00:00.000Z';
    database.prepare('INSERT INTO sessions (id, name, claude_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('s-old', 'free-talk-640', 'c-old', ts, ts);
    expect(migrate(database, shipped).applied).toEqual(shipped.filter((m) => m.version > 8).map((m) => m.version));
    expect(database.prepare('SELECT id, model, effort, model_options FROM sessions').all()).toEqual([{ id: 's-old', model: null, effort: null, model_options: null }]);
    database.close();

    const store = await openStore(file);
    try {
      expect(await store.sessions.get('s-old')).toMatchObject({ model: null, effort: null, modelOptions: null });
      const options = [{ value: 'opus', label: 'Opus 5.5', efforts: ['low', 'high'] }, { value: 'haiku', label: 'Haiku 4.5' }];
      const updated = await store.sessions.update('s-old', { model: 'opus', effort: 'high', modelOptions: options });
      expect(updated).toMatchObject({ model: 'opus', effort: 'high', modelOptions: options });
      expect(await store.sessions.get('s-old')).toMatchObject({ model: 'opus', effort: 'high', modelOptions: options });
    } finally {
      await store.close();
    }
  });
});

describe('0010 session closed (D33)', () => {
  it('adds nullable sessions.closed_at and question_batches.closed_reason: existing sessions are open, existing batches not closed', async () => {
    const file = path.join(tmp, 'existing-closed.db');
    const database = await db(file);
    const shipped = await loadMigrations();
    expect(shipped.find((m) => m.version === 10)).toMatchObject({ name: 'session_closed' });
    // A database as the build before D33 left it (0009 belongs to another change: the runner takes the gap).
    migrate(database, shipped.filter((m) => m.version <= 8));
    const ts = '2026-09-28T10:00:00.000Z';
    database.prepare('INSERT INTO sessions (id, name, claude_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('s-old', 'free-talk-640', 'c-old', ts, ts);
    database.prepare('INSERT INTO question_batches (id, session_id, input, created_at) VALUES (?, ?, ?, ?)').run('b-old', 's-old', '{}', ts);
    expect(migrate(database, shipped).applied).toEqual(shipped.filter((m) => m.version > 8).map((m) => m.version));
    expect(columnsOf(database, 'sessions')).toContain('closed_at');
    expect(columnsOf(database, 'question_batches')).toContain('closed_reason');
    expect(database.prepare('SELECT id, closed_at FROM sessions').all()).toEqual([{ id: 's-old', closed_at: null }]);
    expect(database.prepare('SELECT id, closed_reason FROM question_batches').all()).toEqual([{ id: 'b-old', closed_reason: null }]);
    database.close();

    const store = await openStore(file);
    try {
      expect(await store.sessions.get('s-old')).toMatchObject({ closedAt: null });
      expect(await store.questions.getBatch('b-old')).toMatchObject({ closedReason: null });
      const closed = await store.sessions.update('s-old', { closedAt: ts });
      expect(closed).toMatchObject({ closedAt: ts });
      expect(await store.questions.closeUnanswered('b-old', 'session closed')).toMatchObject({ state: 'stale', closedReason: 'session closed' });
    } finally {
      await store.close();
    }
  });
});

describe('0012 session branching (D40)', () => {
  it('adds a nullable sessions.branching (JSON): existing sessions have none; the store round-trips it', async () => {
    const file = path.join(tmp, 'existing-branching.db');
    const database = await db(file);
    const shipped = await loadMigrations();
    expect(shipped.find((m) => m.version === 12)).toMatchObject({ name: 'session_branching' });
    migrate(database, shipped.filter((m) => m.version <= 11));
    const ts = '2026-09-29T10:00:00.000Z';
    database.prepare('INSERT INTO sessions (id, name, claude_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('s-old', 'free-talk-640', 'c-old', ts, ts);
    expect(migrate(database, shipped).applied).toEqual(shipped.filter((m) => m.version > 11).map((m) => m.version));
    expect(database.prepare('SELECT id, branching FROM sessions').all()).toEqual([{ id: 's-old', branching: null }]);
    database.close();

    const store = await openStore(file);
    try {
      expect(await store.sessions.get('s-old')).toMatchObject({ branching: null });
      const branching = { epic: { key: 'PROJ-3010', summary: 'Platform', branch: 'feature/PROJ-3010-Platform' }, base: 'dev', bases: { mobile: 'main' }, dropped: ['x'] };
      expect(await store.sessions.update('s-old', { branching })).toMatchObject({ branching });
    } finally {
      await store.close();
    }
  });
});

describe('0013 worktree parent (D47)', () => {
  it('adds the nullable parent columns to worktrees: existing rows have none; the store round-trips them', async () => {
    const file = path.join(tmp, 'existing-parent.db');
    const database = await db(file);
    const shipped = await loadMigrations();
    expect(shipped.find((m) => m.version === 13)).toMatchObject({ name: 'worktree_parent' });
    migrate(database, shipped.filter((m) => m.version <= 12));
    const ts = '2026-09-29T10:00:00.000Z';
    database
      .prepare('INSERT INTO worktrees (id, repo, repo_path, branch, path, removable, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
      .run('w-old', 'web-front', '/r/web-front', 'PROJ-1-x', '/r/web-front-wt-x', ts, ts);
    expect(migrate(database, shipped).applied).toEqual(shipped.filter((m) => m.version > 12).map((m) => m.version));
    expect(database.prepare('SELECT parent_branch, parent_pr_number, parent_pr_state, parent_base, parent_head_oid, parent_merge, parent_merged_at FROM worktrees').all()).toEqual([
      { parent_branch: null, parent_pr_number: null, parent_pr_state: null, parent_base: null, parent_head_oid: null, parent_merge: null, parent_merged_at: null },
    ]);
    database.close();

    const store = await openStore(file);
    try {
      expect(await store.worktrees.get('w-old')).toMatchObject({ parentBranch: null, parentMergedAt: null });
      const parent = { parentBranch: 'PROJ-3013-x', parentPrNumber: 306, parentPrUrl: 'https://x/306', parentPrState: 'MERGED', parentBase: 'dev', parentHeadOid: 'abc1234', parentMerge: 'squash', parentMergedAt: ts };
      expect(await store.worktrees.update('w-old', parent)).toMatchObject(parent);
    } finally {
      await store.close();
    }
  });
});

describe('0014 worktree parent closed (D47 ruling)', () => {
  it('adds a nullable worktrees.parent_closed_at: existing rows have none; the store round-trips it', async () => {
    const file = path.join(tmp, 'existing-parent-closed.db');
    const database = await db(file);
    const shipped = await loadMigrations();
    expect(shipped.find((m) => m.version === 14)).toMatchObject({ name: 'worktree_parent_closed' });
    migrate(database, shipped.filter((m) => m.version <= 13));
    const ts = '2026-09-29T10:00:00.000Z';
    database
      .prepare('INSERT INTO worktrees (id, repo, repo_path, branch, path, removable, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
      .run('w-old', 'web-front', '/r/web-front', 'PROJ-1-x', '/r/web-front-wt-x', ts, ts);
    expect(migrate(database, shipped).applied).toEqual(shipped.filter((m) => m.version > 13).map((m) => m.version));
    expect(database.prepare('SELECT parent_closed_at FROM worktrees').all()).toEqual([{ parent_closed_at: null }]);
    database.close();
    const store = await openStore(file);
    try {
      expect(await store.worktrees.update('w-old', { parentClosedAt: ts })).toMatchObject({ parentClosedAt: ts });
    } finally {
      await store.close();
    }
  });
});

describe('0015 session context (D49)', () => {
  it('adds a nullable sessions.context: existing rows have none; the store round-trips the JSON', async () => {
    const file = path.join(tmp, 'existing-context.db');
    const database = await db(file);
    const shipped = await loadMigrations();
    expect(shipped.find((m) => m.version === 15)).toMatchObject({ name: 'session_context' });
    migrate(database, shipped.filter((m) => m.version <= 14));
    const ts = '2026-09-29T10:00:00.000Z';
    database.prepare('INSERT INTO sessions (id, name, claude_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('s-old', 'old', 'c-old', ts, ts);
    expect(migrate(database, shipped).applied).toEqual(shipped.filter((m) => m.version > 14).map((m) => m.version));
    expect(database.prepare('SELECT context FROM sessions').all()).toEqual([{ context: null }]);
    database.close();
    const store = await openStore(file);
    try {
      expect(await store.sessions.get('s-old')).toMatchObject({ context: null });
      const context = { ...EMPTY_CONTEXT, tokens: 124_000, model: 'claude-opus-4-7', windows: { 'claude-opus-4-7': 200_000 }, updatedAt: ts };
      expect(await store.sessions.update('s-old', { context })).toMatchObject({ context });
    } finally {
      await store.close();
    }
  });
});

describe('0021 sidebar subfolders (D58)', () => {
  it("on top of 0019 with D54 folders: every folder stays top level with its places; parent_id nests, with no self-parent and a cascade", async () => {
    const file = path.join(tmp, 'switchboard.db');
    const database = await db(file);
    const shipped = await loadMigrations();
    migrate(database, shipped.filter((m) => m.version <= 19));
    const ts = '2026-09-29T10:00:00.000Z';
    database.prepare('INSERT INTO sessions (id, name, claude_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('s1', 'one', 'c1', ts, ts);
    const folder = database.prepare('INSERT INTO sidebar_folders (id, name, position, collapsed, created_at) VALUES (?, ?, ?, ?, ?)');
    folder.run('fa', 'Work', 0, 0, ts);
    folder.run('fb', 'Later', 1, 1, ts);
    const place = database.prepare('INSERT INTO sidebar_places (session_id, folder_id, position) VALUES (?, ?, ?)');
    place.run('s1', 'fb', 0);
    place.run('r~abcdefghijkl~x', null, 0);
    expect(migrate(database, shipped).applied).toEqual(shipped.filter((m) => m.version > 19).map((m) => m.version));
    expect(database.prepare('SELECT id, name, position, collapsed, created_at, parent_id FROM sidebar_folders ORDER BY position').all()).toEqual([
      { id: 'fa', name: 'Work', position: 0, collapsed: 0, created_at: ts, parent_id: null },
      { id: 'fb', name: 'Later', position: 1, collapsed: 1, created_at: ts, parent_id: null },
    ]);
    expect(database.prepare('SELECT session_id, folder_id, position FROM sidebar_places ORDER BY session_id').all()).toEqual([
      { session_id: 'r~abcdefghijkl~x', folder_id: null, position: 0 },
      { session_id: 's1', folder_id: 'fb', position: 0 },
    ]);
    const parent = database.prepare(`SELECT type, "notnull", dflt_value FROM pragma_table_info('sidebar_folders') WHERE name = 'parent_id'`).get();
    expect(parent).toEqual({ type: 'TEXT', notnull: 0, dflt_value: null });
    // Nesting: a known parent only, never itself.
    database.prepare("UPDATE sidebar_folders SET parent_id = 'fa' WHERE id = 'fb'").run();
    expect(() => database.prepare("UPDATE sidebar_folders SET parent_id = 'gone' WHERE id = 'fb'").run()).toThrow(/FOREIGN KEY/);
    expect(() => database.prepare("UPDATE sidebar_folders SET parent_id = 'fa' WHERE id = 'fa'").run()).toThrow(/CHECK/);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    database.close();
    // The repository reads the tree (fb is now inside fa).
    const store = await openStore(file);
    try {
      expect(await store.sidebar.read()).toEqual({
        pinned: ['r~abcdefghijkl~x'],
        folders: [
          { id: 'fa', name: 'Work', collapsed: false, sessionIds: [], parentId: null },
          { id: 'fb', name: 'Later', collapsed: true, sessionIds: ['s1'], parentId: 'fa' },
        ],
      });
    } finally {
      await store.close();
    }
  });
});

describe('0003 folders (D14)', () => {
  /** A database at version 2 (before D14), with what a pre-D14 install holds. */
  async function beforeD14(settingValue: unknown | undefined) {
    const database = await db();
    const shipped = await loadMigrations();
    migrate(database, shipped.filter((m) => m.version <= 2));
    const ts = '2026-09-27T10:00:00.000Z';
    if (settingValue !== undefined) {
      database.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('setup.workspaceRoot', JSON.stringify(settingValue), ts);
    }
    const insert = database.prepare('INSERT INTO sessions (id, name, claude_session_id, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('s-root', 'at-root', 'c-root', '/Users/dev/ws', ts, ts);
    insert.run('s-elsewhere', 'elsewhere', 'c-else', '/Users/dev/other root', ts, ts);
    insert.run('s-never', 'never-started', 'c-never', null, ts, ts);
    database.prepare('INSERT INTO schedules (id, name, cron, template, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('sch', 'nightly', '0 2 * * *', '{}', ts, ts);
    return { database, shipped };
  }

  it('moves a saved setup.workspaceRoot into the list as the default workspace; sessions and schedules get their folder', async () => {
    const { database, shipped } = await beforeD14('/Users/dev/ws');
    expect(migrate(database, shipped).applied).toEqual(shipped.filter((m) => m.version > 2).map((m) => m.version));
    const folders = database.prepare('SELECT id, path, canonical_path, kind, is_default, last_used_at FROM folders').all();
    expect(folders).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), path: '/Users/dev/ws', canonical_path: '/Users/dev/ws', kind: 'workspace', is_default: 1, last_used_at: null }]);
    const id = folders[0]?.['id'];
    const sessions = database.prepare('SELECT id, folder_id, root, root_kind FROM sessions ORDER BY id').all();
    expect(sessions).toEqual([
      { id: 's-elsewhere', folder_id: null, root: '/Users/dev/other root', root_kind: 'workspace' },
      { id: 's-never', folder_id: null, root: null, root_kind: null },
      { id: 's-root', folder_id: id, root: '/Users/dev/ws', root_kind: 'workspace' },
    ]);
    expect(database.prepare('SELECT folder_id FROM schedules').get()).toEqual({ folder_id: id });
    // The setting stays (unread); the schema keeps foreign keys and one default at most.
    expect(database.prepare("SELECT value FROM settings WHERE key = 'setup.workspaceRoot'").get()).toEqual({ value: '"/Users/dev/ws"' });
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(() => database.prepare("INSERT INTO folders (id, path, canonical_path, kind, is_default, added_at) VALUES ('x', '/b', '/b', 'repo', 1, 'now')").run()).toThrow(/UNIQUE/);
    expect(() => database.prepare("INSERT INTO folders (id, path, canonical_path, kind, is_default, added_at) VALUES ('y', '/c', '/c', 'other', 0, 'now')").run()).toThrow(/CHECK/);
  });

  it('without a saved root: no folder; sessions still remember their root', async () => {
    const { database, shipped } = await beforeD14(undefined);
    migrate(database, shipped);
    expect(database.prepare('SELECT COUNT(*) AS n FROM folders').get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT folder_id, root, root_kind FROM sessions WHERE id = 's-root'").get()).toEqual({ folder_id: null, root: '/Users/dev/ws', root_kind: 'workspace' });
    expect(database.prepare('SELECT folder_id FROM schedules').get()).toEqual({ folder_id: null });
  });

  it('ignores a stored root that is not a path string', async () => {
    const { database, shipped } = await beforeD14(42);
    migrate(database, shipped);
    expect(database.prepare('SELECT COUNT(*) AS n FROM folders').get()).toEqual({ n: 0 });
  });
});

describe('openStore on a temp file', () => {
  it('creates the file (and its folder), applies the migrations and uses WAL + foreign keys', async () => {
    const file = storeFile(path.join(tmp, 'nested', 'data'));
    const store = await openStore(file, { now: () => new Date('2026-09-28T01:02:03.004Z') });
    const shipped = await loadMigrations();
    try {
      expect(store.migrations.applied).toEqual(shipped.map((m) => m.version));
      expect(store.migrations.version).toBe(shipped[shipped.length - 1]?.version);
      expect(appliedMigrations(store.db)[0]).toEqual(
        { version: 1, name: 'initial', checksum: checksumOf(await readFile(path.join(MIGRATIONS_DIR, '0001_initial.sql'), 'utf8')), appliedAt: '2026-09-28T01:02:03.004Z' },
      );
      expect(appliedMigrations(store.db)).toEqual(
        shipped.map((m) => ({ version: m.version, name: m.name, checksum: m.checksum, appliedAt: '2026-09-28T01:02:03.004Z' })),
      );
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
    const latest = (await loadMigrations()).at(-1)?.version;
    expect(migrate(first.db, await loadMigrations())).toEqual({ applied: [], version: latest });
    await first.close();

    const second = await openStore(file, { now: () => new Date('2027-01-01T00:00:00.000Z') });
    try {
      expect(second.migrations).toEqual({ applied: [], version: latest });
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

  it('accepts a legacy checksum for a reworded shipped migration, and nothing else (0002, 2026-09-30)', async () => {
    const shipped = await loadMigrations();
    const database = await db();
    migrate(database, shipped);
    // A database that ran 0002 before its example tool was renamed carries the old checksum.
    const [legacy] = LEGACY_CHECKSUMS.get(2) ?? [];
    expect(legacy).toMatch(/^[0-9a-f]{64}$/);
    database.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 2').run(legacy as string);
    expect(migrate(database, shipped).applied).toEqual([]);
    // Any other checksum is still an edited migration.
    database.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 2').run('0'.repeat(64));
    expect(() => migrate(database, shipped)).toThrow(/migration 2 \(default_tools\) was changed after it was applied/);
    // A legacy checksum only counts for its own version.
    database.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 2').run(checksumOf(shipped[1]?.sql as string));
    database.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 3').run(legacy as string);
    expect(() => migrate(database, shipped)).toThrow(/migration 3 \(folders\) was changed after it was applied/);
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

describe('0022 plain folders (D59)', () => {
  /** sha256 of every migration shipped before D59 (as on master before this change): editing one stops existing installs. */
  const SHIPPED_BEFORE_D59: ReadonlyArray<readonly [string, string]> = [
    ['0001_initial.sql', 'fd797d41e9fc0f5db3856037a03bd8482c489a158de960764486e55a0dde45e2'],
    ['0002_default_tools.sql', 'e736499c8c9891496fb64772c95de472b5712afbdc8d9bcc9874ea958409e76e'],
    ['0003_folders.sql', '161edafd1242fa1e848190eaf6e8f516368230e6f1c4dd7a09cf52407f5d9a61'],
    ['0004_session_origin.sql', 'b6c744d4b09466347aef050948fad6c41c9a611e5fe8080d6cca1b412d49f128'],
    ['0005_folder_label.sql', 'a3fe407934264578c0855dd85ad05b51a568312b2541c9ff1a1b99f2b7831040'],
    ['0006_session_title.sql', '7f3c34842bbfc876200ce831ca0caf0d76b803a533bd974efd28a794e94b7e3f'],
    ['0007_session_remote.sql', '096055a188e46e33f0aebc8da9e675f01f0d18719350b3b3d390ead0578f774d'],
    ['0008_session_remote_source.sql', '99889c3e9579fc0c2cf78a482351f04cc38986e454f4fd511b6bd4e0087b7867'],
    ['0009_session_model.sql', 'b496455743f9f86f8e588e5b7ddbbbd016af3322e286457c8c22d3ee63255630'],
    ['0010_session_closed.sql', '658315a5c0fec18fddea8302c6502d7b3d59862de123f5fd7e8e10e34d8a780e'],
    ['0011_session_branch.sql', 'f341222321d64382190f6978293ee4862ccc254be91fdb855a9cfa5c6a55350c'],
    ['0012_session_branching.sql', '2789ddb2046e1cbb9a5932c1504630b432f6a8caf6bced89980a5227fa8da66a'],
    ['0013_worktree_parent.sql', '04d4fe06ea679ffdb62d20bc979970acc0187cb7340c014c261b26221ff6e751'],
    ['0014_worktree_parent_closed.sql', '4ab9b10d2ba75fe91011927e4d745d599ab0bbe50a0e3653de4ee3e8064c734b'],
    ['0015_session_context.sql', 'df7815b012f8fdf11a8a599d4ab849cbc183255b25ca72497ac44ea93ec0fe20'],
    ['0016_machines.sql', '2f0eb44ece7b636d63775c39eb031f52aceb059372ceeb64973237ca6e77aa1b'],
    ['0017_hooked_sessions.sql', '72a93c52af27733120f5e6578d74e5f412d636264feaf5e5ccd208d6aab53485'],
    ['0018_peer_snapshots.sql', '321e7d8cb5f489223716c807f7b1748682d8b6bf4449f65cd099a98e60505b62'],
    ['0019_sidebar_layout.sql', 'a734ca537d8b2fed7542704469fd8b46754ae1acf04807165e965b4d96f50891'],
    ['0020_attachments.sql', 'e4ded7214a6486f5641d94e68d1b20df8dbc656797418467df8895d308e1a6cf'],
    ['0021_sidebar_subfolders.sql', '6d0f5f1d8e83bc77e47fe97b0e575ee5cb15048a9999b2b1238ddd6443c45eb2'],
  ];

  const insertFolder = 'INSERT INTO folders (id, path, canonical_path, kind, is_default, added_at, last_used_at, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

  /** Every row of `table` in rowid order, rowid included (a table rebuild must keep them). */
  function rowsOf(database: DatabaseSync, table: string): unknown[] {
    return database.prepare(`SELECT rowid AS _rowid, * FROM ${table} ORDER BY rowid`).all();
  }

  /** Every user table's rows, by name. */
  function dump(database: DatabaseSync): Record<string, unknown[]> {
    const tables = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name`).all();
    return Object.fromEntries(tables.map((row) => [String(row['name']), rowsOf(database, String(row['name']))]));
  }

  it('leaves every earlier migration file as it was shipped (checksums)', async () => {
    const shipped = await loadMigrations();
    for (const [file, checksum] of SHIPPED_BEFORE_D59) {
      expect(checksumOf(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8')), file).toBe(checksum);
      expect(shipped.find((m) => `${String(m.version).padStart(4, '0')}_${m.name}.sql` === file)?.checksum, file).toBe(checksum);
    }
    const plain = shipped.find((m) => m.name === 'plain_folders');
    expect(plain?.version).toBe(22);
    expect(needsForeignKeysOff(plain as Migration)).toBe(true);
    expect(shipped.filter((m) => needsForeignKeysOff(m)).map((m) => m.version)).toEqual([22]);
  });

  it('a fresh database: folders.kind takes plain (and nothing else new); the indexes and the references to folders are kept', async () => {
    const database = await db();
    migrate(database, await loadMigrations());
    const insert = database.prepare(insertFolder);
    insert.run('w', '/w', '/w', 'workspace', 1, 'now', null, null);
    insert.run('r', '/r', '/r', 'repo', 0, 'now', null, 'Tools');
    insert.run('p', '/p', '/p', 'plain', 0, 'now', null, null);
    expect(() => insert.run('x', '/x', '/x', 'bogus', 0, 'now', null, null)).toThrow(/CHECK/);
    expect(() => insert.run('d', '/d', '/d', 'plain', 1, 'now', null, null)).toThrow(/UNIQUE/);
    expect(() => insert.run('l', '/l', '/l', 'plain', 0, 'now', null, 'tools')).toThrow(/UNIQUE/);
    expect(() => insert.run('c', '/c', '/p', 'plain', 0, 'now', null, null)).toThrow(/UNIQUE/);
    const indexes = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'folders' AND sql IS NOT NULL ORDER BY name`).all();
    expect(indexes.map((row) => row['name'])).toEqual(['folders_default', 'folders_label']);
    expect(database.prepare(`SELECT "table", "from", on_delete FROM pragma_foreign_key_list('sessions') WHERE "table" = 'folders'`).all()).toEqual([{ table: 'folders', from: 'folder_id', on_delete: 'SET NULL' }]);
    expect(database.prepare(`SELECT "table", "from", on_delete FROM pragma_foreign_key_list('schedules') WHERE "table" = 'folders'`).all()).toEqual([{ table: 'folders', from: 'folder_id', on_delete: 'SET NULL' }]);
    // The new table enforces them: removing a folder unlinks its sessions; an unknown folder id is refused.
    const ts = 'now';
    database.prepare('INSERT INTO sessions (id, name, claude_session_id, cwd, root, root_kind, folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('s', 'n', 'c', '/p', '/p', null, 'p', ts, ts);
    expect(() => database.prepare('INSERT INTO sessions (id, name, claude_session_id, folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('s2', 'n2', 'c2', 'nope', ts, ts)).toThrow(/FOREIGN KEY/);
    database.prepare("DELETE FROM folders WHERE id = 'p'").run();
    expect(database.prepare("SELECT folder_id, root, root_kind FROM sessions WHERE id = 's'").get()).toEqual({ folder_id: null, root: '/p', root_kind: null });
    // sessions.root_kind keeps 0003's CHECK: a plain session stores NULL (the repository maps it).
    expect(() => database.prepare("UPDATE sessions SET root_kind = 'plain' WHERE id = 's'").run()).toThrow(/CHECK/);
  });

  it('on top of every earlier migration with folders, sessions and schedules: every row, rowid and link is kept; foreign keys are back on', async () => {
    const database = await db();
    const shipped = await loadMigrations();
    migrate(database, shipped.filter((m) => m.version < 22));
    const ts = '2026-09-30T10:00:00.000Z';
    const insert = database.prepare(insertFolder);
    // Added out of id order, so the rowid order (the list's last tie-break) differs from the ids'.
    insert.run('f-ws', '/Users/dev/ws', '/Users/dev/ws', 'workspace', 1, ts, ts, null);
    insert.run('c-repo', '/Users/dev/tool', '/real/tool', 'repo', 0, ts, null, 'Tools');
    insert.run('a-repo', '/Users/dev/other', '/Users/dev/other', 'repo', 0, ts, null, null);
    const session = database.prepare('INSERT INTO sessions (id, name, claude_session_id, cwd, root, root_kind, folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    session.run('s-ws', 'ws', 'c1', '/Users/dev/ws', '/Users/dev/ws', 'workspace', 'f-ws', ts, ts);
    session.run('s-repo', 'repo', 'c2', '/real/tool', '/real/tool', 'repo', 'c-repo', ts, ts);
    session.run('s-gone', 'gone', 'c3', '/Users/dev/gone', '/Users/dev/gone', 'workspace', null, ts, ts);
    database.prepare('INSERT INTO events (session_id, ts, kind, label) VALUES (?, ?, ?, ?)').run('s-repo', ts, 'text', 'hello');
    database.prepare('INSERT INTO schedules (id, name, cron, template, folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('sch', 'nightly', '0 2 * * *', '{}', 'c-repo', ts, ts);
    database.prepare('INSERT INTO schedules (id, name, cron, template, folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('sch2', 'weekly', '0 3 * * 1', '{}', 'f-ws', ts, ts);
    const before = dump(database);
    const schemaBefore = schemaDump(database).filter((line) => !/ folders(_default|_label)?: /.test(line));

    // D62: later migrations (0023) are this test's concern no more: up to 0022.
    const upTo22 = shipped.filter((m) => m.version <= 22);
    expect(migrate(database, upTo22).applied).toEqual([22]);
    expect(dump(database)).toEqual(before);
    expect(rowsOf(database, 'folders').map((row) => (row as { id: string }).id)).toEqual(['f-ws', 'c-repo', 'a-repo']);
    // Nothing but the folders table (and its indexes) changed in the schema.
    expect(schemaDump(database).filter((line) => !/ folders(_default|_label)?: /.test(line))).toEqual(schemaBefore);
    expect(String(database.prepare(`SELECT sql FROM sqlite_master WHERE name = 'folders'`).get()?.['sql'])).toContain("CHECK (kind IN ('workspace', 'repo', 'plain'))");
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    // The links still work both ways after the rebuild.
    database.prepare("DELETE FROM schedules WHERE folder_id = 'c-repo'").run();
    database.prepare("DELETE FROM folders WHERE id = 'c-repo'").run();
    expect(database.prepare("SELECT folder_id FROM sessions WHERE id = 's-repo'").get()).toEqual({ folder_id: null });
    expect(database.prepare("SELECT count(*) AS n FROM events WHERE session_id = 's-repo'").get()).toEqual({ n: 1 });
    // Running again is a no-op.
    expect(migrate(database, upTo22).applied).toEqual([]);
  });

  it('a copy of a realistic database (the demo fixtures + saved folders, sessions, schedules, worktrees) keeps every row', async () => {
    const shipped = await loadMigrations();
    const file = path.join(tmp, 'realistic', 'switchboard.db');
    const earlier = await openStore(file, { migrations: shipped.filter((m) => m.version < 22) });
    try {
      await seedDemo(earlier, await loadDemoData(), { now: new Date('2026-09-28T12:00:00.000Z') });
      const repo = await earlier.folders.create({ path: '/Users/dev/tool', canonicalPath: '/real/tool', kind: 'repo', label: 'Tools' });
      await earlier.folders.markUsed(repo.id);
      const made = await earlier.sessions.create({ name: 'tool-work', claudeSessionId: 'c-tool', cwd: '/real/tool', root: '/real/tool', rootKind: 'repo', folderId: repo.id });
      await earlier.worktrees.create({ repo: 'tool', repoPath: '/real/tool', branch: 'sb/tool-work', path: '/real/tool-wt-tool-work', sessionId: made.id });
      await earlier.schedules.create({ name: 'nightly-tool', cron: '0 2 * * *', template: { name: 'nightly-tool' }, folderId: repo.id });
    } finally {
      await earlier.close();
    }
    // Migrate a copy, as an existing install's file would be.
    const copy = path.join(tmp, 'copy', 'switchboard.db');
    await mkdir(path.dirname(copy), { recursive: true });
    const source = await db(file);
    source.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
    const before = dump(source);
    expect(before['folders']?.length).toBeGreaterThanOrEqual(2);
    expect(before['sessions']?.length).toBeGreaterThanOrEqual(7);

    const store = await openStore(copy, { migrations: shipped.filter((m) => m.version <= 22) });
    try {
      expect(store.migrations.applied).toEqual([22]);
      expect(dump(store.db)).toEqual(before);
      expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(store.db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      // The repositories read it as before, and take a plain folder and a plain session now.
      expect((await store.folders.list()).map((f) => f.kind).sort()).toEqual(['repo', 'workspace']);
      const plain = await store.folders.create({ path: '/Users/dev/notes', canonicalPath: '/Users/dev/notes', kind: 'plain' });
      const session = await store.sessions.create({ name: 'notes', claudeSessionId: 'c-notes', cwd: plain.canonicalPath, root: plain.canonicalPath, rootKind: 'plain', folderId: plain.id });
      expect(session.rootKind).toBe('plain');
      expect(store.db.prepare('SELECT root_kind FROM sessions WHERE id = ?').get(session.id)).toEqual({ root_kind: null });
      expect((await store.sessions.list()).find((s) => s.id === session.id)?.rootKind).toBe('plain');
      // A session that never started (no root) stays without a kind.
      const idle = await store.sessions.create({ name: 'idle', claudeSessionId: 'c-idle' });
      expect(idle.rootKind).toBeNull();
    } finally {
      await store.close();
    }
  });

  it('the runner: a foreign_keys=off migration drops a referenced table without touching its children, and a violation still rolls back', async () => {
    const base = [makeMigration(1, 'base', 'CREATE TABLE p (id TEXT PRIMARY KEY) STRICT; CREATE TABLE c (id TEXT PRIMARY KEY, p_id TEXT REFERENCES p (id) ON DELETE SET NULL) STRICT; INSERT INTO p VALUES (\'a\'); INSERT INTO c VALUES (\'x\', \'a\');')];
    const rebuild = makeMigration(2, 'rebuild', `${FOREIGN_KEYS_OFF}\nCREATE TABLE p_new (id TEXT PRIMARY KEY, note TEXT) STRICT;\nINSERT INTO p_new (id) SELECT id FROM p;\nDROP TABLE p;\nALTER TABLE p_new RENAME TO p;\n`);
    const database = await db();
    migrate(database, base);
    expect(migrate(database, [...base, rebuild]).applied).toEqual([2]);
    expect(database.prepare('SELECT p_id FROM c').get()).toEqual({ p_id: 'a' });
    expect(database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    // Without the directive the same drop would have run the children's ON DELETE action.
    const other = await db(path.join(tmp, 'other.db'));
    migrate(other, base);
    migrate(other, [...base, makeMigration(2, 'rebuild', rebuild.sql.split('\n').slice(1).join('\n'))]);
    expect(other.prepare('SELECT p_id FROM c').get()).toEqual({ p_id: null });
    // A rebuild that leaves a dangling reference is rolled back, and foreign keys are on again.
    const broken = makeMigration(2, 'broken', `${FOREIGN_KEYS_OFF}\nCREATE TABLE p_new (id TEXT PRIMARY KEY) STRICT;\nDROP TABLE p;\nALTER TABLE p_new RENAME TO p;\n`);
    const third = await db(path.join(tmp, 'third.db'));
    migrate(third, base);
    expect(() => migrate(third, [...base, broken])).toThrow(/foreign key violations/);
    expect(third.prepare('SELECT id FROM p').all()).toEqual([{ id: 'a' }]);
    expect(third.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });
});

describe('0023 session provider (D62)', () => {
  function rowsOf(database: DatabaseSync, table: string): unknown[] {
    return database.prepare(`SELECT rowid AS _rowid, * FROM ${table} ORDER BY rowid`).all();
  }

  function dump(database: DatabaseSync): Record<string, unknown[]> {
    const tables = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name`).all();
    return Object.fromEntries(tables.map((row) => [String(row['name']), rowsOf(database, String(row['name']))]));
  }

  it('on a database with sessions: every existing session runs on Claude Code; the new tables start empty; earlier rows are kept', async () => {
    const shipped = await loadMigrations();
    const file = path.join(tmp, 'd62', 'switchboard.db');
    const earlier = await openStore(file, { migrations: shipped.filter((m) => m.version < 23) });
    try {
      await seedDemo(earlier, await loadDemoData(), { now: new Date('2026-09-28T12:00:00.000Z') });
      await earlier.sessions.create({ name: 'older', claudeSessionId: 'c-older' });
    } finally {
      await earlier.close();
    }
    const source = await db(file);
    const before = dump(source);
    source.close();
    // D63: later migrations (0024) are their own test's concern: up to 0023.
    const store = await openStore(file, { migrations: shipped.filter((m) => m.version <= 23) });
    try {
      expect(store.migrations.applied).toEqual([23]);
      const sessions = await store.sessions.list();
      expect(sessions.length).toBe(before['sessions']?.length);
      expect(new Set(sessions.map((session) => session.provider))).toEqual(new Set(['claude']));
      // Every column the sessions had keeps its value.
      const after = dump(store.db);
      expect((after['sessions'] ?? []).map((row) => ({ ...(row as Record<string, unknown>), provider: undefined }))).toEqual(
        (before['sessions'] ?? []).map((row) => ({ ...(row as Record<string, unknown>), provider: undefined })),
      );
      expect(rowsOf(store.db, 'session_providers')).toEqual([]);
      expect(rowsOf(store.db, 'provider_switches')).toEqual([]);
      // The CHECK refuses an unknown CLI; the repository keeps each CLI's own id and the switches.
      const one = sessions[0]!;
      expect(() => store.db.prepare("UPDATE sessions SET provider = 'gpt' WHERE id = ?").run(one.id)).toThrow(/CHECK/);
      await store.providers.rememberNative(one.id, 'codex', 'thread-1');
      await store.providers.rememberNative(one.id, 'codex', 'thread-2');
      expect(await store.providers.nativeId(one.id, 'codex')).toBe('thread-2');
      expect(await store.providers.sessionByNative('codex', 'thread-2')).toBe(one.id);
      const started = await store.providers.createSwitch(one.id, 'claude', 'codex');
      expect(started).toMatchObject({ from: 'claude', to: 'codex', status: 'running', handoverBy: null });
      await store.providers.updateSwitch(started.id, { status: 'done', handoverBy: 'history', exportPath: '/x.md', finishedAt: '2026-10-01T00:00:00.000Z' });
      expect(await store.providers.listSwitches(one.id)).toEqual([expect.objectContaining({ status: 'done', handoverBy: 'history', exportPath: '/x.md' })]);
      // Deleting the session takes its rows along.
      await store.sessions.delete(one.id);
      expect(rowsOf(store.db, 'session_providers')).toEqual([]);
      expect(rowsOf(store.db, 'provider_switches')).toEqual([]);
    } finally {
      await store.close();
    }
  });
});

describe('0024 CLI accounts (D63)', () => {
  it('on a database with sessions and usage readings: every session and reading is the Default\'s; the three Default profiles exist; earlier rows are kept', async () => {
    const shipped = await loadMigrations();
    const file = path.join(tmp, 'd63', 'switchboard.db');
    const earlier = await openStore(file, { migrations: shipped.filter((m) => m.version < 24) });
    try {
      await seedDemo(earlier, await loadDemoData(), { now: new Date('2026-09-28T12:00:00.000Z') });
      await earlier.sessions.create({ name: 'older-claude', claudeSessionId: 'c-older' });
      await earlier.sessions.create({ name: 'older-codex', claudeSessionId: 'c-codex', provider: 'codex' });
      await earlier.usage.add({ source: 'get_usage', sessionId: null, fiveHourPct: 12, fiveHourResetsAt: null, sevenDayPct: null, sevenDayResetsAt: null, raw: {} });
    } finally {
      await earlier.close();
    }
    const source = await db(file);
    const sessionsBefore = source.prepare('SELECT COUNT(*) AS n FROM sessions').get()?.['n'];
    source.close();
    // D65: later migrations (0025) are their own test's concern: up to 0024.
    const store = await openStore(file, { migrations: shipped.filter((m) => m.version <= 24) });
    try {
      expect(store.migrations.applied).toEqual([24]);
      expect((await store.profiles.list()).map((p) => [p.id, p.cli, p.name, p.dir, p.builtin, p.enabled, p.position])).toEqual([
        ['default-claude', 'claude', 'Default', null, true, true, 0],
        ['default-codex', 'codex', 'Default', null, true, true, 0],
        ['default-opencode', 'opencode', 'Default', null, true, true, 0],
      ]);
      const sessions = await store.sessions.list();
      expect(sessions).toHaveLength(Number(sessionsBefore));
      // Every existing session is on the Default of its CLI, unpinned.
      for (const session of sessions) {
        expect(session.profileId).toBe(`default-${session.provider}`);
        expect(session.profilePinned).toBe(false);
      }
      expect(sessions.find((s) => s.name === 'older-codex')?.profileId).toBe('default-codex');
      expect((await store.usage.latest())?.profileId).toBe('default-claude');
      expect((await store.usage.latest(undefined, 'default-claude'))?.fiveHourPct).toBe(12);
      // The CHECK refuses an unknown CLI; a new profile goes last in its CLI's order; a session's profile is free text (a deleted profile is set back to NULL by the service).
      expect(() => store.db.prepare("INSERT INTO cli_profiles (id, cli, name, position, created_at) VALUES ('x', 'nope', 'X', 0, 'now')").run()).toThrow();
      const added = await store.profiles.create({ cli: 'codex', name: 'Second' });
      expect(added).toMatchObject({ position: 1, enabled: true, shareSettings: true, builtin: false });
      await store.profiles.reorder('codex', [added.id]);
      expect((await store.profiles.list('codex')).map((p) => p.name)).toEqual(['Second', 'Default']);
    } finally {
      await store.close();
    }
  });
});

describe('0025 session take-over (D65)', () => {
  function dump(database: DatabaseSync): Record<string, unknown[]> {
    const tables = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name`).all();
    return Object.fromEntries(tables.map((row) => [String(row['name']), database.prepare(`SELECT rowid AS _rowid, * FROM ${String(row['name'])} ORDER BY rowid`).all()]));
  }

  it('adds moved_to / moved_from (NULL for every session that is there); the repository keeps them as JSON', async () => {
    const shipped = await loadMigrations();
    const file = path.join(tmp, 'd65', 'switchboard.db');
    const earlier = await openStore(file, { migrations: shipped.filter((m) => m.version < 25) });
    try {
      await seedDemo(earlier, await loadDemoData(), { now: new Date('2026-10-04T12:00:00.000Z') });
      await earlier.sessions.create({ name: 'older', claudeSessionId: 'c-older-65' });
    } finally {
      await earlier.close();
    }
    const source = await db(file);
    const before = dump(source);
    source.close();
    const store = await openStore(file);
    try {
      // D68: later migrations (0026) apply too; this test is about 0025.
      expect(store.migrations.applied[0]).toBe(25);
      const sessions = await store.sessions.list();
      expect(sessions.length).toBe(before['sessions']?.length);
      for (const session of sessions) expect([session.movedTo, session.movedFrom]).toEqual([null, null]);
      // Every column the sessions had keeps its value.
      const after = dump(store.db);
      const strip = (rows: readonly unknown[] | undefined) => (rows ?? []).map((row) => ({ ...(row as Record<string, unknown>), moved_to: undefined, moved_from: undefined }));
      expect(strip(after['sessions'])).toEqual(strip(before['sessions']));
      // The two moves round-trip.
      const one = sessions[0]!;
      const move = { machineId: 'abcdefghijkl', machineName: 'office-pc', sessionId: 'sid-1', at: '2026-10-04T12:00:00.000Z' };
      await store.sessions.update(one.id, { movedTo: move });
      expect((await store.sessions.get(one.id))?.movedTo).toEqual(move);
      await store.sessions.update(one.id, { movedTo: null, movedFrom: move });
      expect(await store.sessions.get(one.id)).toMatchObject({ movedTo: null, movedFrom: move });
    } finally {
      await store.close();
    }
  });
});
