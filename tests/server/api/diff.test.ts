import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { FileDiff } from '../../../src/core/api.ts';
import { isDiffFilePath } from '../../../src/server/api/sessions.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type GitWorld, forbiddenGitCalls, makeGitWorld } from '../../helpers/git.ts';

const PORT = 4873; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

/**
 * `GET /api/sessions/{id}/diff` (M4.5, gap #10) over the real WorktreeManager and
 * temp git repos: a worktree session (committed, staged, unstaged and untracked
 * changes against the merge-base) and an in-place session (against HEAD), `?file=`,
 * the per-file `uncommitted` flag behind the "Not committed" note, 404 and 422.
 */
let world: GitWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';

afterEach(async () => {
  await app?.close();
  await world?.cleanup();
  app = undefined;
  world = undefined;
});

async function setup(withProvider = true): Promise<GitWorld> {
  world = await makeGitWorld();
  const w = world;
  const manager = w.manager();
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: w.root }, platform: 'linux', home: w.root, cwd: w.root });
  await seedFolder(w.store, w.workspace);
  app = await buildApp({
    config: { ...base, port: PORT },
    token,
    store: w.store,
    webRoot: w.root,
    worktrees: manager,
    ...(withProvider ? { providers: { diff: manager } } : {}),
  });
  await app.ready();
  return w;
}

function get(url: string) {
  if (!app) throw new Error('no app');
  return app.inject({ method: 'GET', url, headers: { host: HOST, cookie: `sb_token=${token}` } });
}

async function sessionRow(w: GitWorld, name: string, solutions: string[], worktrees: boolean): Promise<string> {
  // D14: the session works in the world's workspace folder (in-place solutions resolve there).
  return (await w.store.sessions.create({ name, claudeSessionId: randomUUID(), solutions, worktrees, root: w.workspace, rootKind: 'workspace', cwd: w.workspace })).id;
}

describe('GET /api/sessions/{id}/diff (M4.5)', () => {
  it('worktree session: files vs the merge-base with branch, counts, lines and the uncommitted flag per file', async () => {
    const w = await setup();
    const id = await sessionRow(w, 'diff-api', ['web-front'], true);
    const [record] = await w.manager().createForSession('diff-api', ['web-front'], w.folder, id);
    if (!record) throw new Error('no worktree');
    // Committed on the session branch only (the developer approved it).
    await w.commit(record.path, 'src/app.txt', 'one\nTWO\nthree\n', 'approved change');
    // Committed, then changed again: still uncommitted.
    await w.commit(record.path, 'docs/plan.md', 'v1\n', 'plan');
    await writeFile(path.join(record.path, 'docs', 'plan.md'), 'v1\nv2\n');
    // Staged only.
    await writeFile(path.join(record.path, 'README.md'), 'hello\nstaged\n');
    await w.git(record.path, 'add', 'README.md');
    // Untracked.
    await mkdir(path.join(record.path, 'notes'));
    await writeFile(path.join(record.path, 'notes', 'new file.md'), '# New\n');

    // D90: the whole branch is `?scope=branch` (the default is since the last commit: diff-scope.test.ts).
    const response = await get(`/api/sessions/${id}/diff?scope=branch`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { solution: 'web-front', path: 'README.md', branch: 'session/diff-api', added: 1, removed: 0, lines: ['@@ -1 +1,2 @@', ' hello', '+staged'], uncommitted: true },
      { solution: 'web-front', path: 'docs/plan.md', branch: 'session/diff-api', added: 2, removed: 0, lines: ['@@ -0,0 +1,2 @@', '+v1', '+v2'], uncommitted: true },
      { solution: 'web-front', path: 'notes/new file.md', branch: 'session/diff-api', added: 1, removed: 0, lines: ['@@ -0,0 +1 @@', '+# New'], uncommitted: true },
      { solution: 'web-front', path: 'src/app.txt', branch: 'session/diff-api', added: 1, removed: 1, lines: ['@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three'], uncommitted: false },
    ] satisfies FileDiff[]);

    // ?file= narrows to one solution-relative path (spaces allowed, URL-encoded).
    const one = await get(`/api/sessions/${id}/diff?scope=branch&file=${encodeURIComponent('notes/new file.md')}`);
    expect(one.statusCode).toBe(200);
    expect((one.json() as FileDiff[]).map((f) => [f.path, f.uncommitted])).toEqual([['notes/new file.md', true]]);
    const committed = await get(`/api/sessions/${id}/diff?scope=branch&file=src/app.txt`);
    expect((committed.json() as FileDiff[]).map((f) => [f.path, f.uncommitted])).toEqual([['src/app.txt', false]]);
    expect((await get(`/api/sessions/${id}/diff?file=nope.txt`)).json()).toEqual([]);

    // The session detail carries the same files.
    const detail = (await get(`/api/sessions/${id}`)).json() as { files: FileDiff[] };
    expect(detail.files).toEqual(response.json());
    // Reading a diff never changes anyone's tree.
    expect(forbiddenGitCalls(await w.gitCalls())).toEqual([]);
    expect(w.errors).toEqual([]);
  });

  it('in-place session: uncommitted changes against HEAD, all marked uncommitted; branch = the checked-out branch', async () => {
    const w = await setup();
    const id = await sessionRow(w, 'in-place', ['mobile'], false);
    await w.commit(w.mobile, 'committed.txt', 'already committed\n');
    await writeFile(path.join(w.mobile, 'src', 'app.txt'), 'one\ntwo\n');
    // D90: every uncommitted change in the repo is `?scope=repo` (the default keeps only the session's own files).
    const response = await get(`/api/sessions/${id}/diff?scope=repo`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { solution: 'mobile', path: 'src/app.txt', branch: 'main', added: 0, removed: 1, lines: ['@@ -1,3 +1,2 @@', ' one', ' two', '-three'], uncommitted: true },
    ] satisfies FileDiff[]);
  });

  it('no changes → []; unknown session → 404; a bad ?file= → 422', async () => {
    const w = await setup();
    const id = await sessionRow(w, 'clean', ['mobile'], false);
    expect((await get(`/api/sessions/${id}/diff`)).json()).toEqual([]);

    const missing = await get('/api/sessions/nope/diff');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'not-found', message: 'no session nope' });

    for (const bad of ['', '/etc/passwd', '../outside.txt', 'src/../../x', 'C:/x', '\\\\server\\share']) {
      const response = await get(`/api/sessions/${id}/diff?file=${encodeURIComponent(bad)}`);
      expect(response.statusCode, bad).toBe(422);
      expect(response.json().errors[0].field, bad).toBe('file');
    }
    const twice = await get(`/api/sessions/${id}/diff?file=a.txt&file=b.txt`);
    expect(twice.statusCode).toBe(422);
  });

  it('without a diff provider the list is empty (the route still answers)', async () => {
    const w = await setup(false);
    const id = await sessionRow(w, 'no-provider', ['mobile'], false);
    await writeFile(path.join(w.mobile, 'src', 'app.txt'), 'changed\n');
    const response = await get(`/api/sessions/${id}/diff`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});

describe('isDiffFilePath', () => {
  it('accepts solution-relative paths only', () => {
    expect(isDiffFilePath('src/app.txt')).toBe(true);
    expect(isDiffFilePath('notes/new file.md')).toBe(true);
    expect(isDiffFilePath('a..b/c.txt')).toBe(true);
    expect(isDiffFilePath('')).toBe(false);
    expect(isDiffFilePath('  ')).toBe(false);
    expect(isDiffFilePath('/abs')).toBe(false);
    expect(isDiffFilePath('..')).toBe(false);
    expect(isDiffFilePath('a/../../b')).toBe(false);
    expect(isDiffFilePath('a\\..\\b')).toBe(false);
    expect(isDiffFilePath('D:\\x')).toBe(false);
    expect(isDiffFilePath('a\0b')).toBe(false);
    expect(isDiffFilePath(['a'])).toBe(false);
  });
});
