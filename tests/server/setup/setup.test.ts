import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { FolderListing, SetupState, SystemInfo, WorkspaceRootCheck } from '../../../src/core/api.ts';
import { countLines, routerTitle, warnAtPct } from '../../../src/core/setup.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { SetupError, SetupService, setupWizardAutoOpen } from '../../../src/server/setup/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir, REPO_ROOT } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, until } from '../../helpers/supervisor.ts';

/**
 * M5.3 first-run setup (docs/setup.md): the SetupService (state, root check,
 * save with its refusals, Browse…'s listing, complete, the stored root at the
 * next start) and its routes through the guard, plus a root saved through the
 * API reaching the supervisor at once (a fake-claude session starts there).
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

describe('SetupService (M5.3)', () => {
  it('first run: not done, opens by itself, no root, threshold 90', async () => {
    const { store: s } = await tempWorld();
    const setup = await SetupService.open({ store: s, envRoot: null });
    expect(await setup.state()).toEqual({ completedAt: null, autoOpen: true, workspaceRoot: { path: null, source: null, check: null }, warnAtPct: 90 });
    const off = await SetupService.open({ store: s, envRoot: null, autoOpen: false });
    expect((await off.state()).autoOpen).toBe(false);
  });

  it('checks a root: a folder with AGENTS.md (title + lines), without one, missing, not absolute, ~ expanded', async () => {
    const { root, store: s } = await tempWorld();
    const workspace = await makeWorkspace(root);
    const setup = await SetupService.open({ store: s, envRoot: null, home: root });
    const lines = countLines(await readFile(ROUTER_FIXTURE, 'utf8'));
    expect(await setup.checkRoot(`  ${workspace}  `)).toEqual({ path: workspace, state: 'ok', router: { title: 'AGENTS.md (Workspace Router)', lines } });
    expect(await setup.checkRoot('~/work space')).toEqual({ path: workspace, state: 'ok', router: { title: 'AGENTS.md (Workspace Router)', lines } });
    expect(await setup.checkRoot(path.join(workspace, 'mobile'))).toEqual({ path: path.join(workspace, 'mobile'), state: 'no-router', router: null });
    expect(await setup.checkRoot(path.join(root, 'nope'))).toEqual({ path: path.join(root, 'nope'), state: 'missing', router: null });
    expect(await setup.checkRoot(path.join(workspace, 'AGENTS.md'))).toMatchObject({ state: 'missing' });
    expect(await setup.checkRoot('relative/folder')).toEqual({ path: 'relative/folder', state: 'not-absolute', router: null });
  });

  it('saves a root: stored, announced, reported as source `setup`, and loaded again at the next start', async () => {
    const { root, store: s } = await tempWorld();
    const workspace = await makeWorkspace(root);
    const setup = await SetupService.open({ store: s, envRoot: null });
    const seen: Array<string | null> = [];
    setup.onRootChange((next) => seen.push(next));
    const state = await setup.saveRoot(workspace);
    expect(state.workspaceRoot).toMatchObject({ path: workspace, source: 'setup', check: { state: 'ok' } });
    expect(setup.workspaceRoot).toBe(workspace);
    expect(seen).toEqual([workspace]);
    expect(await s.settings.get('setup.workspaceRoot')).toBe(workspace);
    // The same root again changes nothing (and is allowed while sessions run).
    await setup.saveRoot(workspace, { liveProcesses: 3 });
    expect(seen).toEqual([workspace]);
    const next = await SetupService.open({ store: s, envRoot: null });
    expect(next.workspaceRoot).toBe(workspace);
    expect(next.rootSource).toBe('setup');
    // The live configuration follows the service.
    const live = next.liveConfig({ ...loadConfig({ env: {} }), workspaceRoot: null });
    expect(live.workspaceRoot).toBe(workspace);
  });

  it('refuses: env root (409), a folder without AGENTS.md / missing (422 + check), a change while sessions run (409)', async () => {
    const { root, store: s } = await tempWorld();
    const workspace = await makeWorkspace(root);
    const other = await makeWorkspace(root, 'other ws');
    const env = await SetupService.open({ store: s, envRoot: workspace });
    expect(env.rootSource).toBe('env');
    await expect(env.saveRoot(other)).rejects.toMatchObject({ code: 'root-from-env', status: 409 });

    const setup = await SetupService.open({ store: s, envRoot: null });
    const noRouter = await setup.saveRoot(path.join(workspace, 'mobile')).catch((error: unknown) => error);
    expect(noRouter).toBeInstanceOf(SetupError);
    expect(noRouter).toMatchObject({ code: 'invalid', status: 422, message: 'no AGENTS.md in this folder', check: { state: 'no-router' } });
    await expect(setup.saveRoot(path.join(root, 'missing'))).rejects.toMatchObject({ code: 'invalid', message: 'folder not found' });
    await expect(setup.saveRoot('not/absolute')).rejects.toMatchObject({ code: 'invalid', message: 'enter an absolute path' });
    await setup.saveRoot(workspace);
    await expect(setup.saveRoot(other, { liveProcesses: 1 })).rejects.toMatchObject({ code: 'sessions-live', status: 409 });
    expect(setup.workspaceRoot).toBe(workspace);
    await setup.saveRoot(other, { liveProcesses: 0 });
    expect(setup.workspaceRoot).toBe(other);
    // Env wins over a stored root.
    const both = await SetupService.open({ store: s, envRoot: workspace });
    expect(both.workspaceRoot).toBe(workspace);
  });

  it('Browse…: subfolders sorted, hidden ones left out, parent; defaults to the root, else home; 404 / 422', async () => {
    const { root, store: s } = await tempWorld();
    const workspace = await makeWorkspace(root);
    await writeFile(path.join(workspace, 'a-file.txt'), 'x');
    const setup = await SetupService.open({ store: s, envRoot: null, home: root });
    const home = await setup.folders();
    expect(home).toEqual({ path: root, parent: path.dirname(root), folders: [{ name: 'work space', path: workspace }] });
    const listing = await setup.folders(workspace);
    expect(listing.folders.map((f) => f.name)).toEqual(['microfrontends', 'mobile']);
    expect(listing.parent).toBe(root);
    await setup.saveRoot(workspace);
    expect((await setup.folders()).path).toBe(workspace);
    expect((await setup.folders('/')).parent).toBeNull();
    await expect(setup.folders(path.join(root, 'nope'))).rejects.toMatchObject({ code: 'not-found', status: 404 });
    await expect(setup.folders('relative')).rejects.toMatchObject({ code: 'invalid', status: 422 });
  });

  it('complete: stores the time; the wizard no longer opens by itself; the stored threshold is shown', async () => {
    const { store: s } = await tempWorld();
    await s.settings.set('usage.warnAtPct', 80);
    const setup = await SetupService.open({ store: s, envRoot: null, now: () => new Date('2026-09-28T05:00:00.000Z') });
    const state = await setup.complete();
    expect(state).toMatchObject({ completedAt: '2026-09-28T05:00:00.000Z', autoOpen: false, warnAtPct: 80 });
    expect(await s.settings.get('setup.completedAt')).toBe('2026-09-28T05:00:00.000Z');
  });
});

describe('/api/setup and /api/system routes (M5.3)', () => {
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

  async function start(options: { envRoot?: boolean; system?: SystemInfo } = {}): Promise<{ workspace: string; world: SupervisorWorld }> {
    world = await makeSupervisorWorld({ scenario: 'handoff-start' });
    const workspace = await makeWorkspace(world.root, 'chosen ws');
    // The supervisor starts without a root, as main.ts does on a first run without SWITCHBOARD_WORKSPACE_ROOT.
    world.supervisor.setWorkspaceRoot(null);
    token = generateToken();
    const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: world.root }, platform: 'linux', home: world.root, cwd: world.root });
    const config = { ...base, port: PORT, workspaceRoot: options.envRoot ? workspace : null };
    const providers = options.system ? { system: { system: async () => options.system as SystemInfo } } : {};
    app = await buildApp({ config, token, store: world.store, webRoot: world.root, supervisor: world.supervisor, providers });
    await app.ready();
    return { workspace, world };
  }

  it('every setup route is behind the cookie guard', async () => {
    await start();
    for (const [method, url] of [
      ['GET', '/api/setup'],
      ['GET', '/api/setup/root?path=/tmp'],
      ['PUT', '/api/setup/root'],
      ['GET', '/api/setup/folders'],
      ['POST', '/api/setup/complete'],
      ['GET', '/api/system'],
    ] as const) {
      expect((await call(method, url, undefined, false)).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('check, save (applied to the supervisor at once: a session starts in the new root), folders, complete', async () => {
    const { workspace, world: w } = await start();
    const first = (await call('GET', '/api/setup')).json() as SetupState;
    expect(first).toMatchObject({ completedAt: null, autoOpen: true, workspaceRoot: { path: null, source: null } });

    // Without a root no session can start.
    const refused = await call('POST', '/api/sessions', newSession({ name: 'before-root', solutions: ['web-front'] }));
    expect(refused.statusCode).toBe(409);

    expect((await call('GET', '/api/setup/root')).statusCode).toBe(400);
    const check = (await call('GET', `/api/setup/root?path=${encodeURIComponent(workspace)}`)).json() as WorkspaceRootCheck;
    expect(check).toMatchObject({ path: workspace, state: 'ok', router: { title: 'AGENTS.md (Workspace Router)' } });
    const bad = await call('PUT', '/api/setup/root', { path: path.join(workspace, 'mobile') });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: 'invalid', message: 'no AGENTS.md in this folder', check: { state: 'no-router' } });
    expect((await call('PUT', '/api/setup/root', {})).statusCode).toBe(422);

    const saved = await call('PUT', '/api/setup/root', { path: workspace });
    expect(saved.statusCode).toBe(200);
    expect((saved.json() as SetupState).workspaceRoot).toMatchObject({ path: workspace, source: 'setup' });

    // The supervisor uses it at once: the session's process runs in the chosen root.
    const created = await call('POST', '/api/sessions', newSession({ name: 'after-root', task: '', solutions: ['web-front'] }));
    expect(created.statusCode).toBe(201);
    const argvLine = await until(async () => {
      const text = await readFile(w.logFile, 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { kind: string; cwd: string }).find((entry) => entry.kind === 'argv');
    }, 'the fake-claude argv line');
    expect(argvLine.cwd).toBe(workspace);

    // A different root while that process runs is refused.
    const other = await makeWorkspace(w.root, 'other ws');
    const busy = await call('PUT', '/api/setup/root', { path: other });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ error: 'sessions-live' });

    const listing = (await call('GET', `/api/setup/folders?path=${encodeURIComponent(w.root)}`)).json() as FolderListing;
    expect(listing.folders.map((f) => f.name)).toEqual(expect.arrayContaining(['chosen ws', 'other ws', 'work space']));
    expect((await call('GET', `/api/setup/folders?path=${encodeURIComponent(path.join(w.root, 'nope'))}`)).statusCode).toBe(404);

    const done = (await call('POST', '/api/setup/complete')).json() as SetupState;
    expect(done.completedAt).not.toBeNull();
    expect(done.autoOpen).toBe(false);
    expect(((await call('GET', '/api/setup')).json() as SetupState).completedAt).toBe(done.completedAt);
  });

  it('a root from the environment is reported as `env` and cannot be changed (409)', async () => {
    const { workspace } = await start({ envRoot: true });
    const state = (await call('GET', '/api/setup')).json() as SetupState;
    expect(state.workspaceRoot).toMatchObject({ path: workspace, source: 'env', check: { state: 'ok' } });
    const refused = await call('PUT', '/api/setup/root', { path: workspace });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'root-from-env' });
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
