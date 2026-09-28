import { mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodebaseMemoryStatus, Folder, FolderCheck, NewRepoSession, NewSession, Session, SessionDetail, SolutionGroup } from '../../../src/core/api.ts';
import { REPO_WORKTREE_NOTE_HEADER, SESSION_START_HEADER } from '../../../src/core/first-turn.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { expandHome, inspectFolder } from '../../../src/server/folders/inspect.ts';
import { FolderError, FolderService } from '../../../src/server/folders/service.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';
import { REPO_ROOT, makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, readFakeLog, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D14 oracle (server): saved folders instead of one workspace root. The folder
 * kinds (`inspectFolder`), the folder service (add / remove / default / order /
 * relink / reconcile), the `/api/folders` routes and their codes, and sessions in
 * a repo folder on the real path (fake-claude, real git): their cwd with and
 * without a worktree, their first message (only the worktree note, no router
 * answers), their one solution, and the per-folder Solutions and Codebase Memory.
 */
const PORT = 4876; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;
const ROUTER_FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'workspace', 'router-AGENTS.md');

let tmp: string | undefined;
let store: Store | undefined;
let sw: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';

afterEach(async () => {
  await app?.close();
  await sw?.cleanup();
  await store?.close();
  if (tmp) await removeTempDir(tmp);
  app = undefined;
  sw = undefined;
  store = undefined;
  tmp = undefined;
});

/** A temp folder with a store (the folder-service tests). */
async function tempStore(): Promise<{ root: string; store: Store }> {
  tmp = await realpath(await makeTempDir('folders'));
  store = await openTempStore(path.join(tmp, 'data'));
  return { root: tmp, store };
}

/** A workspace: a router AGENTS.md, two checkouts (`.git` folders) and an on-request folder. */
async function workspaceAt(dir: string): Promise<string> {
  await mkdir(path.join(dir, 'microfrontends', 'web-front', '.git'), { recursive: true });
  await mkdir(path.join(dir, 'mobile', '.git'), { recursive: true });
  await mkdir(path.join(dir, 'other', 'tool'), { recursive: true });
  await writeFile(path.join(dir, 'AGENTS.md'), await readFile(ROUTER_FIXTURE, 'utf8'));
  return dir;
}

describe('inspectFolder (D14 kinds)', () => {
  it('a git main checkout is a repo, even with its own AGENTS.md; a router AGENTS.md makes a workspace; anything else is refused', async () => {
    const { root } = await tempStore();
    const ws = await workspaceAt(path.join(root, 'work space'));
    const repo = path.join(root, 'solo repo');
    await mkdir(path.join(repo, '.git'), { recursive: true });
    await writeFile(path.join(repo, 'AGENTS.md'), '# AGENTS.md — solo\n');
    const worktree = path.join(root, 'solo repo-wt-x');
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(worktree, '.git'), 'gitdir: ../solo repo/.git/worktrees/x\n');
    await writeFile(path.join(worktree, 'AGENTS.md'), '# looks like a router\n');
    const plain = path.join(root, 'plain');
    await mkdir(plain, { recursive: true });
    await writeFile(path.join(root, 'a-file'), 'x');

    const workspace = await inspectFolder(`  ${ws}  `);
    expect(workspace).toEqual<FolderCheck>({
      path: ws,
      canonicalPath: ws,
      exists: true,
      kind: 'workspace',
      router: { title: 'AGENTS.md (Workspace Router)', lines: expect.any(Number) as unknown as number },
      // web-front, mobile (checkouts) + tool (other/, on request)
      solutionCount: 3,
      repoName: null,
      problem: null,
      message: '',
    });
    expect(await inspectFolder(repo)).toEqual<FolderCheck>({
      path: repo,
      canonicalPath: repo,
      exists: true,
      kind: 'repo',
      router: null,
      solutionCount: 1,
      repoName: 'solo repo',
      problem: null,
      message: '',
    });
    expect(await inspectFolder(worktree)).toMatchObject({ kind: null, exists: true, problem: 'git-worktree' });
    expect(await inspectFolder(plain)).toMatchObject({ kind: null, exists: true, problem: 'unsupported', message: 'no AGENTS.md here and not a git repository' });
    expect(await inspectFolder(path.join(root, 'nope'))).toMatchObject({ kind: null, exists: false, canonicalPath: null, problem: 'missing', message: 'folder not found' });
    expect(await inspectFolder(path.join(root, 'a-file'))).toMatchObject({ kind: null, exists: false, problem: 'not-a-folder' });
    expect(await inspectFolder('relative/folder')).toMatchObject({ path: 'relative/folder', kind: null, problem: 'not-absolute', message: 'enter an absolute path' });
    // `~` is the home folder; a symlink is resolved to the folder it points at.
    expect(await inspectFolder('~/work space', { home: root })).toMatchObject({ path: ws, kind: 'workspace' });
    expect(expandHome('~', root)).toBe(root);
    const link = path.join(root, 'link to repo');
    await symlink(repo, link);
    expect(await inspectFolder(link)).toMatchObject({ path: link, canonicalPath: repo, kind: 'repo', repoName: 'solo repo' });
  });
});

describe('FolderService (D14)', () => {
  it('add: the first is the default; the same folder again (or through a symlink) is not added twice; anything else is refused with its check', async () => {
    const { root, store: s } = await tempStore();
    const ws = await workspaceAt(path.join(root, 'ws'));
    const repo = path.join(root, 'repo');
    await mkdir(path.join(repo, '.git'), { recursive: true });
    const folders = new FolderService({ store: s, home: root });

    const first = await folders.add(ws);
    expect(first.created).toBe(true);
    expect(first.folder).toMatchObject({ path: ws, canonicalPath: ws, name: 'ws', kind: 'workspace', isDefault: true, lastUsedAt: null, check: { kind: 'workspace' } });
    const second = await folders.add('~/repo');
    expect(second).toMatchObject({ created: true, folder: { path: repo, kind: 'repo', isDefault: false, check: { repoName: 'repo' } } });
    await symlink(ws, path.join(root, 'ws link'));
    const again = await folders.add(path.join(root, 'ws link'));
    expect(again).toMatchObject({ created: false, folder: { id: first.folder.id, path: ws } });
    expect((await folders.list()).map((f) => f.path)).toEqual([ws, repo]);

    const refused = await folders.add(path.join(root, 'nope')).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(FolderError);
    expect(refused).toMatchObject({ code: 'invalid', status: 422, message: 'folder not found', check: { problem: 'missing' } });
    await expect(folders.add(path.join(ws, 'other'))).rejects.toMatchObject({ code: 'invalid', check: { problem: 'unsupported' } });
    expect(await s.folders.list()).toHaveLength(2);
  });

  it('order: the default first, then most recently used; setDefault moves the one mark; removing the default promotes the next', async () => {
    const { root, store: s } = await tempStore();
    const folders = new FolderService({ store: s });
    const a = await workspaceAt(path.join(root, 'a'));
    const b = await workspaceAt(path.join(root, 'b'));
    const c = await workspaceAt(path.join(root, 'c'));
    const [fa, fb, fc] = [(await folders.add(a)).folder, (await folders.add(b)).folder, (await folders.add(c)).folder];
    expect((await folders.list()).map((f) => [f.name, f.isDefault])).toEqual([['a', true], ['b', false], ['c', false]]);
    await folders.markUsed(fc.id);
    expect((await folders.list()).map((f) => f.name)).toEqual(['a', 'c', 'b']);
    expect((await folders.setDefault(fb.id)).map((f) => [f.name, f.isDefault])).toEqual([['b', true], ['c', false], ['a', false]]);
    expect((await folders.remove(fb.id)).map((f) => [f.name, f.isDefault])).toEqual([['c', true], ['a', false]]);
    await expect(folders.setDefault('nope')).rejects.toMatchObject({ code: 'not-found', status: 404 });
    await expect(folders.remove('nope')).rejects.toMatchObject({ code: 'not-found', status: 404 });
    expect(fa.id).not.toBe(fc.id);
  });

  it('remove: refused while a schedule starts its runs there; sessions keep their folder path and are linked again when it is added back', async () => {
    const { root, store: s } = await tempStore();
    const ws = await workspaceAt(path.join(root, 'ws'));
    const folders = new FolderService({ store: s });
    const saved = (await folders.add(ws)).folder;
    const session = await s.sessions.create({ name: 'old', claudeSessionId: 'c-old', cwd: ws, root: ws, rootKind: 'workspace', folderId: saved.id });
    const schedule = await s.schedules.create({ name: 'nightly', cron: '0 2 * * *', template: {}, folderId: saved.id });
    const inUse = await folders.remove(saved.id).catch((error: unknown) => error);
    expect(inUse).toMatchObject({ code: 'folder-in-use', status: 409, schedules: ['nightly'] });
    await s.schedules.delete(schedule.id);

    expect(await folders.remove(saved.id)).toEqual([]);
    expect(await s.sessions.get(session.id)).toMatchObject({ folderId: null, root: ws, rootKind: 'workspace' });
    const back = (await folders.add(ws)).folder;
    expect(back.id).not.toBe(saved.id);
    expect(await s.sessions.get(session.id)).toMatchObject({ folderId: back.id });
  });

  it('resolve: a view takes an id, a saved path or a session folder path (no disk access); a new session needs the folder on disk', async () => {
    const { root, store: s } = await tempStore();
    const ws = await workspaceAt(path.join(root, 'ws'));
    const folders = new FolderService({ store: s });
    await expect(folders.resolveForView()).rejects.toMatchObject({ code: 'no-folder', status: 409 });
    await expect(folders.resolveForSession()).rejects.toMatchObject({ code: 'no-folder', status: 409 });
    const saved = (await folders.add(ws)).folder;
    expect(await folders.resolveForView()).toEqual({ id: saved.id, path: ws, root: ws, kind: 'workspace' });
    expect(await folders.resolveForView(saved.id)).toMatchObject({ id: saved.id });
    expect(await folders.resolveForView(ws)).toMatchObject({ id: saved.id });
    // A session's folder that is not saved (any more).
    const gone = path.join(root, 'elsewhere');
    await s.sessions.create({ name: 'there', claudeSessionId: 'c-there', root: gone, rootKind: 'repo', cwd: gone });
    expect(await folders.resolveForView(gone)).toEqual({ id: null, path: gone, root: gone, kind: 'repo' });
    await expect(folders.resolveForView('nope')).rejects.toMatchObject({ code: 'not-found', status: 404 });
    expect(await folders.resolveForSession(saved.id)).toEqual({ id: saved.id, path: ws, root: ws, kind: 'workspace' });
    await expect(folders.resolveForSession('nope')).rejects.toMatchObject({ code: 'not-found' });
    const missing = await seedFolder(s, path.join(root, 'missing'), { isDefault: true });
    await expect(folders.resolveForSession()).rejects.toMatchObject({ code: 'folder-missing', status: 409 });
    expect(missing.isDefault).toBe(true);
  });

  it('open (reconcile): a stale canonical path is refreshed, sessions are linked, a list without a default gets one', async () => {
    const { root, store: s } = await tempStore();
    const real = await workspaceAt(path.join(root, 'real ws'));
    const link = path.join(root, 'ws link');
    await symlink(real, link);
    // As the 0003 migration leaves the wizard's root: canonical = the path as given, no default after a manual edit.
    const record = await s.folders.create({ path: link, canonicalPath: link, kind: 'workspace' });
    const session = await s.sessions.create({ name: 'linked', claudeSessionId: 'c-linked', root: real, rootKind: 'workspace', cwd: real });
    await FolderService.open({ store: s });
    expect(await s.folders.get(record.id)).toMatchObject({ canonicalPath: real, isDefault: true });
    expect(await s.sessions.get(session.id)).toMatchObject({ folderId: record.id });
  });
});

describe('/api/folders, and sessions / solutions / codebase memory per folder (D14, fake-claude + real git)', () => {
  interface Rig {
    readonly s: SupervisorWorld;
    readonly g: GitWorld;
    /** The workspace (router AGENTS.md; `microfrontends/web-front`, `mobile`), saved first: the default. */
    readonly workspace: Folder;
    /** A standalone repo outside the workspace (`<root>/solo`), saved second. */
    readonly repo: Folder;
    readonly repoPath: string;
  }

  async function setup(): Promise<Rig> {
    sw = await makeSupervisorWorld({ scenario: 'handoff-start' });
    const g = await makeGitWorld({ root: sw.root, workspace: sw.workspace, store: sw.store, baseEnv: sw.env });
    await writeFile(path.join(g.workspace, 'AGENTS.md'), await readFile(ROUTER_FIXTURE, 'utf8'));
    await mkdir(path.join(g.workspace, '.claude'), { recursive: true });
    const hookId = path.join(g.workspace, 'mobile', 'src').replace(/\\/g, '/').replace(/[:/\\]+/g, '-').replace(/^-+|-+$/g, '');
    await writeFile(path.join(g.workspace, '.claude', '.codebase-memory-dirty'), `${hookId}\n`);
    const repoPath = await g.makeRepo(path.join(sw.root, 'solo'));
    // A repo's own AGENTS.md does not make it a workspace.
    await g.commit(repoPath, 'AGENTS.md', '# AGENTS.md — solo repo rules\n');
    const worktrees = g.manager({ sessions: sw.supervisor });
    token = generateToken();
    const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: sw.root }, platform: 'linux', home: sw.root, cwd: sw.root });
    app = await buildApp({ config: { ...base, port: PORT }, token, store: sw.store, webRoot: sw.root, supervisor: sw.supervisor, worktrees, providers: { diff: worktrees } });
    await app.ready();
    const workspace = (await call('POST', '/api/folders', { path: g.workspace })).json() as Folder;
    const repo = (await call('POST', '/api/folders', { path: repoPath })).json() as Folder;
    return { s: sw, g, workspace, repo, repoPath };
  }

  function call(method: InjectOptions['method'], url: string, payload?: unknown, cookie = true) {
    if (!app) throw new Error('no app');
    return app.inject({
      method,
      url,
      headers: { host: HOST, ...(cookie ? { cookie: `sb_token=${token}` } : {}), ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  }

  /** A repo-folder NewSession (`NewRepoSession`): no router fields, no solutions (the repo is the one). */
  function repoSession(folder: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const body: NewRepoSession = { name: 'solo-work', task: 'Tidy the README.', folder, worktrees: false, ultracode: false };
    return { ...body, ...overrides };
  }

  /** The session's spawn line and its first stdin user message's content. */
  async function spawnOf(s: SupervisorWorld, session: Session): Promise<{ cwd: string; first: string }> {
    const spawn = await until(async () => (await readFakeLog(s.logFile)).find((line) => line.kind === 'argv' && line.argv?.includes(session.claudeSessionId)), 'the spawn');
    const first = await until(async () => {
      const line = (await readFakeLog(s.logFile)).find((entry) => entry.kind === 'stdin' && entry.pid === spawn.pid);
      return line ? ((JSON.parse(line.line as string) as { message: { content: string } }).message.content) : undefined;
    }, 'the first message');
    return { cwd: spawn.cwd ?? '', first };
  }

  it('the routes: list with checks, check a path, add (201 / 200 / 422), default, remove (404 / 200); all behind the guard', async () => {
    const { g, workspace, repo, repoPath } = await setup();
    expect(workspace).toMatchObject({ path: g.workspace, kind: 'workspace', isDefault: true, check: { kind: 'workspace', router: { title: 'AGENTS.md (Workspace Router)' }, solutionCount: 2 } });
    expect(repo).toMatchObject({ path: repoPath, name: 'solo', kind: 'repo', isDefault: false, check: { kind: 'repo', repoName: 'solo', solutionCount: 1 } });
    const list = (await call('GET', '/api/folders')).json() as Folder[];
    expect(list.map((f) => [f.name, f.kind, f.isDefault])).toEqual([[path.basename(g.workspace), 'workspace', true], ['solo', 'repo', false]]);

    expect((await call('GET', `/api/folders/check?path=${encodeURIComponent(path.join(g.workspace, 'mobile'))}`)).json()).toMatchObject({ kind: 'repo', repoName: 'mobile' });
    expect((await call('GET', '/api/folders/check')).statusCode).toBe(400);
    const again = await call('POST', '/api/folders', { path: repoPath });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: repo.id });
    const bad = await call('POST', '/api/folders', { path: path.join(g.workspace, 'other') });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: 'invalid', message: 'folder not found', check: { problem: 'missing' } });
    expect((await call('POST', '/api/folders', {})).statusCode).toBe(422);
    expect((await call('POST', '/api/folders', { path: 'relative' })).json()).toMatchObject({ error: 'invalid', check: { problem: 'not-absolute' } });

    const moved = await call('PUT', `/api/folders/${repo.id}/default`);
    expect(moved.statusCode).toBe(200);
    expect((moved.json() as Folder[]).map((f) => [f.name, f.isDefault])).toEqual([['solo', true], [path.basename(g.workspace), false]]);
    expect((await call('PUT', '/api/folders/nope/default')).statusCode).toBe(404);
    expect((await call('DELETE', '/api/folders/nope')).statusCode).toBe(404);
    const left = await call('DELETE', `/api/folders/${repo.id}`);
    expect(left.statusCode).toBe(200);
    expect((left.json() as Folder[]).map((f) => [f.id, f.isDefault])).toEqual([[workspace.id, true]]);
    for (const [method, url] of [['GET', '/api/folders'], ['POST', '/api/folders'], ['DELETE', `/api/folders/${workspace.id}`], ['PUT', `/api/folders/${workspace.id}/default`]] as const) {
      expect((await call(method, url, undefined, false)).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('a repo folder without a worktree: the process runs in the repo, its one solution, no router fields, the task alone as the first message', async () => {
    const { s, repo, repoPath } = await setup();
    const response = await call('POST', '/api/sessions', repoSession(repo.id, { workType: 'qa', mode: 'orchestrator' }));
    expect(response.statusCode, response.body).toBe(201);
    const session = response.json() as Session;
    expect(session).toMatchObject({ solutions: ['solo'], workType: null, mode: null, phase: null, coordination: null, qaStack: null, folder: repo.id, folderPath: repoPath, folderKind: 'repo', cwd: repoPath });
    const { cwd, first } = await spawnOf(s, session);
    expect(cwd).toBe(repoPath);
    expect(first).toBe('Tidy the README.');
    expect(first).not.toContain(SESSION_START_HEADER[0]);
    await waitForStatus(s.store, session.id, ['done']);
    // The folder moved up the "recently used" order; the detail carries the folder too.
    expect((await call('GET', '/api/folders')).json()).toMatchObject([{ isDefault: true, lastUsedAt: null }, { id: repo.id, lastUsedAt: expect.any(String) }]);
    expect((await call('GET', `/api/sessions/${session.id}`)).json() as SessionDetail).toMatchObject({ folder: repo.id, folderKind: 'repo' });
  });

  it('a repo folder with a worktree: the process runs in ../<repo>-wt-<name>, the first message carries only the worktree note', async () => {
    const { s, g, repo, repoPath } = await setup();
    const response = await call('POST', '/api/sessions', repoSession(repo.id, { name: 'solo-wt', worktrees: true, solutions: ['solo'] }));
    expect(response.statusCode, response.body).toBe(201);
    const session = response.json() as Session;
    const worktree = path.join(path.dirname(repoPath), 'solo-wt-solo-wt');
    expect(session).toMatchObject({ cwd: worktree, folderPath: repoPath, folderKind: 'repo', solutions: ['solo'] });
    expect((await stat(worktree)).isDirectory()).toBe(true);
    expect(await g.git(worktree, 'symbolic-ref', '--short', 'HEAD')).toBe('session/solo-wt');
    const { cwd, first } = await spawnOf(s, session);
    expect(cwd).toBe(worktree);
    expect(first.split('\n')).toEqual([
      'Tidy the README.',
      '',
      REPO_WORKTREE_NOTE_HEADER,
      `- Worktree: ${worktree} (branch session/solo-wt, from main); it is your working folder: make every change here.`,
      `- Main checkout: ${repoPath} (leave it as it is).`,
    ]);
    // The session diff resolves in its own folder: the worktree against its base.
    await waitForStatus(s.store, session.id, ['done']);
    await writeFile(path.join(worktree, 'NOTES.md'), 'new\n');
    const diff = (await call('GET', `/api/sessions/${session.id}/diff`)).json() as Array<{ solution: string; path: string }>;
    expect(diff.map((file) => [file.solution, file.path])).toEqual([['solo', 'NOTES.md']]);
  });

  it('a repo folder allows only its own solution; an unknown folder id is refused; the default folder is used when none is named', async () => {
    const { s, g } = await setup();
    const repo = ((await call('GET', '/api/folders')).json() as Folder[]).find((f) => f.kind === 'repo') as Folder;
    const wrong = await call('POST', '/api/sessions', repoSession(repo.id, { solutions: ['web-front'] }));
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().errors).toEqual([{ field: 'solutions', message: 'a repo folder has one solution, solo' }]);
    const unknown = await call('POST', '/api/sessions', { ...newSession(), folder: 'nope' });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().errors.map((e: { field: string }) => e.field)).toEqual(['folder']);
    // Workspace (default) folder: router answers as before, cwd = the workspace root.
    const ws = await call('POST', '/api/sessions', newSession({ name: 'ws-work', solutions: ['web-front'] }));
    expect(ws.statusCode, ws.body).toBe(201);
    const session = ws.json() as Session;
    expect(session).toMatchObject({ cwd: g.workspace, folderPath: g.workspace, folderKind: 'workspace', workType: 'feature' });
    const { first } = await spawnOf(s, session);
    expect(first).toContain(SESSION_START_HEADER[0]);
    expect(first).toContain('- Solutions in scope: microfrontends/web-front');
  });

  it('GET /api/solutions?folder=: the default workspace, a repo as one group with one solution, a session folder by path; 404 for an unknown one', async () => {
    const { g, repo, repoPath } = await setup();
    const byDefault = (await call('GET', '/api/solutions')).json() as SolutionGroup[];
    expect(byDefault.map((group) => [group.folder, group.solutions.map((s) => s.name)])).toEqual([
      ['microfrontends/', ['web-front']],
      ['mobile/', ['mobile']],
    ]);
    // The workspace's dirty list marks mobile.
    expect(byDefault[1]?.solutions[0]?.codebaseMemory).toBe('dirty');
    const solo = (await call('GET', `/api/solutions?folder=${repo.id}`)).json() as SolutionGroup[];
    expect(solo).toHaveLength(1);
    expect(solo[0]).toMatchObject({ folder: 'solo/', rule: 'editable' });
    expect(solo[0]?.solutions).toEqual([
      expect.objectContaining({
        name: 'solo',
        path: repoPath,
        relativePath: '',
        type: 'Repo',
        rule: 'editable',
        status: 'idle',
        branches: [{ branch: 'main', worktree: null, sessionId: null, owner: 'idle', status: 'idle' }],
        codebaseMemory: 'unknown',
      }),
    ]);
    expect((await call('GET', `/api/solutions?folder=${encodeURIComponent(repoPath)}`)).statusCode).toBe(200);
    expect((await call('GET', '/api/solutions?folder=nope')).json()).toMatchObject({ error: 'not-found' });

    // A session in place in the repo shows on its row, whichever folder it was started from.
    const started = await call('POST', '/api/sessions', repoSession(repo.id, { name: 'solo-live', task: '' }));
    expect(started.statusCode, started.body).toBe(201);
    const rows = (await call('GET', `/api/solutions?folder=${repo.id}`)).json() as SolutionGroup[];
    expect(rows[0]?.solutions[0]?.branches).toEqual([{ branch: 'main', worktree: null, sessionId: (started.json() as Session).id, owner: 'solo-live', status: 'idle' }]);
    expect(g.workspace).not.toBe(repoPath);
  });

  it('GET /api/codebase-memory?folder=: a workspace has its dirty list, a repo folder none', async () => {
    const { repo } = await setup();
    const ws = (await call('GET', '/api/codebase-memory')).json() as CodebaseMemoryStatus;
    expect(ws.projects.map((p) => p.name)).toEqual(['mobile']);
    expect((await call('GET', `/api/codebase-memory?folder=${repo.id}`)).json()).toEqual({ projects: [], indexed: null });
    const nothing = await call('POST', `/api/codebase-memory/reindex?folder=${repo.id}`);
    expect(nothing.statusCode).toBe(409);
    expect(nothing.json()).toMatchObject({ error: 'nothing-to-reindex' });
    expect((await call('GET', '/api/codebase-memory?folder=nope')).statusCode).toBe(404);
  });
});

describe('NewSession typing (D14)', () => {
  it('folder is optional on NewSession; a repo folder takes the smaller NewRepoSession', () => {
    const body: NewSession = { ...newSession(), folder: null };
    expect(body.folder).toBeNull();
    const repo: NewRepoSession = { name: 'solo-work', task: 'x', folder: 'id', worktrees: false, ultracode: false };
    expect(Object.keys(repo).sort()).toEqual(['folder', 'name', 'task', 'ultracode', 'worktrees']);
  });
});
