import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type CleanupItem, type CleanupRun, type CleanupScan, runRequestOf } from '../../../src/core/cleanup.ts';
import { CleanupError, CleanupService, statusPaths } from '../../../src/server/cleanup/service.ts';
import { createdBranches } from '../../../src/server/cleanup/created-branches.ts';
import type { WorktreeRecord } from '../../../src/server/db/repos/worktrees.ts';
import { GIT_SPY_COMMAND, type GitWorld, makeGitWorld } from '../../helpers/git.ts';

const DAY = 86_400_000;
let world: GitWorld | undefined;

afterEach(async () => {
  await world?.cleanup();
  world = undefined;
});

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

interface Setup {
  readonly w: GitWorld;
  readonly dataDir: string;
  service(options?: { readonly daysAhead?: number; readonly live?: ReadonlySet<string>; readonly leftovers?: Parameters<typeof leftoverStub>[0] }): CleanupService;
}

function leftoverStub(entries: { id: string; repoPath: string; remoteName: string; remoteUrl: string; branch: string; at: string; reason: string | null }[], deleted: string[]) {
  return {
    listLeftovers: async () => entries.filter((entry) => !deleted.includes(entry.id)),
    deleteLeftover: async (id: string) => {
      deleted.push(id);
      return { result: { deleted: true }, log: [] };
    },
    hasTarget: () => false,
  };
}

async function setup(): Promise<Setup> {
  world = await makeGitWorld();
  const w = world;
  const dataDir = path.join(w.root, 'data');
  await mkdir(dataDir, { recursive: true });
  return {
    w,
    dataDir,
    service(options = {}) {
      const now = Date.now() + (options.daysAhead ?? 0) * DAY;
      return new CleanupService({
        store: w.store,
        dataDir,
        gitCommand: GIT_SPY_COMMAND,
        env: w.env,
        now: () => new Date(now),
        isLive: (id) => options.live?.has(id) ?? false,
        ...(options.leftovers ? { takeover: leftoverStub(options.leftovers, []) } : {}),
      });
    },
  };
}

async function session(w: GitWorld, name: string, closedDaysAgo: number | null): Promise<string> {
  const created = await w.store.sessions.create({ name, claudeSessionId: randomUUID(), solutions: ['web-front'], worktrees: true, root: w.workspace, rootKind: 'workspace', cwd: w.workspace });
  if (closedDaysAgo !== null) await w.store.sessions.update(created.id, { closedAt: new Date(Date.now() - closedDaysAgo * DAY).toISOString() });
  return created.id;
}

/** A Switchboard worktree (`session/<name>`) of web-front for a session, with one commit. */
async function sessionWorktree(w: GitWorld, name: string, sessionId: string, commit = true): Promise<WorktreeRecord> {
  const m = w.manager();
  const [record] = await m.createForSession(name, ['web-front'], w.folder);
  await m.assign([record as WorktreeRecord], sessionId);
  if (commit) await w.commit((record as WorktreeRecord).path, `${name}.txt`, `${name}\n`);
  return (await w.store.worktrees.get((record as WorktreeRecord).id)) as WorktreeRecord;
}

async function run(service: CleanupService, scan: CleanupScan, ids: readonly string[]): Promise<CleanupRun> {
  const selected = new Set(ids);
  const started = await service.start(runRequestOf(scan.items, selected));
  await service.idle();
  return service.get(started.id) as CleanupRun;
}

function byGroup(scan: CleanupScan, group: CleanupItem['group']): CleanupItem[] {
  return scan.items.filter((item) => item.group === group);
}

async function branches(w: GitWorld, repo: string): Promise<string[]> {
  return (await w.git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).split('\n').filter(Boolean).sort();
}

describe('Clean-up · what is listed (D84)', () => {
  it('lists only what Switchboard created: never the developer’s branches, worktrees or look-alike names', async () => {
    const { w, service } = await setup();
    const closed = await session(w, 'alpha', 40);
    const record = await sessionWorktree(w, 'alpha', closed);
    // The developer's own things: a merged branch, a pushed branch, a worktree, a look-alike `session/…` branch.
    await w.git(w.web, 'branch', 'feature/mine');
    await w.git(w.web, 'push', '-q', 'origin', 'feature/mine');
    await w.git(w.web, 'branch', 'session/handmade');
    await w.git(w.web, 'worktree', 'add', '-q', '-b', 'dev/own', path.join(w.root, 'own-wt'));
    // A worktree on a branch Switchboard did not create (a reused one): the worktree is Switchboard's, the branch is not.
    await w.git(w.web, 'branch', 'feature/reused');
    const reusedPath = path.join(w.root, 'reused-wt');
    await w.git(w.web, 'worktree', 'add', '-q', reusedPath, 'feature/reused');
    const reused = await w.store.worktrees.create({ repo: 'web-front', repoPath: w.web, branch: 'feature/reused', baseRef: 'main', path: reusedPath, sessionId: closed });

    const scan = await service({ daysAhead: 20 }).scan();
    const titles = scan.items.map((item) => item.title);
    expect(byGroup(scan, 'worktrees').map((item) => item.title).sort()).toEqual([record.path, reusedPath].sort());
    // D84 ruling: a branch only a worktrees row names is listed when merged (feature/reused is at main), never ticked.
    expect(byGroup(scan, 'localBranches').map((item) => [item.title, item.selected])).toEqual([
      ['feature/reused', false],
      ['session/alpha', false],
    ]);
    expect(byGroup(scan, 'remoteBranches')).toEqual([]);
    for (const foreign of ['feature/mine', 'session/handmade', 'dev/own', 'origin/feature/mine', path.join(w.root, 'own-wt')]) expect(titles).not.toContain(foreign);
    expect(reused.branch).toBe('feature/reused');
    // The marker records what Switchboard made.
    expect((await createdBranches(w.store.settings)).map((entry) => [entry.branch, entry.kind])).toEqual([['session/alpha', 'new']]);
    // A scan changes nothing.
    expect(await branches(w, w.web)).toEqual(['dev/own', 'feature/mine', 'feature/reused', 'main', 'session/alpha', 'session/handmade']);
    expect(await exists(record.path)).toBe(true);
  });

  it('a worktree goes when merged, or when its session is closed and it saw no change for 14 days, or its folder is gone; an open or running session’s is kept', async () => {
    const { w, service } = await setup();
    const open = await session(w, 'open1', null);
    const openWt = await sessionWorktree(w, 'open1', open);
    const closed = await session(w, 'closed1', 2);
    const closedWt = await sessionWorktree(w, 'closed1', closed);
    const merged = await session(w, 'merged1', 2);
    const mergedWt = await sessionWorktree(w, 'merged1', merged);
    await w.git(w.web, 'merge', '-q', '--ff-only', 'session/merged1');
    const gone = await session(w, 'gone1', 1);
    const goneWt = await sessionWorktree(w, 'gone1', gone);
    await w.git(w.web, 'worktree', 'lock', goneWt.path).catch(() => undefined);
    await w.git(w.web, 'worktree', 'unlock', goneWt.path).catch(() => undefined);
    await import('node:fs/promises').then(({ rm }) => rm(goneWt.path, { recursive: true, force: true }));
    const live = await session(w, 'live1', 30);
    await sessionWorktree(w, 'live1', live);

    const today = await service({ live: new Set([live]) }).scan();
    const listed = Object.fromEntries(byGroup(today, 'worktrees').map((item) => [item.title, item.reasons]));
    expect(listed).toEqual({ [mergedWt.path]: ['merged', 'session-closed'], [goneWt.path]: ['folder-missing', 'session-closed'] });

    const later = await service({ daysAhead: 15, live: new Set([live]) }).scan();
    const listedLater = Object.fromEntries(byGroup(later, 'worktrees').map((item) => [item.title, item.reasons]));
    expect(listedLater[closedWt.path]).toEqual(['stale', 'session-closed']);
    expect(listedLater[openWt.path]).toBeUndefined();
    expect(Object.keys(listedLater)).toHaveLength(3);
  });

  it('a PR-merged worktree of an open session is listed; sizes, ages and exactly what goes are shown', async () => {
    const { w, service } = await setup();
    const open = await session(w, 'pr1', null);
    const record = await sessionWorktree(w, 'pr1', open);
    await w.store.worktrees.update(record.id, { prState: 'MERGED', prNumber: 7 });
    const [item] = byGroup(await service().scan(), 'worktrees');
    expect(item?.reasons).toEqual(['pr-merged']);
    expect(item?.removes).toEqual([`the folder ${record.path} (git worktree remove)`]);
    expect(item?.keeps).toEqual(['the branch session/pr1 and its commits']);
    expect(item?.sizeBytes).toBeGreaterThan(0);
    expect(item?.lastChangeAt).not.toBeNull();
    expect(item?.selected).toBe(true);
  });
});

describe('Clean-up · older ticket-named task branches (D84 ruling)', () => {
  it('listed only when a worktrees row names them and they are merged; unticked; never an unmerged one or one without a row, never their remote copy', async () => {
    const { w, service } = await setup();
    const closed = await session(w, 'legacy', 40);
    const rowFor = async (branch: string, commit: boolean): Promise<void> => {
      const dir = path.join(w.root, branch.replace(/\//g, '-'));
      await w.git(w.web, 'worktree', 'add', '-q', '-b', branch, dir);
      if (commit) await w.commit(dir, `${branch.replace(/\//g, '-')}.txt`, 'x\n');
      await w.git(w.web, 'worktree', 'remove', dir);
      const record = await w.store.worktrees.create({ repo: 'web-front', repoPath: w.web, branch, baseRef: 'main', path: dir, sessionId: closed });
      await w.store.worktrees.markRemoved(record.id);
    };
    // Merged into main, named by a removed row (a task branch from before the created-branches record).
    await rowFor('PROJ-1-merged-task', true);
    await w.git(w.web, 'merge', '-q', '--ff-only', 'PROJ-1-merged-task');
    await w.git(w.web, 'push', '-q', 'origin', 'PROJ-1-merged-task');
    await w.git(w.web, 'fetch', '-q', 'origin');
    // Named by a row but not merged.
    await rowFor('PROJ-2-open-task', true);
    // Merged but no row names it.
    await w.git(w.web, 'branch', 'PROJ-3-no-row');
    const svc = service();
    const scan = await svc.scan();
    const local = byGroup(scan, 'localBranches');
    expect(local.map((item) => [item.title, item.selected, item.confirm, item.reasons])).toEqual([
      ['PROJ-1-merged-task', false, null, ['merged', 'worktree-gone', 'session-closed', 'untracked-origin']],
    ]);
    expect(scan.items.map((item) => item.title).filter((title) => title.includes('PROJ-2') || title.includes('PROJ-3'))).toEqual([]);
    expect(byGroup(scan, 'remoteBranches')).toEqual([]);
    // Ticked by hand it goes; the others stay.
    const done = await run(svc, scan, local.map((item) => item.id));
    expect(done.summary).toMatchObject({ done: 1, failed: 0 });
    expect(await branches(w, w.web)).toEqual(['PROJ-2-open-task', 'PROJ-3-no-row', 'main']);
  });
});

describe('Clean-up · protections (D84)', () => {
  it('uncommitted changes: listed with the files, never ticked, refused without the confirmation, removed with it', async () => {
    const { w, service } = await setup();
    const closed = await session(w, 'dirty', 40);
    const record = await sessionWorktree(w, 'dirty', closed);
    await writeFile(path.join(record.path, 'README.md'), 'changed\n');
    await writeFile(path.join(record.path, 'notes.txt'), 'new\n');
    const svc = service({ daysAhead: 20 });
    const scan = await svc.scan();
    const [item] = byGroup(scan, 'worktrees');
    expect(item?.confirm).toBe('uncommitted');
    expect(item?.selected).toBe(false);
    expect([...(item?.warnings[0]?.files ?? [])].sort()).toEqual(['README.md', 'notes.txt']);
    await expect(svc.start({ items: [{ id: item?.id as string, fingerprint: item?.fingerprint as string }] })).rejects.toMatchObject({ status: 422, code: 'confirmation-required' });
    expect(await exists(record.path)).toBe(true);
    const done = await run(svc, scan, [item?.id as string]);
    expect(done.items.map((entry) => [entry.status, entry.error])).toEqual([['done', null]]);
    expect(await exists(record.path)).toBe(false);
    expect((await w.store.worktrees.get(record.id))?.removedAt).not.toBeNull();
    // The branch and its commit are kept.
    expect(await branches(w, w.web)).toContain('session/dirty');
  });

  it('a change that appears after the preview stops that worktree (nothing lost)', async () => {
    const { w, service } = await setup();
    const closed = await session(w, 'late', 40);
    const record = await sessionWorktree(w, 'late', closed);
    await writeFile(path.join(record.path, 'a.txt'), 'a\n');
    const svc = service({ daysAhead: 20 });
    const scan = await svc.scan();
    await writeFile(path.join(record.path, 'b.txt'), 'b\n');
    const done = await run(svc, scan, byGroup(scan, 'worktrees').map((item) => item.id));
    expect(done.items[0]?.status).toBe('failed');
    expect(done.items[0]?.error).toMatch(/changed since the preview/);
    expect(await exists(path.join(record.path, 'b.txt'))).toBe(true);
  });

  it('unmerged local branches need the extra confirmation; merged ones go without; the developer’s are never touched', async () => {
    const { w, service } = await setup();
    const a = await session(w, 'unmerged', 40);
    const unmerged = await sessionWorktree(w, 'unmerged', a);
    const b = await session(w, 'mergedb', 40);
    const merged = await sessionWorktree(w, 'mergedb', b);
    await w.git(w.web, 'merge', '-q', '--ff-only', 'session/mergedb');
    for (const record of [unmerged, merged]) {
      await w.git(w.web, 'worktree', 'remove', record.path);
      await w.store.worktrees.markRemoved(record.id);
    }
    await w.git(w.web, 'branch', 'feature/mine');
    const svc = service();
    const scan = await svc.scan();
    const local = Object.fromEntries(byGroup(scan, 'localBranches').map((item) => [item.title, item]));
    expect(Object.keys(local).sort()).toEqual(['session/mergedb', 'session/unmerged']);
    expect(local['session/mergedb']?.confirm).toBeNull();
    expect(local['session/mergedb']?.selected).toBe(true);
    expect(local['session/unmerged']?.confirm).toBe('unmerged');
    expect(local['session/unmerged']?.selected).toBe(false);
    expect(local['session/unmerged']?.warnings[0]?.message).toBe('Not merged: 1 commit not in main; 1 commit on no remote');
    await expect(svc.start({ items: [{ id: local['session/unmerged']?.id as string, fingerprint: local['session/unmerged']?.fingerprint as string }] })).rejects.toBeInstanceOf(CleanupError);
    expect(await branches(w, w.web)).toContain('session/unmerged');
    const done = await run(svc, scan, [local['session/mergedb']?.id as string, local['session/unmerged']?.id as string]);
    expect(done.summary).toMatchObject({ done: 2, failed: 0 });
    expect(await branches(w, w.web)).toEqual(['feature/mine', 'main']);
    expect(await createdBranches(w.store.settings)).toEqual([]);
  });

  it('remote branches: listed, never ticked, deleted only when ticked and confirmed; a take-over leftover goes through the take-over service', async () => {
    const { w, dataDir } = await setup();
    const closed = await session(w, 'pushed', 40);
    const record = await sessionWorktree(w, 'pushed', closed);
    await w.git(record.path, 'push', '-q', '-u', 'origin', 'session/pushed');
    await w.git(w.web, 'push', '-q', 'origin', 'main:refs/heads/feature/theirs');
    await w.git(w.web, 'fetch', '-q', 'origin');
    const deleted: string[] = [];
    const leftover = { id: 'lo1', repoPath: w.web, remoteName: 'origin', remoteUrl: 'https://example.invalid/repo.git', branch: 'switchboard/takeover/abc/main', at: new Date().toISOString(), reason: 'offline' };
    const svc = new CleanupService({ store: w.store, dataDir, gitCommand: GIT_SPY_COMMAND, env: w.env, takeover: leftoverStub([leftover], deleted) });
    const scan = await svc.scan();
    const remote = byGroup(scan, 'remoteBranches');
    expect(remote.map((item) => [item.title, item.selected, item.confirm])).toEqual([
      ['origin/session/pushed', false, 'remote'],
      ['origin/switchboard/takeover/abc/main', false, 'remote'],
    ]);
    const bare = path.join(w.root, 'remotes', 'web-front.git');
    const remoteHeads = async (): Promise<string[]> => (await w.git(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).split('\n').filter(Boolean).sort();
    // Ticking everything else (the worktree, the local branch, the session) leaves the remote alone.
    const local = scan.items.filter((item) => item.group !== 'remoteBranches');
    expect(local.map((item) => item.group)).toEqual(['sessions']);
    await w.git(w.web, 'worktree', 'remove', record.path);
    await w.store.worktrees.markRemoved(record.id);
    const second = await svc.scan();
    const others = second.items.filter((item) => item.group !== 'remoteBranches');
    expect(others.map((item) => item.group)).toEqual(['localBranches', 'sessions']);
    await run(svc, second, others.map((item) => item.id));
    expect(await branches(w, w.web)).toEqual(['main']);
    expect(await remoteHeads()).toEqual(['feature/theirs', 'main', 'session/pushed']);
    // Without the confirmation the run is refused.
    await expect(svc.start({ items: remote.map((item) => ({ id: item.id, fingerprint: item.fingerprint })) })).rejects.toMatchObject({ code: 'confirmation-required' });
    const again = await svc.scan();
    const done = await run(svc, again, byGroup(again, 'remoteBranches').map((item) => item.id));
    expect(done.summary).toMatchObject({ done: 2, failed: 0 });
    expect(await remoteHeads()).toEqual(['feature/theirs', 'main']);
    expect(deleted).toEqual(['lo1']);
  });

  it('never runs git gc, never branch -D, and --force only on a confirmed worktree', async () => {
    const { w, service } = await setup();
    const closed = await session(w, 'spy', 40);
    const record = await sessionWorktree(w, 'spy', closed);
    await writeFile(path.join(record.path, 'x.txt'), 'x\n');
    const svc = service({ daysAhead: 20 });
    const scan = await svc.scan();
    await run(svc, scan, scan.items.map((item) => item.id));
    const calls = (await w.gitCalls()).map((call) => call.argv);
    expect(calls.some((argv) => argv.includes('gc') || argv.includes('prune'))).toBe(false);
    expect(calls.some((argv) => argv.includes('-D'))).toBe(false);
    expect(calls.filter((argv) => argv.includes('--force'))).toEqual([['worktree', 'remove', '--force', record.path]]);
  });
});

describe('Clean-up · dry run equals the run, failures isolated (D84)', () => {
  it('removes exactly what the preview listed and nothing else', async () => {
    const { w, dataDir, service } = await setup();
    const a = await session(w, 'dry1', 40);
    const wa = await sessionWorktree(w, 'dry1', a);
    const b = await session(w, 'dry2', 40);
    const wb = await sessionWorktree(w, 'dry2', b);
    await w.git(wb.path, 'push', '-q', '-u', 'origin', 'session/dry2');
    const keepOpen = await session(w, 'keep', null);
    const wk = await sessionWorktree(w, 'keep', keepOpen);
    await w.git(w.web, 'branch', 'feature/mine');
    const orphan = path.join(dataDir, 'attachments', randomUUID());
    await mkdir(orphan, { recursive: true });
    await writeFile(path.join(orphan, 'x.png'), 'png');
    const outside = path.join(dataDir, 'switchboard-other.txt');
    await writeFile(outside, 'keep');

    const svc = service({ daysAhead: 20 });
    const scan = await svc.scan();
    const beforeBranches = await branches(w, w.web);
    const confirmed = scan.items.map((item) => item.id);
    const done = await run(svc, scan, confirmed);
    expect(done.summary.failed).toBe(0);
    expect(done.summary.done).toBe(scan.items.length);

    // Worktrees: exactly the listed folders are gone.
    for (const item of byGroup(scan, 'worktrees')) expect(await exists(item.title)).toBe(false);
    expect(await exists(wk.path)).toBe(true);
    expect(byGroup(scan, 'worktrees').map((item) => item.title).sort()).toEqual([wa.path, wb.path].sort());
    // Branches: before minus the listed ones.
    const listedBranches = byGroup(scan, 'localBranches').map((item) => item.title);
    expect(await branches(w, w.web)).toEqual(beforeBranches.filter((branch) => !listedBranches.includes(branch)));
    expect(await branches(w, w.web)).toEqual(expect.arrayContaining(['feature/mine', 'main', 'session/keep']));
    // Remote: only the listed one.
    expect(byGroup(scan, 'remoteBranches').map((item) => item.title)).toEqual(['origin/session/dry2']);
    expect(await w.git(path.join(w.root, 'remotes', 'web-front.git'), 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).toBe('main');
    // Sessions: the two closed ones, not the open one.
    expect(byGroup(scan, 'sessions').map((item) => item.title).sort()).toEqual(['dry1', 'dry2']);
    expect(await w.store.sessions.get(a)).toBeNull();
    expect(await w.store.sessions.get(keepOpen)).not.toBeNull();
    // Data: the orphan folder only.
    expect(byGroup(scan, 'data').flatMap((item) => item.removes)).toEqual([orphan]);
    expect(await exists(orphan)).toBe(false);
    expect(await exists(outside)).toBe(true);
    // A second scan finds nothing left of it.
    expect((await svc.scan()).items).toEqual([]);
  });

  it('one failure is listed and the rest still runs', async () => {
    const { w, service } = await setup();
    const a = await session(w, 'f1', 40);
    const wa = await sessionWorktree(w, 'f1', a);
    const b = await session(w, 'f2', 40);
    const wb = await sessionWorktree(w, 'f2', b);
    for (const record of [wa, wb]) {
      await w.git(w.web, 'worktree', 'remove', record.path);
      await w.store.worktrees.markRemoved(record.id);
    }
    const svc = service();
    const scan = await svc.scan();
    // The first branch moves after the preview.
    await w.git(w.web, 'update-ref', 'refs/heads/session/f1', 'main');
    const done = await run(svc, scan, scan.items.filter((item) => item.group === 'localBranches').map((item) => item.id));
    expect(done.items.map((item) => [item.title, item.status])).toEqual([
      ['session/f1', 'failed'],
      ['session/f2', 'done'],
    ]);
    expect(done.items[0]?.error).toMatch(/changed since the preview/);
    expect(done.summary).toMatchObject({ done: 1, failed: 1 });
    expect(await branches(w, w.web)).toEqual(['main', 'session/f1']);
  });

  it('one run at a time', async () => {
    const { w, service } = await setup();
    const a = await session(w, 'busy', 40);
    await sessionWorktree(w, 'busy', a);
    const svc = service({ daysAhead: 20 });
    const scan = await svc.scan();
    const first = svc.start(runRequestOf(scan.items, new Set(scan.items.map((item) => item.id))));
    await expect(svc.start(runRequestOf(scan.items, new Set(scan.items.map((item) => item.id))))).rejects.toMatchObject({ status: 409, code: 'busy' });
    await first;
    await svc.idle();
  });
});

describe('Clean-up · sessions and data (D84)', () => {
  it('closed sessions older than the limit (configurable) go with their events, todos and attachments; open and recent ones stay', async () => {
    const { w, dataDir, service } = await setup();
    const old = await session(w, 'old', 40);
    const recent = await session(w, 'recent', 5);
    const open = await session(w, 'open', null);
    await w.store.events.append({ sessionId: old, kind: 'text', label: 'hello', payload: { type: 'user', text: 'hello' } });
    const folder = path.join(dataDir, 'attachments', old);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'a1-shot.png'), 'png');
    await w.store.attachments.create({ id: 'a1', sessionId: old, name: 'shot.png', mediaType: 'image/png', kind: 'image', size: 3, file: 'a1-shot.png', pages: null });
    const svc = service();
    let scan = await svc.scan();
    expect(scan.closedSessionDays).toBe(30);
    const [item] = byGroup(scan, 'sessions');
    expect(byGroup(scan, 'sessions')).toHaveLength(1);
    expect(item?.removes).toEqual(['the session record old with 1 event, 0 todos, 1 attachment', folder]);
    expect(item?.sizeBytes).toBeGreaterThan(3);
    await svc.setClosedSessionDays(3);
    scan = await svc.scan();
    expect(byGroup(scan, 'sessions').map((entry) => entry.title).sort()).toEqual(['old', 'recent']);
    const done = await run(svc, scan, [`ses:${old}`]);
    expect(done.summary).toMatchObject({ done: 1, failed: 0 });
    expect(await w.store.sessions.get(old)).toBeNull();
    expect(await w.store.attachments.get('a1')).toBeNull();
    expect(await exists(folder)).toBe(false);
    expect(await w.store.sessions.get(recent)).not.toBeNull();
    expect(await w.store.sessions.get(open)).not.toBeNull();
  });

  it('a running closed session is never listed', async () => {
    const { w, service } = await setup();
    const old = await session(w, 'running', 40);
    expect(byGroup(await service({ live: new Set([old]) }).scan(), 'sessions')).toEqual([]);
  });

  it('attachments past retention, orphaned files, old exports and stale staging folders; nothing else in the data folder', async () => {
    const { w, dataDir, service } = await setup();
    const live = await session(w, 'live', null);
    const folder = path.join(dataDir, 'attachments', live);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'old-a.png'), 'aaaa');
    await writeFile(path.join(folder, 'new-b.png'), 'bb');
    await writeFile(path.join(folder, 'stray.bin'), 'stray');
    await w.store.attachments.create({ id: 'old', sessionId: live, name: 'a.png', mediaType: 'image/png', kind: 'image', size: 4, file: 'old-a.png', pages: null, createdAt: new Date(Date.now() - 40 * DAY).toISOString() });
    await w.store.attachments.create({ id: 'new', sessionId: live, name: 'b.png', mediaType: 'image/png', kind: 'image', size: 2, file: 'new-b.png', pages: null });
    const exports = path.join(dataDir, 'handovers', live);
    await mkdir(exports, { recursive: true });
    await writeFile(path.join(exports, 'x.md'), '# chat');
    const longAgo = new Date(Date.now() - 40 * DAY);
    await utimes(path.join(exports, 'x.md'), longAgo, longAgo);
    await utimes(exports, longAgo, longAgo);
    const freshExport = path.join(dataDir, 'handovers', 'fresh');
    await mkdir(freshExport, { recursive: true });
    const staging = path.join(dataDir, 'takeover', 'op-1');
    await mkdir(staging, { recursive: true });
    await utimes(staging, longAgo, longAgo);
    await writeFile(path.join(dataDir, 'switchboard.db.bak'), 'not ours to judge');

    const svc = service();
    const scan = await svc.scan();
    const data = byGroup(scan, 'data');
    expect(data.map((item) => [item.title, item.removes])).toEqual([
      ['1 attachment older than 30 days', [path.join(folder, 'old-a.png')]],
      ['1 file in attachments/' + live, [path.join(folder, 'stray.bin')]],
      [`handovers/${live}`, [exports]],
      ['takeover/op-1', [staging]],
    ]);
    const done = await run(svc, scan, data.map((item) => item.id));
    expect(done.summary).toMatchObject({ done: 4, failed: 0 });
    expect((await readdir(folder)).sort()).toEqual(['new-b.png']);
    expect(await w.store.attachments.get('old')).toBeNull();
    expect(await w.store.attachments.get('new')).not.toBeNull();
    expect(await exists(freshExport)).toBe(true);
    expect(await exists(path.join(dataDir, 'switchboard.db.bak'))).toBe(true);
  });
});

describe('Clean-up · orphaned artifacts (D89 ruling)', () => {
  it('lists saved artifacts whose session was deleted, with their image files and sizes, unticked; the run removes exactly them', async () => {
    const { w, dataDir, service } = await setup();
    const gone = await session(w, 'gone', null);
    const kept = await session(w, 'kept', null);
    const text = (content: string) => ({ content, file: null, mediaType: null, size: Buffer.byteLength(content), createdBy: 'agent' as const });
    await w.store.artifacts.create({ id: 'a000000001', sessionId: gone, title: 'Plan', kind: 'markdown', language: null, version: text('# Plan') });
    await w.store.artifacts.addVersion('a000000001', { title: 'Plan', language: null, version: text('# Plan v2') });
    const imageDir = path.join(dataDir, 'artifacts', 'a000000002');
    await mkdir(imageDir, { recursive: true });
    await writeFile(path.join(imageDir, '1.png'), 'pngbytes');
    await w.store.artifacts.create({ id: 'a000000002', sessionId: gone, title: 'Screen', kind: 'image', language: null, version: { content: null, file: 'artifacts/a000000002/1.png', mediaType: 'image/png', size: 8, createdBy: 'agent' } });
    await w.store.artifacts.create({ id: 'a000000003', sessionId: kept, title: 'Kept', kind: 'markdown', language: null, version: text('# Kept') });
    await w.store.sessions.delete(gone);

    const svc = service();
    const scan = await svc.scan();
    const orphans = byGroup(scan, 'data').filter((item) => item.id.startsWith('art:'));
    expect(orphans.map((item) => [item.id, item.title, item.sizeBytes, item.selected, item.reasons, item.removes])).toEqual([
      ['art:a000000002', 'Artifact “Screen”', 8, false, ['session-gone'], ['the artifact “Screen” and its 1 version', imageDir]],
      ['art:a000000001', 'Artifact “Plan”', 15, false, ['session-gone'], ['the artifact “Plan” and its 2 versions']],
    ]);
    const done = await run(svc, scan, orphans.map((item) => item.id));
    expect(done.summary).toMatchObject({ done: 2, failed: 0 });
    expect(await w.store.artifacts.get('a000000001')).toBeNull();
    expect(await w.store.artifacts.get('a000000002')).toBeNull();
    expect(await exists(imageDir)).toBe(false);
    expect(await w.store.artifacts.get('a000000003')).not.toBeNull();
  });
});

describe('Clean-up · units', () => {
  it('statusPaths reads -z output with renames', () => {
    expect(statusPaths(' M a.txt\0?? dir/b c.txt\0R  new.txt\0old.txt\0')).toEqual(['a.txt', 'dir/b c.txt', 'new.txt']);
  });
});
