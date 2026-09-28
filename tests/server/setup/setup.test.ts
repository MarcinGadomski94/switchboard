import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Folder, FolderListing, SetupState, SystemInfo } from '../../../src/core/api.ts';
import { countLines, routerTitle, warnAtPct } from '../../../src/core/setup.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { FolderService } from '../../../src/server/folders/service.ts';
import { SetupService, setupWizardAutoOpen } from '../../../src/server/setup/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir, REPO_ROOT } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, until } from '../../helpers/supervisor.ts';

/**
 * M5.3 first-run setup (docs/setup.md; D14): the SetupService (state with the
 * saved folders, Browse…'s listing, complete) and its routes through the guard,
 * plus the wizard's "Add your first folder" (`POST /api/folders`) reaching new
 * sessions at once (a fake-claude session starts there).
 */
const PORT = 4874; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;
const ROUTER_FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'workspace', 'router-AGENTS.md');

let tmp: string | undefined;
let store: Store | undefined;
let world: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';

afterEach(async () => {
  await app?.close();
  await world?.cleanup();
  await store?.close();
  if (tmp) await removeTempDir(tmp);
  app = undefined;
  world = undefined;
  store = undefined;
  tmp = undefined;
});

async function makeWorkspace(root: string, name = 'work space'): Promise<string> {
  const workspace = path.join(root, name);
  await mkdir(path.join(workspace, 'microfrontends', 'web-front', '.git'), { recursive: true });
  await mkdir(path.join(workspace, 'mobile', '.git'), { recursive: true });
  await mkdir(path.join(workspace, '.claude'), { recursive: true });
  await copyFile(ROUTER_FIXTURE, path.join(workspace, 'AGENTS.md'));
  return workspace;
}

async function tempWorld(): Promise<{ root: string; store: Store }> {
  tmp = await realpath(await makeTempDir('setup'));
  store = await openTempStore(tmp);
  return { root: tmp, store };
}

describe('core setup rules', () => {
  it('router title = the first `# ` heading; lines as editors count them; threshold 1–100 else 90', () => {
    expect(routerTitle('intro\n# AGENTS.md (Workspace Router)\n\n## Layout\n# Later\n')).toBe('AGENTS.md (Workspace Router)');
    expect(routerTitle('## only a subheading\n')).toBeNull();
    expect(countLines('')).toBe(0);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\r\nb')).toBe(2);
    expect([warnAtPct(75), warnAtPct(100), warnAtPct(0), warnAtPct(101), warnAtPct(90.5), warnAtPct('80'), warnAtPct(undefined)]).toEqual([75, 100, 90, 90, 90, 90, 90]);
  });

  it('SWITCHBOARD_SETUP_WIZARD=off turns the automatic opening off; anything else keeps it', () => {
    expect(setupWizardAutoOpen({})).toBe(true);
    expect(setupWizardAutoOpen({ SWITCHBOARD_SETUP_WIZARD: 'off' })).toBe(false);
    expect(setupWizardAutoOpen({ SWITCHBOARD_SETUP_WIZARD: ' OFF ' })).toBe(false);
    expect(setupWizardAutoOpen({ SWITCHBOARD_SETUP_WIZARD: 'auto' })).toBe(true);
  });
});

describe('SetupService (M5.3, D14)', () => {
  function service(s: Store, options: { home?: string; autoOpen?: boolean; now?: () => Date } = {}): SetupService {
    const folders = new FolderService({ store: s, ...(options.home ? { home: options.home } : {}) });
    return new SetupService({ store: s, folders, ...(options.autoOpen === undefined ? {} : { autoOpen: options.autoOpen }), ...(options.now ? { now: options.now } : {}) });
  }

  it('first run: not done, opens by itself, no folders ("Add your first folder"), threshold 90', async () => {
    const { store: s } = await tempWorld();
    expect(await service(s).state()).toEqual({ completedAt: null, autoOpen: true, folders: [], warnAtPct: 90 });
    expect((await service(s, { autoOpen: false }).state()).autoOpen).toBe(false);
  });

  it('the state lists the saved folders with their checks, the default first', async () => {
    const { root, store: s } = await tempWorld();
    const workspace = await makeWorkspace(root);
    const setup = service(s, { home: root });
    const folders = new FolderService({ store: s, home: root });
    await folders.add('~/work space');
    const state = await setup.state();
    expect(state.folders).toHaveLength(1);
    expect(state.folders[0]).toMatchObject({ path: workspace, kind: 'workspace', isDefault: true, check: { kind: 'workspace', router: { title: 'AGENTS.md (Workspace Router)' } } });
  });

  it('Browse…: subfolders sorted, hidden ones left out, parent; starts in the default folder, else home; 404 / 422', async () => {
    const { root, store: s } = await tempWorld();
    const workspace = await makeWorkspace(root);
    await writeFile(path.join(workspace, 'a-file.txt'), 'x');
    const setup = service(s, { home: root });
    const home = await setup.folders();
    expect(home).toEqual({ path: root, parent: path.dirname(root), folders: [{ name: 'work space', path: workspace }] });
    const listing = await setup.folders(workspace);
    expect(listing.folders.map((f) => f.name)).toEqual(['microfrontends', 'mobile']);
    expect(listing.parent).toBe(root);
    expect((await setup.folders('~')).path).toBe(root);
    await new FolderService({ store: s }).add(workspace);
    expect((await setup.folders()).path).toBe(workspace);
    expect((await setup.folders('/')).parent).toBeNull();
    await expect(setup.folders(path.join(root, 'nope'))).rejects.toMatchObject({ code: 'not-found', status: 404 });
    await expect(setup.folders('relative')).rejects.toMatchObject({ code: 'invalid', status: 422 });
  });

  it('complete: stores the time; the wizard no longer opens by itself; the stored threshold is shown', async () => {
    const { store: s } = await tempWorld();
    await s.settings.set('usage.warnAtPct', 80);
    const setup = service(s, { now: () => new Date('2026-09-28T05:00:00.000Z') });
    const state = await setup.complete();
    expect(state).toMatchObject({ completedAt: '2026-09-28T05:00:00.000Z', autoOpen: false, warnAtPct: 80 });
    expect(await s.settings.get('setup.completedAt')).toBe('2026-09-28T05:00:00.000Z');
  });
});

describe('/api/setup and /api/system routes (M5.3, D14)', () => {
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

  async function start(options: { system?: SystemInfo } = {}): Promise<{ workspace: string; world: SupervisorWorld }> {
    world = await makeSupervisorWorld({ scenario: 'handoff-start' });
    const workspace = await makeWorkspace(world.root, 'chosen ws');
    token = generateToken();
    const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: world.root }, platform: 'linux', home: world.root, cwd: world.root });
    const config = { ...base, port: PORT };
    const providers = options.system ? { system: { system: async () => options.system as SystemInfo } } : {};
    app = await buildApp({ config, token, store: world.store, webRoot: world.root, supervisor: world.supervisor, providers });
    await app.ready();
    return { workspace, world };
  }

  it('every setup and folder route is behind the cookie guard; the workspace-root routes are gone', async () => {
    await start();
    for (const [method, url] of [
      ['GET', '/api/setup'],
      ['GET', '/api/setup/folders'],
      ['POST', '/api/setup/complete'],
      ['GET', '/api/folders'],
      ['GET', '/api/folders/check?path=/tmp'],
      ['POST', '/api/folders'],
      ['DELETE', '/api/folders/x'],
      ['PUT', '/api/folders/x/default'],
      ['GET', '/api/system'],
    ] as const) {
      expect((await call(method, url, undefined, false)).statusCode, `${method} ${url}`).toBe(401);
    }
    expect((await call('GET', '/api/setup/root?path=/tmp')).statusCode).toBe(404);
    expect((await call('PUT', '/api/setup/root', { path: '/tmp' })).statusCode).toBe(404);
  });

  it('"Add your first folder": no session before it; added through /api/folders it is the default and new sessions run there at once', async () => {
    const { workspace, world: w } = await start();
    const first = (await call('GET', '/api/setup')).json() as SetupState;
    expect(first).toMatchObject({ completedAt: null, autoOpen: true, folders: [] });

    // Without a folder no session can start.
    const refused = await call('POST', '/api/sessions', newSession({ name: 'before-folder', solutions: ['web-front'] }));
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'no-folder' });

    const added = await call('POST', '/api/folders', { path: workspace });
    expect(added.statusCode).toBe(201);
    expect(added.json() as Folder).toMatchObject({ path: workspace, kind: 'workspace', isDefault: true });
    expect(((await call('GET', '/api/setup')).json() as SetupState).folders.map((f) => f.path)).toEqual([workspace]);

    // A new session uses it at once: the process runs in the folder.
    const created = await call('POST', '/api/sessions', newSession({ name: 'after-folder', task: '', solutions: ['web-front'] }));
    expect(created.statusCode).toBe(201);
    const argvLine = await until(async () => {
      const text = await readFile(w.logFile, 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { kind: string; cwd: string }).find((entry) => entry.kind === 'argv');
    }, 'the fake-claude argv line');
    expect(argvLine.cwd).toBe(workspace);

    const listing = (await call('GET', `/api/setup/folders?path=${encodeURIComponent(w.root)}`)).json() as FolderListing;
    expect(listing.folders.map((f) => f.name)).toEqual(expect.arrayContaining(['chosen ws', 'work space']));
    expect((await call('GET', '/api/setup/folders')).json()).toMatchObject({ path: workspace });
    expect((await call('GET', `/api/setup/folders?path=${encodeURIComponent(path.join(w.root, 'nope'))}`)).statusCode).toBe(404);

    const done = (await call('POST', '/api/setup/complete')).json() as SetupState;
    expect(done.completedAt).not.toBeNull();
    expect(done.autoOpen).toBe(false);
    expect(((await call('GET', '/api/setup')).json() as SetupState).completedAt).toBe(done.completedAt);
  });

  it('GET /api/system: the provider’s answer; 503 without a provider (never runs a CLI of its own)', async () => {
    const info: SystemInfo = { cli: '/usr/local/bin/claude', cliVersion: '2.1.283', signedIn: true, ghSignedIn: false, cpu: 12, ramUsed: 1, ramTotal: 2, processes: 0 };
    await start({ system: info });
    const answer = await call('GET', '/api/system?fresh=1');
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual(info);
    await app?.close();
    await world?.cleanup();
    world = undefined;
    await start();
    const none = await call('GET', '/api/system');
    expect(none.statusCode).toBe(503);
    expect(none.json()).toMatchObject({ error: 'system-unavailable' });
  });
});
