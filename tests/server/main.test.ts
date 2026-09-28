import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DB_FILE, openDatabase } from '../../src/server/db/database.ts';
import { appliedMigrations, loadMigrations, makeMigration, migrate } from '../../src/server/db/migrate.ts';
import { TOKEN_FILE } from '../../src/server/token.ts';
import net from 'node:net';
import type { Tool } from '../../src/core/api.ts';
import { TEST_PORTS, makeTempDir, rawRequest, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, spawnServer, startServer } from '../helpers/server-process.ts';
import { htmlAnswer, startToolStub } from '../helpers/tool-stub.ts';

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
    server = await startServer({ SWITCHBOARD_DATA_DIR: dataDir });
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
    const bad = spawnServer(TEST_PORTS[TEST_PORTS.length - 1] as number, { SWITCHBOARD_DATA_DIR: dataDir });
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

  it('D15: the tools\' framing proxies start with the service, follow PUT /api/tools and stop with it; none in demo mode', async () => {
    const dataDir = path.join(tmp, 'data');
    const tool = await startToolStub(htmlAnswer('Framed tool', { 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY' }));
    try {
      server = await startServer({ SWITCHBOARD_DATA_DIR: dataDir });
      const token = (await readFile(path.join(dataDir, TOKEN_FILE), 'utf8')).trim();
      const api = (method: string, route: string, body?: unknown) =>
        fetch(`${server!.baseUrl}${route}`, {
          method,
          headers: { cookie: `sb_token=${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const tools = (await (await api('GET', '/api/tools')).json()) as Tool[];
      // Started with the service for the default Codebase Memory URL (never fetched here).
      expect(tools[0]?.frameUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(tools[1]?.frameUrl).toBeNull();
      const saved = (await (await api('PUT', '/api/tools', [{ ...tools[0], url: tool.origin }, tools[1]])).json()) as Tool[];
      const frameUrl = saved[0]!.frameUrl!;
      expect(frameUrl).not.toBe(tools[0]?.frameUrl);
      const framed = await fetch(frameUrl, { headers: { cookie: `sb_token=${token}` } });
      expect(framed.status).toBe(200);
      expect(await framed.text()).toContain('Framed tool');
      expect(framed.headers.get('x-frame-options')).toBeNull();
      expect(framed.headers.get('content-security-policy')).toBe(`frame-ancestors http://127.0.0.1:${server.port} http://localhost:${server.port}`);
      expect(tool.requests.at(-1)?.headers.cookie).toBeUndefined();

      expect(await server.stop()).toBe(0);
      server = undefined;
      const proxyPort = Number(new URL(frameUrl).port);
      const refused = await new Promise<boolean>((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port: proxyPort });
        socket.once('connect', () => {
          socket.destroy();
          resolve(false);
        });
        socket.once('error', () => resolve(true));
      });
      expect(refused).toBe(true);

      const demoDir = path.join(tmp, 'demo');
      server = await startServer({ SWITCHBOARD_DATA_DIR: demoDir, SWITCHBOARD_DEMO: '1' });
      const demoToken = (await readFile(path.join(demoDir, TOKEN_FILE), 'utf8')).trim();
      const demoTools = await rawRequest({ port: server.port, path: '/api/tools', headers: { host: `127.0.0.1:${server.port}`, cookie: `sb_token=${demoToken}` } });
      expect((JSON.parse(demoTools.body) as Tool[]).map((t) => t.frameUrl)).toEqual([null, null]);
    } finally {
      await tool.close();
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
