import { spawn } from 'node:child_process';
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTO_CLEAN_RECORD_SETTING, AUTO_CLEAN_REMOTE_SETTING, AUTO_CLEAN_SETTING, readAutoCleanRecord } from '../../../src/core/auto-clean.ts';
import type { LifecyclePayload } from '../../../src/core/event-payload.ts';
import { CREATED_BRANCHES_SETTING } from '../../../src/server/cleanup/created-branches.ts';
import type { WorktreeRecord } from '../../../src/server/db/repos/worktrees.ts';
import { type ProcessCwd, platformCwdLister } from '../../../src/server/processes/cwd.ts';
import { AutoCleanService, type AutoCleanServiceOptions } from '../../../src/server/worktrees/auto-clean.ts';
import { GIT_SPY_COMMAND, type GitWorld, makeGitWorld } from '../../helpers/git.ts';

/**
 * D145 · the automatic clean-up of merged worktrees (`src/server/worktrees/auto-clean.ts`,
 * `docs/cleanup.md` → *Automatic clean-up of merged worktrees (D145)*), on temp git repos with a
 * local bare "origin": a merged agent worktree goes with its local and remote branch; a
 * squash-merged PR too; every condition that keeps it (dirty, untracked, unmerged, a fresh
 * branch, local-only commits, a process inside, a working agent, an open agent's folder); the
 * remote copy never of a protected branch or one that was there before, and kept when the
 * remote refuses; the setting off; never `--force`, `-D`, `gc` or a tag.
 */

let world: GitWorld | undefined;
const children: Array<ReturnType<typeof spawn>> = [];
const services: AutoCleanService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
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

interface Rig {
  readonly w: GitWorld;
  readonly repo: string;
  readonly bare: string;
  readonly busy: Set<string>;
  readonly live: Set<string>;
  readonly dividers: Array<{ sessionId: string; label: string; payload: LifecyclePayload }>;
  readonly gone: string[];
  readonly lines: string[];
  cwds: ProcessCwd[] | null;
  readonly service: AutoCleanService;
}

/** web-front with its origin, a `dev` branch (pushed) checked out in the main checkout. */
async function rig(options: Partial<AutoCleanServiceOptions> = {}): Promise<Rig> {
  world = await makeGitWorld();
  const w = world;
  const repo = w.web;
  const bare = path.join(w.root, 'remotes', 'web-front.git');
  await w.git(repo, 'switch', '-q', '-c', 'dev');
  await w.git(repo, 'push', '-q', '-u', 'origin', 'dev');
  const r = {
    w,
    repo,
    bare,
    busy: new Set<string>(),
    live: new Set<string>(),
    dividers: [] as Rig['dividers'],
    gone: [] as string[],
    lines: [] as string[],
    cwds: [] as ProcessCwd[] | null,
  } as Rig;
  const service = new AutoCleanService({
    store: w.store,
    gitCommand: GIT_SPY_COMMAND,
    env: w.env,
    isBusy: (id) => r.busy.has(id),
    isLive: (id) => r.live.has(id),
    processCwds: async () => r.cwds,
    record: async (sessionId, label, payload) => r.dividers.push({ sessionId, label, payload }),
    worktreeGone: async (id) => r.gone.push(id),
    log: (line) => r.lines.push(line),
    onError: (error) => w.errors.push(error),
    ...options,
  });
  services.push(service);
  return Object.assign(r, { service });
}

async function session(r: Rig, name: string, extra: { cwd?: string; closed?: boolean } = {}): Promise<string> {
  const created = await r.w.store.sessions.create({ name, claudeSessionId: `c-${name}`, root: r.repo, rootKind: 'repo', cwd: extra.cwd ?? r.repo });
  if (extra.closed) await r.w.store.sessions.update(created.id, { closedAt: new Date().toISOString() });
  return created.id;
}

/** Claude Code's way: `git worktree add -b worktree-<name> .claude/worktrees/<name>`, a commit, pushed; registered for `sessionId`. */
async function agentWorktree(r: Rig, name: string, sessionId: string, options: { branch?: string; commit?: boolean; push?: boolean } = {}): Promise<WorktreeRecord> {
  const branch = options.branch ?? `worktree-${name}`;
  const dir = path.join(r.repo, '.claude', 'worktrees', name);
  await r.w.git(r.repo, 'worktree', 'add', '-q', '-b', branch, dir);
  if (options.commit !== false) await r.w.commit(dir, `${name}.txt`, `${name}\n`);
  if (options.push !== false) await r.w.git(dir, 'push', '-q', '-u', 'origin', branch);
  return r.w.store.worktrees.create({ repo: 'web-front', repoPath: r.repo, branch, baseRef: 'dev', path: dir, sessionId });
}

/** Merges `branch` into dev in the main checkout (a merge commit) and pushes dev. */
async function mergeIntoDev(r: Rig, branch: string): Promise<void> {
  await r.w.git(r.repo, 'merge', '-q', '--no-ff', '-m', `merge ${branch}`, branch);
  await r.w.git(r.repo, 'push', '-q', 'origin', 'dev');
}

async function onOrigin(r: Rig, branch: string): Promise<boolean> {
  return (await r.w.git(r.bare, 'branch', '--list', branch)) !== '';
}

async function local(r: Rig, branch: string): Promise<boolean> {
  return (await r.w.git(r.repo, 'branch', '--list', branch)) !== '';
}

async function neverForced(r: Rig): Promise<void> {
  const calls = await r.w.gitCalls();
  for (const call of calls) {
    expect(call.argv, call.argv.join(' ')).not.toContain('--force');
    expect(call.argv).not.toContain('-f');
    expect(call.argv).not.toContain('-D');
    expect(call.argv).not.toContain('gc');
    expect(call.argv).not.toContain('tag');
    expect(call.argv.some((arg) => arg.startsWith('refs/tags/'))).toBe(false);
  }
}

describe('the automatic clean-up · removal (D145)', () => {
  it('an agent worktree merged into dev: the folder, the local branch and origin/<branch> go; the divider and the record say so', async () => {
    const r = await rig();
    const id = await session(r, 'fix-login');
    const row = await agentWorktree(r, 'x', id);
    await mergeIntoDev(r, 'worktree-x');
    const outcome = await r.service.clean(row.id, 'turn-end');
    expect(outcome).toMatchObject({ removed: true, text: 'Cleaned up worktree x: merged into dev; removed the folder, the local branch and origin/worktree-x' });
    expect(await exists(row.path)).toBe(false);
    expect(await local(r, 'worktree-x')).toBe(false);
    expect(await onOrigin(r, 'worktree-x')).toBe(false);
    expect((await r.w.store.worktrees.get(row.id))?.removedAt).not.toBeNull();
    expect(r.dividers).toEqual([{ sessionId: id, label: outcome.removed ? outcome.text : '', payload: { type: 'lifecycle', action: 'worktree-cleaned', message: outcome.removed ? outcome.text : '' } }]);
    expect(r.gone).toEqual([row.id]);
    expect(r.lines.some((line) => line.startsWith('[auto-clean] Cleaned up worktree x'))).toBe(true);
    const record = readAutoCleanRecord(await r.w.store.settings.get(AUTO_CLEAN_RECORD_SETTING));
    expect(record).toMatchObject({ cleaned: 1, recent: [{ path: row.path }] });
    // `git worktree remove` (never --force), then `git worktree prune`; `git branch -d` (never -D).
    const calls = (await r.w.gitCalls()).map((call) => call.argv.join(' '));
    expect(calls).toContain(`worktree remove ${row.path}`);
    expect(calls).toContain('worktree prune');
    expect(calls).toContain('branch -d worktree-x');
    expect(calls.some((call) => call.startsWith('push --porcelain --force-with-lease=refs/heads/worktree-x:') && call.endsWith('origin --delete refs/heads/worktree-x'))).toBe(true);
    await neverForced(r);
    // A tag on dev stays.
    expect(await r.w.git(r.bare, 'branch', '--list', 'dev')).not.toBe('');
  });

  it('an archived agent: removed too; a second clean-up answers "already removed"', async () => {
    const r = await rig();
    const id = await session(r, 'done-one', { closed: true });
    const row = await agentWorktree(r, 'y', id);
    await mergeIntoDev(r, 'worktree-y');
    expect((await r.service.clean(row.id)).removed).toBe(true);
    expect(await r.service.clean(row.id)).toEqual({ removed: false, reason: 'already removed' });
  });

  it('a squash-merged PR (the base has none of its commits): removed, with its local and remote branch', async () => {
    const r = await rig();
    const id = await session(r, 'squashy');
    const row = await agentWorktree(r, 'sq', id);
    // The PR was squash-merged on GitHub: dev gets one new commit with the same change.
    await r.w.git(r.repo, 'merge', '-q', '--squash', 'worktree-sq');
    await r.w.git(r.repo, 'commit', '-q', '-m', 'squash: sq');
    await r.w.git(r.repo, 'push', '-q', 'origin', 'dev');
    // Not merged by ancestry: kept until the PR says merged.
    expect(await r.service.clean(row.id)).toEqual({ removed: false, reason: 'not merged into dev' });
    await r.w.store.worktrees.update(row.id, { prNumber: 12, prState: 'MERGED' });
    const outcome = await r.service.clean(row.id, 'merged');
    expect(outcome).toMatchObject({ removed: true, text: 'Cleaned up worktree sq: PR #12 merged; removed the folder, the local branch and origin/worktree-sq' });
    expect(await local(r, 'worktree-sq')).toBe(false);
    expect(await onOrigin(r, 'worktree-sq')).toBe(false);
    await neverForced(r);
  });
});

describe('the automatic clean-up · kept (D145)', () => {
  it('not merged; a fresh branch with no commits of its own; uncommitted; untracked (ignored files do not count)', async () => {
    const r = await rig();
    const id = await session(r, 'keeper');
    const unmerged = await agentWorktree(r, 'u', id);
    expect(await r.service.clean(unmerged.id)).toEqual({ removed: false, reason: 'not merged into dev' });
    // A fresh worktree is trivially "inside" dev, but has no work of its own (D121).
    const fresh = await agentWorktree(r, 'f', id, { commit: false, push: false });
    expect(await r.service.clean(fresh.id)).toEqual({ removed: false, reason: 'no commits of its own yet' });

    const dirty = await agentWorktree(r, 'd', id);
    await mergeIntoDev(r, 'worktree-d');
    await writeFile(path.join(dirty.path, 'd.txt'), 'changed\n');
    expect(await r.service.clean(dirty.id)).toEqual({ removed: false, reason: '1 uncommitted change' });
    await r.w.git(dirty.path, 'checkout', '--', 'd.txt');
    await writeFile(path.join(dirty.path, 'notes.md'), 'new\n');
    expect(await r.service.clean(dirty.id)).toEqual({ removed: false, reason: '1 uncommitted change' });
    // An ignored file is no change: gone once the untracked one is.
    await r.w.git(r.repo, 'rm', '-q', '--cached', '--ignore-unmatch', 'nothing');
    await writeFile(path.join(dirty.path, '.git-info-exclude-test'), '');
    await mkdir(path.join(r.repo, '.git', 'info'), { recursive: true });
    await writeFile(path.join(r.repo, '.git', 'info', 'exclude'), 'notes.md\n.git-info-exclude-test\nbuild/\n');
    await mkdir(path.join(dirty.path, 'build'), { recursive: true });
    await writeFile(path.join(dirty.path, 'build', 'out.js'), 'x\n');
    expect((await r.service.clean(dirty.id)).removed).toBe(true);
    for (const row of [unmerged, fresh]) expect(await exists(row.path)).toBe(true);
    // Each new reason is logged once.
    expect(r.lines.filter((line) => line.includes('kept') && line.includes(unmerged.path))).toHaveLength(1);
    await neverForced(r);
  });

  it('a commit only on this computer (a merged PR, one more commit not pushed)', async () => {
    const r = await rig();
    const id = await session(r, 'local-only');
    const row = await agentWorktree(r, 'l', id);
    await r.w.store.worktrees.update(row.id, { prNumber: 7, prState: 'MERGED' });
    await r.w.commit(row.path, 'more.txt', 'more\n');
    expect(await r.service.clean(row.id)).toEqual({ removed: false, reason: '1 commit only on this computer' });
    expect(await exists(row.path)).toBe(true);
  });

  it('a process running inside it; the working agent; an open agent working in it; another session using it', async () => {
    const r = await rig();
    const id = await session(r, 'owner');
    const row = await agentWorktree(r, 'p', id);
    await mergeIntoDev(r, 'worktree-p');
    r.cwds = [{ pid: 4242, command: 'node', cwd: path.join(row.path, 'src') }];
    expect(await r.service.clean(row.id)).toEqual({ removed: false, reason: '1 process still running in it (node)' });
    r.cwds = null;
    expect(await r.service.clean(row.id)).toEqual({ removed: false, reason: 'the processes running in it cannot be checked' });
    r.cwds = [];
    r.busy.add(id);
    r.live.add(id);
    expect(await r.service.clean(row.id)).toEqual({ removed: false, reason: 'its agent is working' });
    r.busy.delete(id);
    // Live but idle: fine; an open session started in the worktree keeps it.
    const inside = await session(r, 'in-there', { cwd: row.path });
    expect(await r.service.clean(row.id)).toEqual({ removed: false, reason: 'it is the working folder of in-there (removed once that agent is archived)' });
    await r.w.store.sessions.update(inside, { closedAt: new Date().toISOString() });
    expect(await r.service.clean(row.id)).toEqual({ removed: false, reason: 'also used by in-there' });
    await r.w.store.sessions.delete(inside);
    expect((await r.service.clean(row.id)).removed).toBe(true);
  });

  it('a real process with its working folder inside is seen (macOS / Linux)', async () => {
    if (process.platform === 'win32') return;
    const r = await rig({ processCwds: platformCwdLister() });
    const id = await session(r, 'with-proc');
    const row = await agentWorktree(r, 'rp', id);
    await mergeIntoDev(r, 'worktree-rp');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: row.path, stdio: 'ignore' });
    children.push(child);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const kept = await r.service.clean(row.id);
    expect(kept.removed).toBe(false);
    expect(kept.removed ? '' : kept.reason).toMatch(/^1 process still running in it/);
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    expect((await r.service.clean(row.id)).removed).toBe(true);
  });
});

describe('the automatic clean-up · the remote branch (D145)', () => {
  it('a protected name: the folder goes, the local and remote branch stay with the reason', async () => {
    const r = await rig();
    const id = await session(r, 'rel');
    const row = await agentWorktree(r, 'rel', id, { branch: 'release/9.9' });
    await mergeIntoDev(r, 'release/9.9');
    const outcome = await r.service.clean(row.id);
    expect(outcome).toMatchObject({
      removed: true,
      text: 'Cleaned up worktree rel: merged into dev; removed the folder; kept the local branch (release/9.9 is a release branch) and origin/release/9.9 (release/9.9 is a release branch)',
    });
    expect(await local(r, 'release/9.9')).toBe(true);
    expect(await onOrigin(r, 'release/9.9')).toBe(true);
  });

  it('the repository default branch is never deleted on the remote', async () => {
    const r = await rig();
    const id = await session(r, 'deflt');
    const row = await agentWorktree(r, 'df', id, { branch: 'trunk-x' });
    await mergeIntoDev(r, 'trunk-x');
    // origin's default branch is trunk-x here.
    await r.w.git(r.bare, 'symbolic-ref', 'HEAD', 'refs/heads/trunk-x');
    await r.w.git(r.repo, 'remote', 'set-head', 'origin', 'trunk-x');
    const outcome = await r.service.clean(row.id);
    expect(outcome.removed).toBe(true);
    expect(await onOrigin(r, 'trunk-x')).toBe(true);
    expect(outcome.removed ? outcome.text : '').toContain("origin/trunk-x (trunk-x is the repository's default branch)");
  });

  it('a branch that was on origin before (tracking): its remote copy stays', async () => {
    const r = await rig();
    const id = await session(r, 'tracker');
    const row = await agentWorktree(r, 't', id);
    await mergeIntoDev(r, 'worktree-t');
    await r.w.store.settings.set(CREATED_BRANCHES_SETTING, [{ repoPath: r.repo, branch: 'worktree-t', kind: 'tracking', at: new Date().toISOString() }]);
    const outcome = await r.service.clean(row.id);
    expect(outcome.removed ? outcome.text : '').toBe("Cleaned up worktree t: merged into dev; removed the folder and the local branch; kept origin/worktree-t (it was on origin before Switchboard's agent used it)");
    expect(await onOrigin(r, 'worktree-t')).toBe(true);
  });

  it('the remote refuses (protected there): the folder and local branch go, the remote copy stays with the reason', async () => {
    const r = await rig();
    const hook = path.join(r.bare, 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\nwhile read old new ref; do case "$new" in 0000000000000000000000000000000000000000) echo "GH006: Protected branch update failed for $ref." >&2; exit 1;; esac; done\nexit 0\n');
    await chmod(hook, 0o755);
    const id = await session(r, 'refused');
    const row = await agentWorktree(r, 'z', id);
    await mergeIntoDev(r, 'worktree-z');
    const outcome = await r.service.clean(row.id);
    if (process.platform === 'win32') return;
    expect(outcome.removed).toBe(true);
    expect(outcome.removed ? outcome.text : '').toMatch(/^Cleaned up worktree z: merged into dev; removed the folder and the local branch; kept origin\/worktree-z \(the remote refused: .+\)$/);
    expect(await exists(row.path)).toBe(false);
    expect(await local(r, 'worktree-z')).toBe(false);
    expect(await onOrigin(r, 'worktree-z')).toBe(true);
  });

  it('"Also delete the branch on the remote" off: the remote copy stays, nothing said about it', async () => {
    const r = await rig();
    await r.w.store.settings.set(AUTO_CLEAN_REMOTE_SETTING, false);
    const id = await session(r, 'no-remote');
    const row = await agentWorktree(r, 'nr', id);
    await mergeIntoDev(r, 'worktree-nr');
    const outcome = await r.service.clean(row.id);
    expect(outcome.removed ? outcome.text : '').toBe('Cleaned up worktree nr: merged into dev; removed the folder and the local branch');
    expect(await onOrigin(r, 'worktree-nr')).toBe(true);
  });
});

describe('the automatic clean-up · triggers (D145)', () => {
  it('a session request cleans its worktrees; the setting off: nothing at all', async () => {
    const r = await rig({ settleMs: 0 });
    const id = await session(r, 'switch');
    const row = await agentWorktree(r, 's', id);
    await mergeIntoDev(r, 'worktree-s');
    await r.w.store.settings.set(AUTO_CLEAN_SETTING, false);
    expect((await r.service.cleanSession(id, 'turn-end')).size).toBe(0);
    expect((await r.service.sweep()).size).toBe(0);
    expect(await exists(row.path)).toBe(true);
    expect(r.dividers).toEqual([]);
    await r.w.store.settings.set(AUTO_CLEAN_SETTING, true);
    const outcomes = await r.service.cleanSession(id, 'turn-end');
    expect(outcomes.get(row.id)?.removed).toBe(true);
  });

  it('the sweep reaches every session; requests for one worktree coalesce', async () => {
    const r = await rig();
    const a = await session(r, 'a');
    const b = await session(r, 'b', { closed: true });
    const rowA = await agentWorktree(r, 'a', a);
    const rowB = await agentWorktree(r, 'b', b);
    await mergeIntoDev(r, 'worktree-a');
    await mergeIntoDev(r, 'worktree-b');
    r.service.requestWorktree(rowA.id, 'merged');
    r.service.requestWorktree(rowA.id, 'merged');
    const swept = await r.service.sweep();
    expect([...swept.values()].filter((outcome) => outcome.removed)).toHaveLength(1);
    expect(await exists(rowA.path)).toBe(false);
    expect(await exists(rowB.path)).toBe(false);
    expect(r.dividers.map((divider) => divider.sessionId).sort()).toEqual([a, b].sort());
  });
});
