import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { SolutionGroup } from '../../../src/core/api.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Providers } from '../../../src/server/providers.ts';
import { WorkspaceScanner } from '../../../src/server/solutions/scanner.ts';
import { generateToken } from '../../../src/server/token.ts';
import { REPO_ROOT } from '../../helpers/net.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, spawnedArgv, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * `GET /api/solutions` on the real code path (M6.1, no demo): the WorkspaceScanner
 * over a fixture workspace in a temp folder, through the security guard, and its
 * read-only rule in `POST /api/sessions` with fake-claude as the CLI.
 */
const PORT = 4873; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;
const ROUTER_FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'workspace', 'router-AGENTS.md');

let world: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';

afterEach(async () => {
  await app?.close();
  await world?.cleanup();
  app = undefined;
  world = undefined;
});

async function repo(workspace: string, relative: string): Promise<void> {
  await mkdir(path.join(workspace, relative, '.git'), { recursive: true });
}

/** A supervisor world (fake-claude) whose workspace has the real router rules plus an `archive/` folder they mark read-only. */
async function setup(options: { root?: 'world' | 'none'; providers?: 'scanner' | 'none' } = {}): Promise<SupervisorWorld> {
  world = await makeSupervisorWorld({ scenario: 'handoff-start' });
  const ws = world.workspace;
  const router = `${await readFile(ROUTER_FIXTURE, 'utf8')}\n- \`archive/<repo>/\` — old snapshots, never edited\n`;
  await writeFile(path.join(ws, 'AGENTS.md'), router);
  await repo(ws, 'microfrontends/acme-app-front');
  await repo(ws, 'mobile');
  await repo(ws, 'deprecated/mobile');
  await repo(ws, 'archive/old-repo');
  await repo(ws, 'other/it-dashboard');
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: world.root }, platform: 'linux', home: world.root, cwd: world.root });
  const workspaceRoot = options.root === 'none' ? null : ws;
  const config = { ...base, port: PORT, workspaceRoot };
  const providers: Providers = options.providers === 'none' ? {} : { solutions: new WorkspaceScanner({ workspaceRoot }) };
  app = await buildApp({ config, token, store: world.store, webRoot: world.root, supervisor: world.supervisor, providers });
  await app.ready();
  return world;
}

function call(method: InjectOptions['method'], url: string, payload?: unknown, cookie = true) {
  if (!app) throw new Error('no app');
  return app.inject({
    method,
    url,
    headers: {
      host: HOST,
      ...(cookie ? { cookie: `sb_token=${token}` } : {}),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

describe('GET /api/solutions (M6.1)', () => {
  it('serves the scan as SolutionGroup[] behind the cookie guard', async () => {
    const w = await setup();
    const response = await call('GET', '/api/solutions');
    expect(response.statusCode).toBe(200);
    const groups = response.json() as SolutionGroup[];
    expect(groups.map((g) => [g.folder, g.note, g.rule, g.solutions.map((s) => [s.name, s.path, s.type, s.rule])])).toEqual([
      ['microfrontends/', '', 'editable', [['acme-app-front', path.join(w.workspace, 'microfrontends', 'acme-app-front'), 'Web', 'editable']]],
      ['mobile/', '', 'editable', [['mobile', path.join(w.workspace, 'mobile'), 'Mobile', 'editable']]],
      ['other/', 'on request only', 'on-request', [['it-dashboard', path.join(w.workspace, 'other', 'it-dashboard'), 'Other', 'on-request']]],
      [
        'read-only',
        'deprecated/ · archive/ · never edited',
        'read-only',
        [
          ['mobile', path.join(w.workspace, 'deprecated', 'mobile'), 'Read-only', 'read-only'],
          ['old-repo', path.join(w.workspace, 'archive', 'old-repo'), 'Read-only', 'read-only'],
        ],
      ],
    ]);
    expect((await call('GET', '/api/solutions', undefined, false)).statusCode).toBe(401);
  });

  it('without a passed provider the route scans the configured workspace root itself', async () => {
    await setup({ providers: 'none' });
    const response = await call('GET', '/api/solutions');
    expect(response.statusCode).toBe(200);
    expect((response.json() as SolutionGroup[]).map((g) => g.folder)).toEqual(['microfrontends/', 'mobile/', 'other/', 'read-only']);
  });

  it('409 workspace-not-configured without a workspace root; 409 workspace-missing when it is gone', async () => {
    await setup({ root: 'none' });
    const response = await call('GET', '/api/solutions');
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'workspace-not-configured' });
    await app?.close();
    await world?.cleanup();
    world = await makeSupervisorWorld();
    token = generateToken();
    const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: world.root }, platform: 'linux', home: world.root, cwd: world.root });
    const missing = path.join(world.root, 'gone');
    app = await buildApp({
      config: { ...base, port: PORT, workspaceRoot: missing },
      token,
      store: world.store,
      webRoot: world.root,
      supervisor: world.supervisor,
      providers: { solutions: new WorkspaceScanner({ workspaceRoot: missing }) },
    });
    await app.ready();
    const gone = await call('GET', '/api/solutions');
    expect(gone.statusCode).toBe(409);
    expect(gone.json()).toMatchObject({ error: 'workspace-missing' });
  });
});

describe('POST /api/sessions · read-only by the scanned router rules (M6.1)', () => {
  it('422 for a solution in a folder the router makes read-only (not in the static layout); nothing is spawned', async () => {
    const w = await setup();
    const response = await call('POST', '/api/sessions', newSession({ solutions: ['archive/old-repo'] }));
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'invalid', errors: [{ field: 'solutions', message: '"archive/old-repo" is read-only and cannot be a write target' }] });
    expect(await w.store.sessions.list()).toHaveLength(0);
    expect(await spawnedArgv(w.logFile)).toHaveLength(0);
  });

  it('a live `mobile` is not refused because the archive holds a `deprecated/mobile`: the session starts', async () => {
    const w = await setup();
    const response = await call('POST', '/api/sessions', newSession({ name: 'mobile-work', solutions: ['mobile'] }));
    expect(response.statusCode).toBe(201);
    const session = response.json() as { id: string; solutions: string[] };
    expect(session.solutions).toEqual(['mobile']);
    await waitForStatus(w.store, session.id, ['done']);
    expect(await spawnedArgv(w.logFile)).toHaveLength(1);
  });
});
