/**
 * D121 · Plans: a fresh item branch is never "merged"; falsely done items are reopened. The plan
 * core is real (store, TodoService, PlanService) over real temp git repos (`makeGitWorld`, the
 * real {@link PlanGit} and {@link BranchMergeGit}, fake gh); the run environment makes the item's
 * worktree the way a run does (cut from the target).
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import type { SessionStatus } from '../../../src/core/model.ts';
import { PLANS_SETTING, type Plan } from '../../../src/core/plans.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { PlanGit, type PlanGitPort, type PlanRepoInput, type PlanRepoState } from '../../../src/server/plans/git.ts';
import { type PlanEnvironment, PlanError, PlanService } from '../../../src/server/plans/service.ts';
import { TodoService } from '../../../src/server/todos/service.ts';
import { BranchMergeGit } from '../../../src/server/worktrees/branch-merge.ts';
import { fakeGhCommand } from '../../../tools/fake-gh/command.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';

const TARGET = 'feature/PROJ-10-acme-epic';

/**
 * The real git, or (while `lie` is on) the rule before D121 as the bug showed it: every branch
 * whose tip differs from the recorded cut and is in the target counts as merged. Used to seed
 * the old falsely done state through the real scheduling path.
 */
class SwitchGit implements PlanGitPort {
  lie = false;
  readonly real: PlanGit;
  readonly world: GitWorld;
  constructor(real: PlanGit, world: GitWorld) {
    this.real = real;
    this.world = world;
  }
  prepareTarget(repoPath: string, target: string, base: string) {
    return this.real.prepareTarget(repoPath, target, base);
  }
  targetFacts(repoPath: string, target: string) {
    return this.real.targetFacts(repoPath, target);
  }
  tip(repoPath: string, ref: string) {
    return this.real.tip(repoPath, ref);
  }
  async inspect(input: PlanRepoInput, options?: { conflicts?: boolean }): Promise<PlanRepoState> {
    const state = await this.real.inspect(input, options);
    if (!this.lie) return state;
    const tip = await this.real.tip(input.repoPath, `refs/heads/${input.branch}`);
    const inTarget = tip !== null && (await this.world.git(input.repoPath, 'merge-base', '--is-ancestor', tip, input.target).then(() => true, () => false));
    const old = tip !== null && input.cut !== null && tip !== input.cut && inTarget;
    return { ...state, hasWork: old || state.hasWork, merged: old || state.merged, unknown: false };
  }
}

interface Rig {
  readonly w: GitWorld;
  readonly repo: string;
  /** The checkout the target branch is on. */
  readonly targetDir: string;
  readonly bus: HubBus;
  readonly git: SwitchGit;
  readonly todos: TodoService;
  readonly notices: Array<{ kind: string; title: string; detail: string; dedupe: string }>;
  readonly errors: unknown[];
  /** Runs before an item's worktree is cut (another item's merge lands on the target in between). */
  beforeCut: (() => Promise<void>) | null;
  plans: PlanService;
  sourceId: string;
  /** A new PlanService over the same data (a restart: activation). */
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
  const repo = await w.makeRepo(path.join(w.root, 'acme-front'));
  await w.git(repo, 'branch', TARGET, 'main');
  const targetDir = path.join(w.root, 'target-checkout');
  await w.git(repo, 'worktree', 'add', '-q', targetDir, TARGET);
  const bus = new HubBus();
  const todos = new TodoService({ store: w.store, bus });
  await w.store.settings.set(PLANS_SETTING, true);
  const source = await w.store.sessions.create({ name: 'source', claudeSessionId: 'c-source', status: 'idle', cwd: w.root, root: w.root, rootKind: 'workspace', solutions: ['acme-front'], worktrees: false, workType: 'feature', mode: 'single', phase: 'ui-first' });
  const git = new SwitchGit(new PlanGit({ gh: fakeGhCommand(), env: w.env }), w);
  const partial = { w, repo, targetDir, bus, git, todos, notices: [], errors: [], beforeCut: null, sourceId: source.id } as unknown as Rig;
  let runs = 0;
  const env: PlanEnvironment = {
    async repos() {
      return { kind: 'workspace', repos: [{ name: 'acme-front', repoPath: repo }] };
    },
    async run(input) {
      runs += 1;
      if (partial.beforeCut) await partial.beforeCut();
      const session = await w.store.sessions.create({ name: `run-${runs}`, claudeSessionId: `c-${runs}`, status: 'run', cwd: w.root, root: w.root, rootKind: 'workspace', solutions: ['acme-front'], worktrees: true });
      const dir = path.join(w.root, 'wt', input.branch);
      await w.git(repo, 'worktree', 'add', '-q', '-b', input.branch, dir, input.from?.['acme-front'] ?? TARGET);
      await w.store.worktrees.create({ repo: 'acme-front', repoPath: repo, branch: input.branch, path: dir, sessionId: session.id });
      return { ok: true, sessionId: session.id, branch: input.branch };
    },
    async usageHeld() {
      return null;
    },
    async send() {},
    async notice(input) {
      partial.notices.push({ kind: input.kind, title: input.title, detail: input.detail, dedupe: input.dedupe });
    },
    async mergeNotice() {},
    async closeMergeNotice() {},
  };
  const make = (): PlanService => new PlanService({ dataDir: w.root, store: w.store, bus, todos, git, merger: new BranchMergeGit({ gh: fakeGhCommand(), env: w.env }), env, stoppedGraceMs: 100, onError: (error) => partial.errors.push(error) });
  partial.plans = make();
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

async function item(r: Rig, planId: string, key: string) {
  const found = (await r.plans.get(planId)).items.find((entry) => entry.key === key);
  if (!found) throw new Error(`no item ${key}`);
  return found;
}

/** A plan A (PROJ-1) → B (PROJ-2), started in `mode`. */
async function chain(r: Rig, mode: 'agents' | 'developer' = 'agents'): Promise<Plan> {
  const plan = await r.plans.create({ sourceSessionId: r.sourceId, title: 'PROJ-10 Acme epic', targetBranch: TARGET });
  await r.plans.addItem(plan.id, { key: 'PROJ-1', todo: { title: 'Item A', estimateMinutes: 30 } });
  await r.plans.addItem(plan.id, { key: 'PROJ-2', todo: { title: 'Item B', estimateMinutes: 30 } });
  await r.plans.addEdge(plan.id, { from: 'PROJ-1', to: 'PROJ-2' });
  await r.plans.startPlan(plan.id, { mergeMode: mode, allowProtectedTarget: true });
  await settle(r);
  return r.plans.get(plan.id);
}

async function todoState(r: Rig, todoId: string): Promise<string | undefined> {
  return (await r.w.store.todos.get(todoId))?.state;
}

/** Seeds the bug: A is read with the old rule (its fresh branch, the target moved), done; B starts on it. */
async function falselyDone(r: Rig): Promise<{ plan: Plan; a: Plan['items'][number] }> {
  r.beforeCut = async () => {
    r.beforeCut = null;
    await r.w.commit(r.targetDir, 'other.txt', 'other\n', 'PROJ-9 other work');
  };
  const plan = await chain(r);
  r.git.lie = true;
  const running = await item(r, plan.id, 'PROJ-1');
  await status(r, running.runSessionId as string, 'idle');
  const a = await item(r, plan.id, 'PROJ-1');
  expect(a.state).toBe('done');
  expect(await todoState(r, a.todoId)).toBe('done');
  expect((await item(r, plan.id, 'PROJ-2')).state).toBe('running');
  r.git.lie = false;
  return { plan, a };
}

describe('D121 · the poll right after a run starts', () => {
  it('the regression: the target moved before the worktree was cut → the fresh item stays running', async () => {
    const r = await setup();
    // Another item's merge lands on the target between the recorded cut and the worktree's cut.
    r.beforeCut = async () => {
      r.beforeCut = null;
      await r.w.commit(r.targetDir, 'other.txt', 'other\n', 'PROJ-9 other work');
    };
    const plan = await chain(r);
    const a = await item(r, plan.id, 'PROJ-1');
    expect(a.state).toBe('running');
    // Its first turn ends (the poll looks at git): no commit of its own, so nothing is merged.
    await status(r, a.runSessionId as string, 'idle');
    await status(r, a.runSessionId as string, 'run');
    const after = await item(r, plan.id, 'PROJ-1');
    expect(after.storedState).toBe('running');
    expect(after.note).toBeNull();
    expect(await todoState(r, a.todoId)).not.toBe('done');
    expect((await item(r, plan.id, 'PROJ-2')).state).toBe('waiting');
    expect(r.errors).toEqual([]);
  });

  it('its own commit merged into the target → done, and B starts', async () => {
    const r = await setup();
    const plan = await chain(r);
    const a = await item(r, plan.id, 'PROJ-1');
    const dir = path.join(r.w.root, 'wt', a.branch as string);
    await r.w.commit(dir, 'a.txt', 'a\n', 'PROJ-1 work');
    await r.w.git(r.targetDir, 'merge', '-q', '--no-edit', a.branch as string);
    await status(r, a.runSessionId as string, 'idle');
    expect((await item(r, plan.id, 'PROJ-1')).state).toBe('done');
    expect((await item(r, plan.id, 'PROJ-2')).state).toBe('running');
  });
});

describe('D121 · auto-repair of falsely done items', () => {
  it('reopens a falsely done item at activation: running, todo open, times cleared, the early dependent flagged, one Inbox item; idempotent', async () => {
    const r = await setup();
    const { plan, a } = await falselyDone(r);
    // Its agent kept working (as in the report).
    await r.w.store.sessions.update(a.runSessionId as string, { status: 'run' });
    await r.restart();
    const reopened = await item(r, plan.id, 'PROJ-1');
    expect(reopened.storedState).toBe('running');
    expect(reopened.state).toBe('running');
    expect(reopened.mergedAt).toBeNull();
    expect(reopened.doneAt).toBeNull();
    expect(reopened.note).toBe(`Reopened: it was marked merged but its branch isn't in ${TARGET}`);
    expect(await todoState(r, a.todoId)).toBe('in_progress');
    // B started while A was falsely done: flagged, not stopped.
    const b = await item(r, plan.id, 'PROJ-2');
    expect(b.state).toBe('running');
    expect(b.note).toBe('started before PROJ-1 was merged — its branch may lack that work');
    const reopenedNotices = r.notices.filter((notice) => notice.kind === 'plan-reopened');
    expect(reopenedNotices.map((notice) => notice.title)).toEqual([`Reopened PROJ-1: it was marked merged but its branch isn't in ${TARGET}`]);
    expect(reopenedNotices[0]?.detail).toContain('PROJ-2');
    // Idempotent: another cycle, another activation change nothing.
    r.plans.kick();
    await settle(r);
    await r.restart();
    expect(r.notices.filter((notice) => notice.kind === 'plan-reopened')).toHaveLength(1);
    expect((await item(r, plan.id, 'PROJ-2')).note).toBe('started before PROJ-1 was merged — its branch may lack that work');
    expect((await item(r, plan.id, 'PROJ-1')).storedState).toBe('running');
    expect(r.errors).toEqual([]);
  });

  it('when Plans is switched on again (activation without a restart); the paused plan is repaired too', async () => {
    const r = await setup();
    const { plan } = await falselyDone(r);
    await r.w.store.settings.set(PLANS_SETTING, false);
    await r.plans.switchChanged();
    await r.w.store.settings.set(PLANS_SETTING, true);
    await r.plans.switchChanged();
    await settle(r);
    expect((await r.plans.get(plan.id)).state).toBe('paused');
    expect((await item(r, plan.id, 'PROJ-1')).storedState).toBe('running');
  });

  it('with its run session closed it is stopped (D120), and stays so', async () => {
    const r = await setup();
    const { plan, a } = await falselyDone(r);
    await r.w.store.sessions.update(a.runSessionId as string, { closedAt: new Date().toISOString(), status: 'done' });
    await r.restart();
    const stopped = await item(r, plan.id, 'PROJ-1');
    expect(stopped.storedState).toBe('running');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await item(r, plan.id, 'PROJ-1')).state).toBe('stopped');
    expect((await item(r, plan.id, 'PROJ-1')).reason).toContain('its run session is closed');
    r.plans.kick();
    await settle(r);
    expect((await item(r, plan.id, 'PROJ-1')).state).toBe('stopped');
  });

  it('with its run session gone it is stopped (D120), not failed', async () => {
    const r = await setup();
    const { plan, a } = await falselyDone(r);
    await r.w.store.sessions.delete(a.runSessionId as string);
    await r.restart();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const stopped = await item(r, plan.id, 'PROJ-1');
    expect(stopped.storedState).toBe('running');
    expect(stopped.state).toBe('stopped');
  });

  it('merged only on the remote (origin/<target>; the local target behind) → not reopened', async () => {
    const r = await setup();
    const bare = await r.w.addOrigin(r.repo);
    await r.w.git(r.repo, 'push', '-q', 'origin', TARGET);
    await r.w.git(r.repo, 'fetch', '-q', 'origin');
    await r.w.setPullRequests({});
    const plan = await chain(r);
    const a = await item(r, plan.id, 'PROJ-1');
    const dir = path.join(r.w.root, 'wt', a.branch as string);
    await r.w.commit(dir, 'a.txt', 'a\n', 'PROJ-1 work');
    // Merged on GitHub (a second clone stands in): only origin/<target> has it.
    await r.w.git(r.repo, 'push', '-q', 'origin', a.branch as string);
    const other = path.join(r.w.root, 'other-clone');
    await r.w.git(r.w.root, 'clone', '-q', bare, other);
    await r.w.git(other, 'checkout', '-q', TARGET);
    await r.w.git(other, 'merge', '-q', '--no-edit', `origin/${a.branch}`);
    await r.w.git(other, 'push', '-q', 'origin', TARGET);
    await r.w.git(r.repo, 'fetch', '-q', 'origin');
    await status(r, a.runSessionId as string, 'idle');
    expect((await item(r, plan.id, 'PROJ-1')).state).toBe('done');
    await r.restart();
    expect((await item(r, plan.id, 'PROJ-1')).state).toBe('done');
    expect(r.notices.filter((notice) => notice.kind === 'plan-reopened')).toEqual([]);
  });

  it("never touches an item done by the developer's Mark done", async () => {
    const r = await setup();
    const plan = await chain(r);
    const a = await item(r, plan.id, 'PROJ-1');
    await r.plans.markItemDone(plan.id, a.id);
    await settle(r);
    await r.restart();
    expect((await item(r, plan.id, 'PROJ-1')).state).toBe('done');
    expect(r.notices.filter((notice) => notice.kind === 'plan-reopened')).toEqual([]);
  });
});

describe('D121 · manual Reopen', () => {
  it('reopens a done item like the repair (its dependent flagged), refuses an item that is not done and a finished plan', async () => {
    const r = await setup();
    const plan = await chain(r);
    const a = await item(r, plan.id, 'PROJ-1');
    await r.plans.markItemDone(plan.id, a.id);
    await settle(r);
    expect((await item(r, plan.id, 'PROJ-2')).state).toBe('running');
    const answer = await r.plans.reopenItem(plan.id, a.id);
    const reopened = answer.items.find((entry) => entry.id === a.id);
    expect(reopened).toMatchObject({ storedState: 'running', state: 'running', doneAt: null, mergedAt: null, note: 'Reopened: reopened by you' });
    expect(await todoState(r, a.todoId)).toBe('in_progress');
    expect(answer.items.find((entry) => entry.key === 'PROJ-2')?.note).toBe('started before PROJ-1 was merged — its branch may lack that work');
    expect(r.notices.filter((notice) => notice.kind === 'plan-reopened').map((notice) => notice.title)).toEqual(['Reopened PROJ-1 (PROJ-10 Acme epic)']);
    await expect(r.plans.reopenItem(plan.id, a.id)).rejects.toMatchObject({ status: 409, code: 'not-done' });
    await r.plans.cancel(plan.id);
    await expect(r.plans.reopenItem(plan.id, a.id)).rejects.toBeInstanceOf(PlanError);
  });
});
