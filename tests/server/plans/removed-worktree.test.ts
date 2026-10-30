/**
 * D148 · Plans: an item's merged work is found also after its worktree was removed. Found on the
 * developer's install: a multi-repo item in `agents` mode committed in one repo, its PR was merged
 * into the target, the developer removed that repo's worktree from the "PR merged, the worktree can
 * be removed" Inbox item, and the agent marked its todo done. Its other repos had no commits of
 * their own. The scheduler read only the live worktrees, so it saw "no work anywhere" and the item
 * stayed `running` for good (no note, no state change). The plan core is real (store, TodoService,
 * PlanService) over real temp git repos (`makeGitWorld`, the real {@link PlanGit}, fake gh).
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import type { SessionStatus } from '../../../src/core/model.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { PlanGit } from '../../../src/server/plans/git.ts';
import { type PlanEnvironment, PlanService } from '../../../src/server/plans/service.ts';
import { TodoService } from '../../../src/server/todos/service.ts';
import { BranchMergeGit } from '../../../src/server/worktrees/branch-merge.ts';
import { fakeGhCommand } from '../../../tools/fake-gh/command.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';

const TARGET = 'feature/PROJ-10-acme-epic';
const NAMES = ['acme-front', 'acme-api'] as const;

interface Rig {
  readonly w: GitWorld;
  readonly repos: Readonly<Record<string, string>>;
  /** The checkouts the target branch is on, per repo. */
  readonly targets: Readonly<Record<string, string>>;
  readonly bus: HubBus;
  readonly todos: TodoService;
  readonly errors: unknown[];
  plans: PlanService;
  readonly sourceId: string;
  restart(): Promise<void>;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.plans.close();
  await rig?.w.cleanup();
  rig = undefined;
});

async function setup(): Promise<Rig> {
  const w = await makeGitWorld();
  const repos: Record<string, string> = {};
  const targets: Record<string, string> = {};
  for (const name of NAMES) {
    const repo = await w.makeRepo(path.join(w.root, name));
    await w.git(repo, 'branch', TARGET, 'main');
    const dir = path.join(w.root, `${name}-target`);
    await w.git(repo, 'worktree', 'add', '-q', dir, TARGET);
    repos[name] = repo;
    targets[name] = dir;
  }
  const bus = new HubBus();
  const todos = new TodoService({ store: w.store, bus });
  const source = await w.store.sessions.create({ name: 'source', claudeSessionId: 'c-source', status: 'idle', cwd: w.root, root: w.root, rootKind: 'workspace', solutions: [...NAMES], worktrees: false, workType: 'feature', mode: 'single', phase: 'ui-first' });
  const errors: unknown[] = [];
  let runs = 0;
  const env: PlanEnvironment = {
    async repos(_source, names) {
      const wanted = names === null || names.length === 0 ? [...NAMES] : names;
      return { kind: 'workspace', repos: wanted.map((name) => ({ name, repoPath: repos[name] as string })) };
    },
    async run(input) {
      runs += 1;
      const session = await w.store.sessions.create({ name: `run-${runs}`, claudeSessionId: `c-${runs}`, status: 'run', cwd: w.root, root: w.root, rootKind: 'workspace', solutions: [...NAMES], worktrees: true });
      for (const name of NAMES) {
        const dir = path.join(w.root, 'wt', name, input.branch);
        await w.git(repos[name] as string, 'worktree', 'add', '-q', '-b', input.branch, dir, input.from?.[name] ?? TARGET);
        await w.store.worktrees.create({ repo: name, repoPath: repos[name] as string, branch: input.branch, path: dir, sessionId: session.id });
      }
      return { ok: true, sessionId: session.id, branch: input.branch };
    },
    async usageHeld() {
      return null;
    },
    async send() {},
    async notice() {},
    async mergeNotice() {},
    async closeMergeNotice() {},
  };
  const make = (): PlanService => new PlanService({ dataDir: w.root, store: w.store, bus, todos, git: new PlanGit({ gh: fakeGhCommand(), env: w.env }), merger: new BranchMergeGit({ gh: fakeGhCommand(), env: w.env }), env, stoppedGraceMs: 100, onError: (error) => errors.push(error) });
  const partial = { w, repos, targets, bus, todos, errors, sourceId: source.id, plans: make() } as Rig;
  await partial.plans.start();
  partial.restart = async () => {
    await partial.plans.close();
    partial.plans = make();
    await partial.plans.start();
    await settle(partial);
  };
  rig = partial;
  return partial;
}

async function settle(r: Rig): Promise<void> {
  for (let round = 0; round < 3; round += 1) await r.plans.idle();
}

async function status(r: Rig, sessionId: string, next: SessionStatus): Promise<void> {
  await r.w.store.sessions.update(sessionId, { status: next });
  r.bus.publish('sessionUpdated', { ...(await r.w.store.sessions.get(sessionId)), id: sessionId, status: next } as unknown as Session);
  await settle(r);
}

/** A one-item plan over both repos, started in `agents` mode; answers the plan id and the running item. */
async function started(r: Rig) {
  const plan = await r.plans.create({ sourceSessionId: r.sourceId, title: 'PROJ-10 Acme epic', targetBranch: TARGET });
  await r.plans.addItem(plan.id, { key: 'PROJ-1', todo: { title: 'Item A', estimateMinutes: 30 } });
  await r.plans.startPlan(plan.id, { mergeMode: 'agents', allowProtectedTarget: true });
  await settle(r);
  const item = (await r.plans.get(plan.id)).items[0];
  if (!item || item.state !== 'running') throw new Error('the item did not start');
  return { planId: plan.id, item };
}

/** The item's agent commits in acme-front only, merges it into the target, and that worktree is removed (the branch is kept). */
async function mergedThenRemoved(r: Rig, branch: string, sessionId: string): Promise<void> {
  const dir = path.join(r.w.root, 'wt', 'acme-front', branch);
  await r.w.commit(dir, 'a.txt', 'a\n', 'PROJ-1 work');
  await r.w.git(r.targets['acme-front'] as string, 'merge', '-q', '--no-edit', branch);
  await r.w.git(r.repos['acme-front'] as string, 'worktree', 'remove', dir);
  const record = (await r.w.store.worktrees.list({ sessionId })).find((entry) => entry.repo === 'acme-front');
  await r.w.store.worktrees.markRemoved(record?.id as string);
}

describe('D148 · a removed worktree still counts for the merge', () => {
  it('the regression: work merged in one repo, its worktree removed, no commits in the other → done when the turn ends', async () => {
    const r = await setup();
    const { planId, item } = await started(r);
    await mergedThenRemoved(r, item.branch as string, item.runSessionId as string);
    await r.todos.update(r.sourceId, item.todoId, { state: 'done' }, 'agent');
    await status(r, item.runSessionId as string, 'done');
    const after = (await r.plans.get(planId)).items[0];
    expect(after?.state).toBe('done');
    expect((await r.plans.get(planId)).state).toBe('done');
    expect(r.errors).toEqual([]);
  });

  it('an item already stuck that way is done at the next activation (a restart)', async () => {
    const r = await setup();
    const { planId, item } = await started(r);
    await mergedThenRemoved(r, item.branch as string, item.runSessionId as string);
    // As on the developer's install: its todo done and its turn over while the old version read no work (it stayed running).
    await r.todos.update(r.sourceId, item.todoId, { state: 'done' }, 'agent');
    await r.w.store.sessions.update(item.runSessionId as string, { status: 'done' });
    await r.restart();
    expect((await r.plans.get(planId)).items[0]?.state).toBe('done');
    expect(r.errors).toEqual([]);
  });

  it('a removed worktree with work not merged keeps the item running (never a false done)', async () => {
    const r = await setup();
    const { planId, item } = await started(r);
    const dir = path.join(r.w.root, 'wt', 'acme-front', item.branch as string);
    await r.w.commit(dir, 'a.txt', 'a\n', 'PROJ-1 work');
    await r.w.git(r.repos['acme-front'] as string, 'worktree', 'remove', dir);
    const record = (await r.w.store.worktrees.list({ sessionId: item.runSessionId as string })).find((entry) => entry.repo === 'acme-front');
    await r.w.store.worktrees.markRemoved(record?.id as string);
    await status(r, item.runSessionId as string, 'idle');
    const after = (await r.plans.get(planId)).items[0];
    expect(after?.storedState).toBe('running');
    expect(r.errors).toEqual([]);
  });
});
