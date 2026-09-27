import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOKEN_FILE } from '../../src/server/token.ts';
import { makeTempDir, rawRequest, removeTempDir } from '../helpers/net.ts';
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

  it('exits 1 on an invalid SWITCHBOARD_PORT without binding anything', async () => {
    const dataDir = path.join(tmp, 'data');
    const bad = spawnServer('not-a-port', { SWITCHBOARD_DATA_DIR: dataDir });
    expect(await bad.closed).toBe(1);
    expect(bad.output()).toContain('SWITCHBOARD_PORT must be an integer');
    expect(bad.output()).not.toContain('Server listening');
  });
});
