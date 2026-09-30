import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/server/db/database.ts';
import {
  LEGACY_CHECKSUMS,
  MIGRATIONS_DIR,
  MigrationError,
  appliedMigrations,
  checksumOf,
  loadMigrations,
  makeMigration,
  migrate,
} from '../../../src/server/db/migrate.ts';
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
