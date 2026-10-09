import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Worktree } from '../../../src/core/api.ts';
import { buildApp, createSupervisor, createWorktreeManager } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { WorktreeManager } from '../../../src/server/worktrees/manager.ts';
import { folderRef } from '../../helpers/folders.ts';
import { type GitWorld, forbiddenGitCalls, makeGitWorld } from '../../helpers/git.ts';
import { until } from '../../helpers/supervisor.ts';

let world: GitWorld | undefined;

afterEach(async () => {
  await world?.cleanup();
  world = undefined;
});

async function setup(): Promise<{ w: GitWorld; m: WorktreeManager }> {
  world = await makeGitWorld();
  return { w: world, m: world.manager() };
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function branchExists(w: GitWorld, repo: string, branch: string): Promise<boolean> {
  return (await w.git(repo, 'branch', '--list', branch)) !== '';
}

async function newSessionRow(w: GitWorld, name: string, solutions: string[]): Promise<string> {
  // D14: the session works in the world's workspace folder (in-place diffs resolve there).
  const session = await w.store.sessions.create({ name, claudeSessionId: randomUUID(), solutions, worktrees: solutions.length > 0, root: w.workspace, rootKind: 'workspace', cwd: w.workspace });
  return session.id;
}

describe('WorktreeManager · create (gap #1)', () => {
  it('creates session/{name} from HEAD at ../{repo}-wt-{name} for each solution, registers it and leaves the main checkout alone', async () => {
    const { w, m } = await setup();
    await writeFile(path.join(w.web, 'README.md'), 'hello\ndeveloper edit\n');
    await writeFile(path.join(w.web, 'scratch.txt'), 'untracked\n');
    const statusBefore = await w.git(w.web, 'status', '--porcelain');
    const head = await w.git(w.web, 'rev-parse', 'HEAD');

    const records = await m.createForSession('free-talk', ['web-front', 'mobile'], w.folder);

    const webPath = path.join(path.dirname(w.web), 'web-front-wt-free-talk');
    const mobilePath = path.join(w.workspace, 'mobile-wt-free-talk');
    expect(records.map((r) => [r.repo, r.repoPath, r.branch, r.baseRef, r.path, r.sessionId])).toEqual([
      ['web-front', w.web, 'session/free-talk', 'main', webPath, null],
      ['mobile', w.mobile, 'session/free-talk', 'main', mobilePath, null],
    ]);
    expect(await w.git(w.web, 'rev-parse', 'session/free-talk')).toBe(head);
    expect(await w.git(w.web, 'worktree', 'list', '--porcelain')).toContain(`worktree ${webPath}`);
    expect(await w.git(webPath, 'symbolic-ref', '--short', 'HEAD')).toBe('session/free-talk');
    // The worktree starts from HEAD: the developer's uncommitted edit is not in it.
    expect(await readFile(path.join(webPath, 'README.md'), 'utf8')).toBe('hello\n');
    // The main checkout is untouched: same branch, same dirty state, nothing stashed.
    expect(await w.git(w.web, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(await w.git(w.web, 'status', '--porcelain')).toBe(statusBefore);
    expect(await w.git(w.web, 'stash', 'list')).toBe('');
    expect((await w.store.worktrees.list()).map((r) => r.path)).toEqual([webPath, mobilePath]);

    const calls = await w.gitCalls();
    expect(forbiddenGitCalls(calls)).toEqual([]);
    const adds = calls.filter((c) => c.argv[0] === 'worktree' && c.argv[1] === 'add');
    expect(adds.map((c) => c.cwd)).toEqual([w.web, w.mobile]);
    expect(adds[0]?.argv).toEqual(['worktree', 'add', '-b', 'session/free-talk', webPath, head]);
  });

  it('a detached HEAD is the base itself', async () => {
    const { w, m } = await setup();
    const head = await w.git(w.mobile, 'rev-parse', 'HEAD');
    await w.git(w.mobile, 'checkout', '-q', '--detach');
    const [record] = await m.createForSession('detached', ['mobile'], w.folder);
    expect(record?.baseRef).toBe(head);
  });

  it('accepts a relative path and the router groups; a worktree folder is not a solution (gap #16)', async () => {
    const { w, m } = await setup();
    const tool = await w.makeRepo(path.join(w.workspace, 'other', 'tool'));
    expect(await m.resolveRepo('other/tool', w.folder)).toEqual({ solution: 'other/tool', repoPath: tool });
    expect(await m.resolveRepo('tool', w.folder)).toEqual({ solution: 'tool', repoPath: tool });
    await m.createForSession('wt', ['web-front'], w.folder);
    await expect(m.resolveRepo('web-front-wt-wt', w.folder)).rejects.toMatchObject({ code: 'solution-not-found' });
  });

  it('a solution folder that is not a repo but holds exactly one resolves to it; its worktree sits next to the nested repo', async () => {
    const { w, m } = await setup();
    const inner = await w.makeRepo(path.join(w.workspace, 'other', 'nest', 'inner'));
    expect(await m.resolveRepo('nest', w.folder)).toEqual({ solution: 'nest', repoPath: inner });
    const [record] = await m.createForSession('n1', ['nest'], w.folder);
    expect(record?.path).toBe(path.join(w.workspace, 'other', 'nest', 'inner-wt-n1'));
    // The worktree beside it (`.git` is a file) does not make the folder ambiguous.
    expect(await m.resolveRepo('nest', w.folder)).toEqual({ solution: 'nest', repoPath: inner });
  });

  it('refusals leave nothing behind', async () => {
    const { w, m } = await setup();
    await w.git(w.mobile, 'branch', 'session/taken');
    await expect(m.createForSession('taken', ['web-front', 'mobile'], w.folder)).rejects.toMatchObject({ code: 'branch-exists' });
    expect(await exists(path.join(path.dirname(w.web), 'web-front-wt-taken'))).toBe(false);
    expect(await branchExists(w, w.web, 'session/taken')).toBe(false);

    await mkdir(path.join(w.workspace, 'mobile-wt-occupied'));
    await expect(m.createForSession('occupied', ['mobile'], w.folder)).rejects.toMatchObject({ code: 'path-exists' });

    await expect(m.createForSession('x', ['nope-front'], w.folder)).rejects.toMatchObject({ code: 'solution-not-found' });
    await expect(m.createForSession('x', ['deprecated/microfrontends/old-front'], w.folder)).rejects.toMatchObject({ code: 'read-only' });
    await expect(m.createForSession('x', ['infrastructure'], w.folder)).rejects.toMatchObject({ code: 'read-only' });
    await expect(m.createForSession('x', ['../elsewhere'], w.folder)).rejects.toMatchObject({ code: 'solution-not-found' });

    await w.makeRepo(path.join(w.workspace, 'nugets', 'mobile'));
    await expect(m.createForSession('x', ['mobile'], w.folder)).rejects.toMatchObject({ code: 'solution-ambiguous' });

    const empty = path.join(w.workspace, 'functions', 'empty-func');
    await mkdir(empty, { recursive: true });
    await w.git(empty, 'init', '-q', '-b', 'main');
    await expect(m.createForSession('x', ['empty-func'], w.folder)).rejects.toMatchObject({ code: 'no-commits' });

    // D14: a folder that is gone from disk.
    await expect(m.createForSession('x', ['web-front'], folderRef(path.join(w.root, 'missing')))).rejects.toMatchObject({ code: 'folder-missing' });
    expect(await w.store.worktrees.list({ includeRemoved: true })).toEqual([]);
  });

  it('a git failure part-way removes the worktrees this call made (and their fresh branches)', async () => {
    const { w, m } = await setup();
    // A stale ref lock makes `git worktree add -b session/half` fail in mobile only.
    await mkdir(path.join(w.mobile, '.git', 'refs', 'heads', 'session'), { recursive: true });
    await writeFile(path.join(w.mobile, '.git', 'refs', 'heads', 'session', 'half.lock'), '');
    await expect(m.createForSession('half', ['web-front', 'mobile'], w.folder)).rejects.toMatchObject({ code: 'git-failed' });
    const webPath = path.join(path.dirname(w.web), 'web-front-wt-half');
    expect(await exists(webPath)).toBe(false);
    expect(await branchExists(w, w.web, 'session/half')).toBe(false);
    expect(await w.git(w.web, 'worktree', 'list', '--porcelain')).not.toContain(webPath);
    expect(await w.store.worktrees.list()).toEqual([]);
    expect(forbiddenGitCalls(await w.gitCalls())).toEqual([]);
  });
});

describe('WorktreeManager · remove (gap #3)', () => {
  it('removes a clean worktree with nothing unpushed; the branch is kept; never --force', async () => {
    const { w, m } = await setup();
    const [record] = await m.createForSession('clean', ['web-front'], w.folder);
    if (!record) throw new Error('no worktree');
    expect(await m.inspect(record.id)).toEqual({ exists: true, uncommitted: 0, unpushed: 0 });
    const removed = await m.remove(record.id);
    expect(removed.removedAt).not.toBeNull();
    expect(removed.removable).toBe(false);
    expect(await exists(record.path)).toBe(false);
    expect(await branchExists(w, w.web, 'session/clean')).toBe(true);
    expect(await w.git(w.web, 'worktree', 'list', '--porcelain')).not.toContain(record.path);
    const calls = await w.gitCalls();
    expect(forbiddenGitCalls(calls)).toEqual([]);
    expect(calls.filter((c) => c.argv[1] === 'remove').map((c) => [c.cwd, c.argv])).toEqual([[w.web, ['worktree', 'remove', record.path]]]);
    await expect(m.remove(record.id)).rejects.toMatchObject({ code: 'removed' });
    await expect(m.remove('nope')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses uncommitted changes (modified or untracked) and keeps the folder', async () => {
    const { w, m } = await setup();
    const [record] = await m.createForSession('dirty', ['web-front'], w.folder);
    if (!record) throw new Error('no worktree');
    await writeFile(path.join(record.path, 'src', 'app.txt'), 'changed\n');
    await expect(m.remove(record.id)).rejects.toMatchObject({ code: 'uncommitted', message: expect.stringContaining('1 uncommitted change') });
    await w.git(record.path, 'restore', 'src/app.txt');
    await writeFile(path.join(record.path, 'new.txt'), 'new\n');
    await expect(m.remove(record.id)).rejects.toMatchObject({ code: 'uncommitted' });
    expect(await exists(record.path)).toBe(true);
    expect((await w.store.worktrees.get(record.id))?.removedAt).toBeNull();
  });

  it('refuses unpushed commits; allows them once pushed', async () => {
    const { w, m } = await setup();
    const [web, mobile] = await m.createForSession('ahead', ['web-front', 'mobile'], w.folder);
    if (!web || !mobile) throw new Error('no worktree');
    await w.commit(web.path, 'src/feature.txt', 'feature\n');
    await w.commit(mobile.path, 'src/feature.txt', 'feature\n');
    expect(await m.inspect(web.id)).toEqual({ exists: true, uncommitted: 0, unpushed: 1 });
    await expect(m.remove(web.id)).rejects.toMatchObject({ code: 'unpushed', message: expect.stringContaining('1 commit') });
    await expect(m.remove(mobile.id)).rejects.toMatchObject({ code: 'unpushed' });
    await w.git(web.path, 'push', '-q', '-u', 'origin', 'session/ahead');
    expect(await m.inspect(web.id)).toEqual({ exists: true, uncommitted: 0, unpushed: 0 });
    expect((await m.remove(web.id)).removedAt).not.toBeNull();
    expect(await branchExists(w, w.web, 'session/ahead')).toBe(true);
  });

  it('commits already on the base branch are not "unpushed"', async () => {
    const { w, m } = await setup();
    await w.commit(w.mobile, 'local.txt', 'local only\n');
    const [record] = await m.createForSession('base', ['mobile'], w.folder);
    if (!record) throw new Error('no worktree');
    expect(await m.inspect(record.id)).toEqual({ exists: true, uncommitted: 0, unpushed: 0 });
  });

  it('a folder deleted by hand just leaves the registry', async () => {
    const { w, m } = await setup();
    const [record] = await m.createForSession('gone', ['mobile'], w.folder);
    if (!record) throw new Error('no worktree');
    await rm(record.path, { recursive: true, force: true });
    expect(await m.inspect(record.id)).toEqual({ exists: false, uncommitted: 0, unpushed: 0 });
    expect((await m.remove(record.id)).removedAt).not.toBeNull();
    expect((await w.gitCalls()).filter((c) => c.argv[1] === 'remove')).toEqual([]);
  });
});

describe('WorktreeManager · pull requests (gh pr view)', () => {
  it('stores the PR state verbatim; removable only when MERGED and removal would be allowed; worktreeRemovable fires once', async () => {
    const { w, m } = await setup();
    const sessionId = await newSessionRow(w, 'pr-flow', ['web-front']);
    const [record] = await m.createForSession('pr-flow', ['web-front'], w.folder, sessionId);
    if (!record) throw new Error('no worktree');
    const events: Worktree[] = [];
    m.on('worktreeRemovable', (worktree) => events.push(worktree));
    const url = 'https://github.com/acme/web-front/pull/231';
    await w.store.artifacts.upsert({ id: 'pr-artifact', type: 'PR', name: 'web-front #231', url, sessionId });

    expect(await m.checkPullRequests()).toEqual([{ worktreeId: record.id, prState: null, removable: false, error: null }]);
    const checked = await w.store.worktrees.get(record.id);
    expect(checked?.prCheckedAt).not.toBeNull();
    expect(checked?.prNumber).toBeNull();
    const gh = await w.ghCalls();
    expect(gh).toEqual([{ argv: ['pr', 'view', 'session/pr-flow', '--json', 'number,state,url,headRefOid'], cwd: record.path }]);

    await w.setPullRequests({ 'session/pr-flow': { number: 231, state: 'OPEN', url, headRefOid: await w.git(record.path, 'rev-parse', 'HEAD') } });
    expect((await m.checkPullRequests())[0]).toMatchObject({ prState: 'OPEN', removable: false });
    expect(await w.store.worktrees.get(record.id)).toMatchObject({ prNumber: 231, prUrl: url, prState: 'OPEN', removable: false });
    expect((await w.store.artifacts.get('pr-artifact'))?.meta).toBe('open');

    await w.setPullRequests({ 'session/pr-flow': { number: 231, state: 'MERGED', url } });
    await writeFile(path.join(record.path, 'leftover.txt'), 'not committed\n');
    expect((await m.checkPullRequests())[0]).toMatchObject({ prState: 'MERGED', removable: false });
    expect(events).toEqual([]);
    expect((await w.store.artifacts.get('pr-artifact'))?.meta).toBe('merged');

    await rm(path.join(record.path, 'leftover.txt'));
    expect((await m.checkPullRequests())[0]).toMatchObject({ prState: 'MERGED', removable: true });
    expect(events).toEqual([
      { id: record.id, repo: 'web-front', branch: 'session/pr-flow', path: record.path, sessionId, prNumber: 231, prState: 'MERGED', removable: true },
    ]);
    await m.checkPullRequests();
    expect(events).toHaveLength(1);
    expect(forbiddenGitCalls(await w.gitCalls())).toEqual([]);
  });

  it('CLOSED is not removable; a gh failure leaves the row as it was', async () => {
    const { w, m } = await setup();
    const [record] = await m.createForSession('closed', ['mobile'], w.folder);
    if (!record) throw new Error('no worktree');
    await w.setPullRequests({ 'session/closed': { number: 3, state: 'CLOSED', url: 'https://github.com/acme/mobile/pull/3' } });
    expect((await m.checkPullRequests())[0]).toMatchObject({ prState: 'CLOSED', removable: false, error: null });
    const before = await w.store.worktrees.get(record.id);
    const failing = w.manager({ ghCommand: [process.execPath, '-e', 'process.stderr.write("error connecting to api.github.com\\n"); process.exit(1)'] });
    const [result] = await failing.checkPullRequests();
    expect(result?.error).toContain('error connecting to api.github.com');
    expect(await w.store.worktrees.get(record.id)).toEqual(before);
    const garbled = w.manager({ ghCommand: [process.execPath, '-e', 'process.stdout.write("not json")'] });
    expect((await garbled.checkPullRequests())[0]?.error).toContain('unexpected shape');
  });

  it('a squash-merged PR whose remote branch was deleted: its head commit counts as pushed', async () => {
    const { w, m } = await setup();
    const [record] = await m.createForSession('squash', ['web-front'], w.folder);
    if (!record) throw new Error('no worktree');
    const head = await w.commit(record.path, 'src/squash.txt', 'squashed\n');
    await w.git(record.path, 'push', '-q', '-u', 'origin', 'session/squash');
    await w.git(record.path, 'push', '-q', 'origin', '--delete', 'session/squash');
    await w.git(record.path, 'fetch', '-q', '--prune', 'origin');
    expect((await m.inspect(record.id)).unpushed).toBe(1);
    await w.setPullRequests({ 'session/squash': { number: 9, state: 'MERGED', url: 'https://github.com/acme/web-front/pull/9', headRefOid: head } });
    expect((await m.checkPullRequests())[0]).toMatchObject({ prState: 'MERGED', removable: true });
    expect((await m.remove(record.id)).removedAt).not.toBeNull();
    expect((await w.ghCalls()).at(-1)?.argv).toEqual(['pr', 'view', '9', '--json', 'number,state,url,headRefOid']);
  });

  it('polls on a timer until stopped', async () => {
    const { w, m } = await setup();
    await m.createForSession('poll', ['mobile'], w.folder);
    m.startPolling({ intervalMs: 30, initialDelayMs: 0 });
    await until(async () => (await w.ghCalls()).length >= 2, 'two polls');
    await m.stopPolling();
    const count = (await w.ghCalls()).length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await w.ghCalls()).length).toBe(count);
  });

  it('SWITCHBOARD_GH_BIN reaches the manager built from the config', async () => {
    const { w } = await setup();
    const log = path.join(w.root, 'gh-bin.log');
    const script = `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(1)) + '\\n'); process.stdout.write('{"number":5,"state":"OPEN"}')`;
    const config = loadConfig({ env: { SWITCHBOARD_DATA_DIR: w.root, SWITCHBOARD_GH_BIN: JSON.stringify([process.execPath, '-e', script]) }, platform: 'linux', home: w.root, cwd: w.root });
    await w.manager().createForSession('config', ['mobile'], w.folder);
    const supervisor = createSupervisor(config, w.store);
    const manager = createWorktreeManager(config, w.store, supervisor);
    expect((await manager.checkPullRequests())[0]).toMatchObject({ prState: 'OPEN', error: null });
    expect((await readFile(log, 'utf8')).trim()).toBe(JSON.stringify(['pr', 'view', 'session/config', '--json', 'number,state,url,headRefOid']));
    // buildApp makes the same manager when none is passed.
    const app = await buildApp({ config, token: 't', store: w.store, webRoot: w.root, supervisor });
    await app.close();
  });
});

describe('WorktreeManager · diff (gap #10)', () => {
  it('worktree: vs the merge-base with its base branch, committed + uncommitted + untracked; later base commits are not in it', async () => {
    const { w, m } = await setup();
    const sessionId = await newSessionRow(w, 'diff', ['web-front']);
    const [record] = await m.createForSession('diff', ['web-front'], w.folder, sessionId);
    if (!record) throw new Error('no worktree');
    await w.commit(record.path, 'src/app.txt', 'one\nTWO\nthree\n', 'change two');
    await writeFile(path.join(record.path, 'README.md'), 'hello again\n');
    await mkdir(path.join(record.path, 'notes'));
    await writeFile(path.join(record.path, 'notes', 'new.md'), '# New\nline\n');
    await writeFile(path.join(record.path, 'img.bin'), Buffer.from([0, 1, 2, 3]));
    await w.commit(w.web, 'src/other.txt', 'main moved on\n', 'main moves');

    const files = await m.diff(sessionId);
    expect(files).toEqual([
      { solution: 'web-front', path: 'README.md', branch: 'session/diff', added: 1, removed: 1, lines: ['@@ -1 +1 @@', '-hello', '+hello again'], uncommitted: true },
      { solution: 'web-front', path: 'img.bin', branch: 'session/diff', added: 0, removed: 0, lines: [], uncommitted: true },
      { solution: 'web-front', path: 'notes/new.md', branch: 'session/diff', added: 2, removed: 0, lines: ['@@ -0,0 +1,2 @@', '+# New', '+line'], uncommitted: true },
      // Committed on the session branch: in the diff (vs the merge-base), no longer uncommitted (M4.5).
      { solution: 'web-front', path: 'src/app.txt', branch: 'session/diff', added: 1, removed: 1, lines: ['@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three'], uncommitted: false },
    ]);
    expect((await m.diff(sessionId, 'src/app.txt')).map((f) => f.path)).toEqual(['src/app.txt']);
    expect((await m.diff(sessionId, 'notes/new.md')).map((f) => f.path)).toEqual(['notes/new.md']);
    expect(await m.diff('no-such-session')).toEqual([]);
    expect(forbiddenGitCalls(await w.gitCalls())).toEqual([]);
  });

  it('in place: each solution in scope against its HEAD (uncommitted only); unknown solutions are skipped', async () => {
    const { w, m } = await setup();
    const sessionId = await newSessionRow(w, 'in-place', ['mobile', 'nope-front']);
    await w.commit(w.mobile, 'committed.txt', 'committed\n');
    await writeFile(path.join(w.mobile, 'src', 'app.txt'), 'one\ntwo\nthree\nfour\n');
    expect(await m.diff(sessionId)).toEqual([
      { solution: 'mobile', path: 'src/app.txt', branch: 'main', added: 1, removed: 0, lines: ['@@ -1,3 +1,4 @@', ' one', ' two', ' three', '+four'], uncommitted: true },
    ]);
    expect(w.errors).toEqual([]);
  });
});
