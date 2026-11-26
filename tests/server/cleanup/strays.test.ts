import { mkdir, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { STRAY_IDLE_MS, type StrayItem } from '../../../src/core/strays.ts';
import { StrayService } from '../../../src/server/cleanup/strays.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';

/**
 * D191 (`docs/worktrees.md` → *Stray worktrees*): the finder classifies the worktrees no open agent
 * uses (a Claude Code helper worktree, one with uncommitted changes), leaves one an open session
 * uses alone, finds a stale worktree record, a leftover `worktree-agent-…` branch with a commit
 * only on it and an old temp folder; the clean removes only the ticked safe ones (a risky one needs
 * `force`), a deleted branch can be restored; the idle notice comes once after the idle time.
 */

let world: GitWorld | undefined;

afterEach(async () => {
  await world?.cleanup();
  world = undefined;
});

async function rig(options: { working?: () => boolean; now?: () => number; notice?: ConstructorParameters<typeof StrayService>[0]['notice'] } = {}) {
  world = await makeGitWorld();
  const w = world;
  await w.store.folders.create({ path: w.web, canonicalPath: w.web, kind: 'repo' });
  const service = new StrayService({
    store: w.store,
    dataDir: w.root,
    isWorking: () => options.working?.() ?? false,
    gitCommand: ['git'],
    env: w.env,
    ...(options.now ? { now: options.now } : {}),
    ...(options.notice ? { notice: options.notice } : {}),
    onError: (error) => w.errors.push(error),
  });
  return { w, service };
}

async function addWorktree(w: GitWorld, relative: string, branch: string): Promise<string> {
  const dir = path.join(w.web, ...relative.split('/'));
  await w.git(w.web, 'worktree', 'add', '-q', '-b', branch, dir);
  return realpath(dir);
}

function find(items: readonly StrayItem[], predicate: (item: StrayItem) => boolean): StrayItem {
  const item = items.find(predicate);
  if (!item) throw new Error(`not found in ${JSON.stringify(items.map((i) => [i.kind, i.path, i.branch]))}`);
  return item;
}

describe('D191 · stray worktrees and leftovers', () => {
  it('finds and classifies them; leaves an open session’s alone; cleans only the ticked safe ones; restores a deleted branch', async () => {
    const { w, service } = await rig();
    const clean = await addWorktree(w, '.claude/worktrees/agent-x', 'worktree-agent-x');
    const dirty = await addWorktree(w, '.claude/worktrees/agent-y', 'worktree-agent-y');
    await writeFile(path.join(dirty, 'notes.txt'), 'unsaved\n');
    const used = await addWorktree(w, '.worktrees/used', 'feature-used');
    await w.store.sessions.create({ name: 'busy', claudeSessionId: 'c-busy', root: w.web, rootKind: 'repo', cwd: used });
    const gone = await addWorktree(w, '.worktrees/gone', 'feature-gone');
    await rm(gone, { recursive: true, force: true });
    // A helper's branch with a commit found nowhere else, its worktree removed.
    const z = await addWorktree(w, '.claude/worktrees/agent-z', 'worktree-agent-z');
    await w.commit(z, 'z.txt', 'only here\n');
    await w.git(w.web, 'worktree', 'remove', z);
    // An old temp folder of Switchboard's.
    const spool = path.join(w.root, 'tmp', 'chat-move', 'op-1');
    await mkdir(spool, { recursive: true });
    await writeFile(path.join(spool, 'a.txt'), 'x');
    const old = new Date(Date.now() - 3 * 24 * 3_600_000);
    await utimes(spool, old, old);

    const scan = await service.scan();
    expect(scan.errors).toEqual([]);
    const a = find(scan.items, (item) => item.kind === 'claude-subagent' && item.branch === 'worktree-agent-x');
    expect(a).toMatchObject({ uncommitted: 0, uniqueCommits: 0 });
    expect(path.resolve(a.path as string)).toBe(path.resolve(clean));
    const b = find(scan.items, (item) => item.branch === 'worktree-agent-y');
    expect(b.uncommitted).toBe(1);
    expect(scan.items.some((item) => item.branch === 'feature-used')).toBe(false);
    expect(scan.inUse).toBe(1);
    const stale = find(scan.items, (item) => item.kind === 'stale-record');
    expect(stale.branch).toBe('feature-gone');
    const branch = find(scan.items, (item) => item.kind === 'branch' && item.branch === 'worktree-agent-z');
    expect(branch.uniqueCommits).toBe(1);
    const temp = find(scan.items, (item) => item.kind === 'temp');
    expect(temp.bytes).toBe(1);
    // The main checkout is never listed.
    expect(scan.items.some((item) => item.path !== null && path.resolve(item.path) === path.resolve(w.web))).toBe(false);

    // Ticked: the safe helper, the risky dirty one (no force), the stale record, the branch with a unique commit, the temp folder.
    const result = await service.clean({ ids: [a.id, b.id, stale.id, branch.id, temp.id], force: false });
    const outcome = (id: string) => result.outcomes.find((o) => o.id === id)?.result;
    expect(outcome(a.id)).toBe('removed');
    expect(outcome(b.id)).toBe('skipped');
    expect(outcome(stale.id)).toBe('removed');
    expect(outcome(branch.id)).toBe('skipped');
    expect(outcome(temp.id)).toBe('removed');
    const list = await w.git(w.web, 'worktree', 'list', '--porcelain');
    expect(list).not.toContain('agent-x');
    expect(list).toContain('agent-y');
    expect(list).not.toContain('gone');
    expect(list).toContain('used');
    // The helper's own branch went with it (no unique commits) and is restorable; the others are kept.
    const branches = await w.git(w.web, 'branch', '--format=%(refname:short)');
    expect(branches).not.toContain('worktree-agent-x');
    expect(branches).toContain('worktree-agent-z');
    expect(branches).toContain('worktree-agent-y');
    const restorable = result.restorable.find((entry) => entry.branch === 'worktree-agent-x');
    expect(restorable).toBeDefined();

    // Restore puts it back at its tip.
    await service.restore({ repo: restorable?.repo as string, branch: 'worktree-agent-x', sha: restorable?.sha as string });
    expect(await w.git(w.web, 'rev-parse', 'worktree-agent-x')).toBe(restorable?.sha);
    // Only a branch it deleted can be restored.
    await expect(service.restore({ repo: w.web, branch: 'main2', sha: restorable?.sha as string })).rejects.toThrow(/not one this clean-up deleted/);

    // With force (confirmed), the risky one goes too; its branch (nothing unique on it) is restorable.
    const again = await service.scan();
    const b2 = find(again.items, (item) => item.branch === 'worktree-agent-y');
    const forced = await service.clean({ ids: [b2.id], force: true });
    expect(forced.outcomes[0]?.result).toBe('removed');
    expect(forced.restorable.some((entry) => entry.branch === 'worktree-agent-y')).toBe(true);
    // The branch with a commit only on it is kept even when forced.
    const z2 = find(again.items, (item) => item.kind === 'branch' && item.branch === 'worktree-agent-z');
    expect((await service.clean({ ids: [z2.id], force: false })).outcomes[0]?.result).toBe('skipped');
    expect(await w.git(w.web, 'branch', '--format=%(refname:short)')).toContain('worktree-agent-z');
  }, 60_000);

  it('the idle notice: not while an agent works, once after the idle time, not again the same day', async () => {
    let clock = Date.parse('2026-11-26T08:00:00Z');
    let working = false;
    const raised: Array<{ count: number }> = [];
    const { w, service } = await rig({ now: () => clock, working: () => working, notice: { raise: async (input) => raised.push(input), resolve: async () => undefined } });
    await w.store.sessions.create({ name: 'idle', claudeSessionId: 'c-idle', root: w.web, rootKind: 'repo', cwd: w.web });
    await addWorktree(w, '.claude/worktrees/agent-q', 'worktree-agent-q');
    service.start();
    try {
      clock += STRAY_IDLE_MS - 60_000;
      await service.tick();
      expect(raised).toEqual([]);
      // An agent works: the idle time starts again.
      working = true;
      clock += 120_000;
      await service.tick();
      working = false;
      await service.tick();
      clock += STRAY_IDLE_MS - 60_000;
      await service.tick();
      expect(raised).toEqual([]);
      clock += 120_000;
      await service.tick();
      expect(raised).toHaveLength(1);
      expect(raised[0]?.count).toBe(1);
      clock += 3_600_000;
      await service.tick();
      expect(raised).toHaveLength(1);
    } finally {
      await service.stop();
    }
  }, 60_000);
});
