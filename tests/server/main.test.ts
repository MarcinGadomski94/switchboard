import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DB_FILE, openDatabase } from '../../src/server/db/database.ts';
import { appliedMigrations, loadMigrations, makeMigration, migrate } from '../../src/server/db/migrate.ts';
import { TOKEN_FILE } from '../../src/server/token.ts';
import { TEST_PORTS, makeTempDir, rawRequest, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, spawnServer, startServer } from '../helpers/server-process.ts';

let tmp: string;
let server: ServerProcess | undefined;

beforeEach(async () => {
  tmp = await makeTempDir('main');
});
afterEach(async () => {
  await server?.stop();
  server = undefined;
  await removeTempDir(tmp);
});

describe('npm start entry point (src/server/main.ts)', () => {
  it('starts on 127.0.0.1 with a per-install token in SWITCHBOARD_DATA_DIR and stops cleanly', async () => {
    const dataDir = path.join(tmp, 'data');
    server = await startServer({ SWITCHBOARD_DATA_DIR: dataDir, SWITCHBOARD_WORKSPACE_ROOT: path.join(tmp, 'workspace') });
    const token = (await readFile(path.join(dataDir, TOKEN_FILE), 'utf8')).trim();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const host = `127.0.0.1:${server.port}`;

    const page = await rawRequest({ port: server.port, path: '/', headers: { host, 'sec-fetch-site': 'none' } });
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['set-cookie']).toEqual([`sb_token=${token}; Path=/; HttpOnly; SameSite=Strict`]);

    expect((await rawRequest({ port: server.port, path: '/api/sessions', headers: { host } })).status).toBe(401);
    expect((await rawRequest({ port: server.port, path: '/', headers: { host: `evil.example:${server.port}` } })).status).toBe(403);

    expect(await server.stop()).toBe(0);
  });

  it('keeps the token across restarts', async () => {
    const dataDir = path.join(tmp, 'data');
    server = await startServer({ SWITCHBOARD_DATA_DIR: dataDir });
    const first = await readFile(path.join(dataDir, TOKEN_FILE), 'utf8');
    await server.stop();
    server = await startServer({ SWITCHBOARD_DATA_DIR: dataDir });
    expect(await readFile(path.join(dataDir, TOKEN_FILE), 'utf8')).toBe(first);
  });

  it('creates and migrates <dataDir>/switchboard.db at startup and closes it on shutdown', async () => {
    const dataDir = path.join(tmp, 'data');
    server = await startServer({ SWITCHBOARD_DATA_DIR: dataDir });
    expect(await server.stop()).toBe(0);
    const db = new DatabaseSync(path.join(dataDir, DB_FILE), { readOnly: true });
    try {
      const shipped = await loadMigrations();
      expect(appliedMigrations(db).map((m) => [m.version, m.checksum])).toEqual(shipped.map((m) => [m.version, m.checksum]));
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`).get()).toEqual({ name: 'sessions' });
    } finally {
      db.close();
    }
  });

  it('exits 1 with a message when the database was made by a newer build', async () => {
    const dataDir = path.join(tmp, 'data');
    const db = await openDatabase(path.join(dataDir, DB_FILE));
    migrate(db, [...(await loadMigrations()), makeMigration(9999, 'future', 'CREATE TABLE future (id INTEGER) STRICT;')]);
    db.close();
    const bad = spawnServer(TEST_PORTS[TEST_PORTS.length - 1]!, { SWITCHBOARD_DATA_DIR: dataDir }); // exits before it binds
    expect(await bad.closed).toBe(1);
    expect(bad.output()).toContain('switchboard: the database has migration 9999 (future)');
    expect(bad.output()).not.toContain('Server listening');
  });

  it('SWITCHBOARD_DEMO=1 seeds a throwaway data folder once, and the API still answers through the real routes', async () => {
    const dataDir = path.join(tmp, 'data');
    server = await startServer({ SWITCHBOARD_DATA_DIR: dataDir, SWITCHBOARD_DEMO: '1' });
    const token = (await readFile(path.join(dataDir, TOKEN_FILE), 'utf8')).trim();
    const host = `127.0.0.1:${server.port}`;
    const sessions = await rawRequest({ port: server.port, path: '/api/sessions', headers: { host, cookie: `sb_token=${token}` } });
    expect(sessions.status).toBe(200); // the demo feeds the DB; the real route (M2.1) reads it
    expect((JSON.parse(sessions.body) as unknown[]).length).toBe(6);
    expect(await server.stop()).toBe(0);
    server = await startServer({ SWITCHBOARD_DATA_DIR: dataDir, SWITCHBOARD_DEMO: '1' }); // second start: no-op
    expect(await server.stop()).toBe(0);
    server = undefined;

    const db = new DatabaseSync(path.join(dataDir, DB_FILE), { readOnly: true });
    try {
      expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 6 });
      expect(db.prepare(`SELECT value FROM settings WHERE key = 'demo.seed'`).get()).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('without SWITCHBOARD_DEMO the database stays empty', async () => {
    const dataDir = path.join(tmp, 'data');
    server = await startServer({ SWITCHBOARD_DATA_DIR: dataDir, SWITCHBOARD_DEMO: '0' });
    expect(await server.stop()).toBe(0);
    server = undefined;
    const db = new DatabaseSync(path.join(dataDir, DB_FILE), { readOnly: true });
    try {
      expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
      // Only the default tools of a fresh install (0002_default_tools.sql, M8.1), and no demo seed marker.
      expect(db.prepare('SELECT id FROM tools ORDER BY position').all()).toEqual([{ id: 'cm' }, { id: 'sw' }]);
      expect(db.prepare(`SELECT count(*) AS n FROM settings WHERE key = 'demo.seed'`).get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('exits 1 on an invalid SWITCHBOARD_PORT without binding anything', async () => {
    const dataDir = path.join(tmp, 'data');
    const bad = spawnServer('not-a-port', { SWITCHBOARD_DATA_DIR: dataDir });
    expect(await bad.closed).toBe(1);
    expect(bad.output()).toContain('SWITCHBOARD_PORT must be an integer');
    expect(bad.output()).not.toContain('Server listening');
  });
});
