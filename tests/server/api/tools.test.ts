import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodebaseMemoryStatus, Session, Tool } from '../../../src/core/api.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import {
  DIRTY_FILE,
  describeProject,
  parseDirtyFile,
  projectId,
  readDirtyProjects,
  reindexPrompt,
} from '../../../src/server/tools/codebase-memory.ts';
import { probeUrl } from '../../../src/server/tools/probe.ts';
import { normalizeToolUrl } from '../../../src/server/tools/validate.ts';
import { generateToken } from '../../../src/server/token.ts';
import { type StubServer, htmlPage, startStubServer, unusedTestPort } from '../../helpers/stub-http.ts';
import { type SupervisorWorld, makeSupervisorWorld, spawnedArgv, stdinOf, until, waitForStatus } from '../../helpers/supervisor.ts';

const PORT = 4874; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

let world: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';
const stubs: StubServer[] = [];

async function setup(workspace: 'world' | 'none' = 'world'): Promise<SupervisorWorld> {
  world = await makeSupervisorWorld({ scenario: 'handoff-start' });
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: world.root }, platform: 'linux', home: world.root, cwd: world.root });
  const config = { ...base, port: PORT, workspaceRoot: workspace === 'world' ? world.workspace : null };
  app = await buildApp({ config, token, store: world.store, webRoot: world.root, supervisor: world.supervisor });
  await app.ready();
  return world;
}

async function stub(handler = htmlPage('stub tool')): Promise<StubServer> {
  const server = await startStubServer(handler);
  stubs.push(server);
  return server;
}

afterEach(async () => {
  await app?.close();
  await world?.cleanup();
  for (const server of stubs.splice(0)) await server.close();
  app = undefined;
  world = undefined;
});

function call(method: InjectOptions['method'], url: string, payload?: unknown) {
  if (!app) throw new Error('no app');
  return app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

/** Writes the workspace's dirty file with `lines`. */
async function writeDirty(workspace: string, lines: readonly string[]): Promise<void> {
  await mkdir(path.join(workspace, '.claude'), { recursive: true });
  await writeFile(path.join(workspace, DIRTY_FILE), `${lines.join('\n')}\n`);
}

describe('GET/PUT /api/tools (M8.1, gaps #13, #14)', () => {
  it('a fresh install lists Codebase Memory (http://localhost:13000) and Acme Tool (no URL)', async () => {
    await setup();
    const response = await call('GET', '/api/tools');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual<Tool[]>([
      { id: 'cm', name: 'Codebase Memory', url: 'http://localhost:13000', description: 'code graph for your indexed solutions', showInSidebar: true },
      { id: 'sw', name: 'Acme Tool', url: null, description: 'AI chat connected to other tools', showInSidebar: true },
    ]);
  });

  it('PUT replaces the list: edit, add (id generated), remove, reorder; saved in Switchboard', async () => {
    const w = await setup();
    const put = await call('PUT', '/api/tools', [
      { id: 'sw', name: 'Acme Tool', url: '  http://127.0.0.1:4999/chat  ', description: '' },
      { name: 'Grafana', url: 'https://grafana.local:3000/d/x', showInSidebar: false },
    ]);
    expect(put.statusCode).toBe(200);
    const tools = put.json() as Tool[];
    expect(tools.map((t) => [t.name, t.url, t.description, t.showInSidebar])).toEqual([
      ['Acme Tool', 'http://127.0.0.1:4999/chat', null, true],
      ['Grafana', 'https://grafana.local:3000/d/x', null, false],
    ]);
    expect(tools[0]?.id).toBe('sw');
    expect(tools[1]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await call('GET', '/api/tools')).json()).toEqual(tools);
    expect(await w.store.tools.get('cm')).toBeNull(); // removed stays removed

    // An empty URL = not configured.
    const cleared = await call('PUT', '/api/tools', [{ id: 'sw', name: 'Acme Tool', url: '' }]);
    expect(cleared.json()).toEqual([{ id: 'sw', name: 'Acme Tool', url: null, description: null, showInSidebar: true }]);
  });

  it('422 on an invalid body; nothing changes', async () => {
    await setup();
    const cases: Array<[string, unknown, string]> = [
      ['not a list', { id: 'cm' }, ''],
      ['not an object', ['cm'], '[0]'],
      ['no name', [{ id: 'x', url: null }], '[0].name'],
      ['ftp url', [{ name: 'A', url: 'ftp://host/' }], '[0].url'],
      ['javascript url', [{ name: 'A', url: 'javascript:alert(1)' }], '[0].url'],
      ['relative url', [{ name: 'A', url: '/tools/x' }], '[0].url'],
      ['credentials in url', [{ name: 'A', url: 'http://user:pw@localhost:1/' }], '[0].url'],
      ['bad id', [{ id: 'a/b', name: 'A' }], '[0].id'],
      ['duplicate id', [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }], '[1].id'],
      ['showInSidebar not boolean', [{ name: 'A', showInSidebar: 'yes' }], '[0].showInSidebar'],
      ['description not text', [{ name: 'A', description: 3 }], '[0].description'],
    ];
    for (const [what, body, field] of cases) {
      const response = await call('PUT', '/api/tools', body);
      expect(response.statusCode, what).toBe(422);
      expect(response.json().errors.map((e: { field: string }) => e.field), what).toContain(field);
    }
    expect(((await call('GET', '/api/tools')).json() as Tool[]).map((t) => t.id)).toEqual(['cm', 'sw']);
  });

  it('normalizeToolUrl keeps only http(s) URLs', () => {
    expect(normalizeToolUrl(undefined)).toBeNull();
    expect(normalizeToolUrl(' ')).toBeNull();
    expect(normalizeToolUrl('http://localhost:13000')).toBe('http://localhost:13000');
    expect(normalizeToolUrl('file:///etc/passwd')).toBeUndefined();
    expect(normalizeToolUrl(42)).toBeUndefined();
  });
});

describe('POST /api/tools/{id}/probe (server-side, 3 s timeout)', () => {
  it('up for any HTTP answer (200, 404, a redirect that is not followed); the stub sees one GET', async () => {
    await setup();
    const ok = await stub();
    const missing = await stub((_req, res) => {
      res.writeHead(404).end('nope');
    });
    const dead = await unusedTestPort([ok.port, missing.port]);
    const redirect = await stub((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${dead}/` }).end();
    });
    await call('PUT', '/api/tools', [
      { id: 'ok', name: 'Ok', url: ok.url },
      { id: 'missing', name: 'Missing', url: `${missing.url}x` },
      { id: 'redirect', name: 'Redirect', url: redirect.url },
    ]);
    for (const id of ['ok', 'missing', 'redirect']) {
      const response = await call('POST', `/api/tools/${id}/probe`);
      expect(response.statusCode, id).toBe(200);
      expect(response.json(), id).toEqual({ state: 'up' });
    }
    expect(ok.requests).toEqual(['/']);
    expect(missing.requests).toEqual(['/x']);
    expect(redirect.requests).toEqual(['/']);
  });

  it('down when nothing listens, and after 3 s without an answer', async () => {
    await setup();
    const hanging = await stub(() => {
      /* never answers */
    });
    const dead = await unusedTestPort([hanging.port]);
    await call('PUT', '/api/tools', [
      { id: 'dead', name: 'Dead', url: `http://127.0.0.1:${dead}/` },
      { id: 'hang', name: 'Hang', url: hanging.url },
    ]);
    expect((await call('POST', '/api/tools/dead/probe')).json()).toEqual({ state: 'down' });
    const started = Date.now();
    expect((await call('POST', '/api/tools/hang/probe')).json()).toEqual({ state: 'down' });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(2_900);
    expect(elapsed).toBeLessThan(5_000);
  }, 15_000);

  it('404 for an unknown tool, 409 for a tool without a URL (nothing is fetched)', async () => {
    await setup();
    const unknown = await call('POST', '/api/tools/nope/probe');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe('not-found');
    const unset = await call('POST', '/api/tools/sw/probe');
    expect(unset.statusCode).toBe(409);
    expect(unset.json().error).toBe('not-configured');
  });

  it('probeUrl honours its timeout', async () => {
    const hanging = await stub(() => {
      /* never answers */
    });
    const started = Date.now();
    expect(await probeUrl(hanging.url, 200)).toBe('down');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('.codebase-memory-dirty (gap #4; the hook project ids)', () => {
  it('projectId follows the hook: runs of : / \\ → one dash, trimmed', () => {
    expect(projectId('/Users/me/Acme Corp/workspace')).toBe('Users-me-Acme Corp-workspace');
    expect(projectId('D:\\RiderProjects\\ws\\')).toBe('D-RiderProjects-ws');
    expect(projectId('/Users/me/ws/nugets/auth-nuget')).toBe('Users-me-ws-nugets-auth-nuget');
  });

  it('names lines of the workspace root by repo; others keep their id', () => {
    const root = '/Users/me/Acme Corp/workspace';
    const rootId = projectId(root);
    const text = [
      `${rootId}-microfrontends-acme-app-front`,
      '',
      `${rootId.toLowerCase()}-nugets-components-library-nuget`,
      `${rootId}-mobile-src`,
      `${rootId}-microfrontends-acme-app-front`,
      'D-other-ws-nugets-auth-nuget',
      `${rootId}-unknowncat-x`,
      '   ',
    ].join('\r\n');
    expect(parseDirtyFile(text, root)).toEqual([
      { id: `${rootId}-microfrontends-acme-app-front`, name: 'acme-app-front', path: path.join(root, 'microfrontends', 'acme-app-front'), markedAt: null },
      {
        id: `${rootId.toLowerCase()}-nugets-components-library-nuget`,
        name: 'components-library-nuget',
        path: path.join(root, 'nugets', 'components-library-nuget'),
        markedAt: null,
      },
      { id: `${rootId}-mobile-src`, name: 'mobile', path: path.join(root, 'mobile'), markedAt: null },
      { id: 'D-other-ws-nugets-auth-nuget', name: 'D-other-ws-nugets-auth-nuget', path: null, markedAt: null },
      { id: `${rootId}-unknowncat-x`, name: `${rootId}-unknowncat-x`, path: null, markedAt: null },
    ]);
    expect(describeProject('anything', null)).toEqual({ id: 'anything', name: 'anything', path: null, markedAt: null });
  });

  it('reads the file under the root, also when the hook saw the real path of a symlinked root', async () => {
    const w = await setup();
    expect(await readDirtyProjects(w.workspace)).toEqual([]); // no file yet
    expect(await readDirtyProjects(null)).toEqual([]);
    const link = path.join(w.root, 'ws-link');
    await symlink(w.workspace, link);
    await writeDirty(w.workspace, [`${projectId(w.workspace)}-functions-calendar-func`]);
    expect(await readDirtyProjects(link)).toEqual([
      { id: `${projectId(w.workspace)}-functions-calendar-func`, name: 'calendar-func', path: path.join(link, 'functions', 'calendar-func'), markedAt: null },
    ]);
  });

  it('GET /api/codebase-memory: the projects, indexed unknown', async () => {
    const w = await setup();
    expect((await call('GET', '/api/codebase-memory')).json()).toEqual({ projects: [], indexed: null });
    await writeDirty(w.workspace, [`${projectId(w.workspace)}-microfrontends-acme-app-front`, `${projectId(w.workspace)}-mobile-x`]);
    const status = (await call('GET', '/api/codebase-memory')).json() as CodebaseMemoryStatus;
    expect(status.indexed).toBeNull();
    expect(status.projects.map((p) => p.name)).toEqual(['acme-app-front', 'mobile']);
  });
});

describe('POST /api/codebase-memory/reindex (gap #4)', () => {
  it('starts a background session from the built-in prompt through the supervisor (fake-claude); names never clash', async () => {
    const w = await setup();
    const rootId = projectId(w.workspace);
    await writeDirty(w.workspace, [`${rootId}-microfrontends-acme-app-front`, `${rootId}-nugets-components-library-nuget`]);
    const response = await call('POST', '/api/codebase-memory/reindex');
    expect(response.statusCode).toBe(201);
    const session = response.json() as Session;
    expect(session).toMatchObject({ name: 'reindex-codebase-memory', workType: null, mode: null, phase: null, solutions: [], worktrees: false });

    const argv = await until(async () => (await spawnedArgv(w.logFile))[0], 'the reindex process');
    expect(argv.argv).toContain('--session-id');
    expect(argv.argv).toContain('reindex-codebase-memory');
    const expected = reindexPrompt(await readDirtyProjects(w.workspace));
    const [first] = await until(async () => {
      const lines = await stdinOf(w.logFile, argv.pid as number);
      return lines.length > 0 ? lines : undefined;
    }, 'the first stdin message');
    expect(first).toEqual({ type: 'user', message: { role: 'user', content: expected } });
    expect(expected).toContain(`- acme-app-front: ${path.join(w.workspace, 'microfrontends', 'acme-app-front')} (codebase-memory project ${rootId}-microfrontends-acme-app-front)`);
    expect(expected).toContain('index_repository with mode "full"');
    expect(expected).toContain('do not run the codebase-memory-mcp binary directly');
    await waitForStatus(w.store, session.id, ['done', 'idle']);

    const again = await call('POST', '/api/codebase-memory/reindex');
    expect(again.statusCode).toBe(201);
    expect((again.json() as Session).name).toBe('reindex-codebase-memory-2');
    await waitForStatus(w.store, (again.json() as Session).id, ['done', 'idle']);
  });

  it('409 nothing-to-reindex without dirty projects (or without a workspace root); nothing is spawned', async () => {
    const w = await setup();
    const empty = await call('POST', '/api/codebase-memory/reindex');
    expect(empty.statusCode).toBe(409);
    expect(empty.json().error).toBe('nothing-to-reindex');
    expect(await spawnedArgv(w.logFile)).toHaveLength(0);
    expect(await w.store.sessions.list()).toHaveLength(0);
  });
});
